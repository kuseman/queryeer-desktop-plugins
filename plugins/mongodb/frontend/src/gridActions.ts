// Result grid actions for MongoDB query files, through the host's table context menu (`tableOutputContextMenu`):
// filter the query bar by a cell's value, and copy cells or whole documents as Extended JSON.
import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { Column } from "@queryeer/api/queryengine/OutputExtension";
import type { TableOutputContextMenuContext, TableOutputContextMenuItem } from "@queryeer/api/queryengine/TableOutputContextMenuExtension";
import { readSelectedDatabase, resolveConnection } from "./binding.js";
import { parseConnections } from "./connections.js";
import { ACTION_DOCUMENTS, CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, ENGINE_ID, PLUGIN_ID, QUERY_BAR_STATE_KEY } from "./constants.js";
import { fieldsOf, subscribeExplorer } from "./MongoExplorer.js";
import {
  filterSummary,
  guessCollection,
  isOwned,
  listItem,
  operatorsFor,
  readStored,
  textFor,
  withFilter,
  type BarState,
  type Condition,
  type StoredBar,
  type ValueType
} from "./queryBarModel.js";
import { writeToFile } from "./queryFiles.js";

/** The column the backend adds for keys that first appear after the first batch, holding them as one JSON document per row. */
export const EXTRA_COLUMN = "$extra";

/** A grid cell read back into a MongoDB value. */
export type CellValue =
  | { kind: "scalar"; type: Exclude<ValueType, "document" | "null">; text: string }
  | { kind: "null" }
  /** An embedded document or array, as relaxed Extended JSON text. */
  | { kind: "json"; json: string }
  /** Over the host's inline limit: plugins only get a preview, so the value is not usable. */
  | { kind: "large" };

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SAMPLE_WAIT_MS = 3000;

/**
 * Reads a cell back into a typed value. The grid's column types cover numbers, decimals, dates, booleans, documents and arrays.
 * ObjectIds arrive as hex text in a text column, so the field sample decides: a 24-hex value in a field sampled as ObjectId is one.
 * Columns of mixed type ("any") use the sample the same way for dates and embedded documents.
 */
export function readCell(column: Column, cell: unknown, sampledTypes: readonly string[] = []): CellValue {
  if (cell === null || cell === undefined) {
    return { kind: "null" };
  }
  if (typeof cell === "object") {
    return (cell as { kind?: unknown }).kind === "largeValue" ? { kind: "large" } : { kind: "json", json: JSON.stringify(cell) };
  }
  if (column.name === EXTRA_COLUMN || column.type === "object" || column.type === "array") {
    return { kind: "json", json: String(cell) };
  }
  if (typeof cell === "boolean") {
    return { kind: "scalar", type: "boolean", text: String(cell) };
  }
  if (typeof cell === "number") {
    return { kind: "scalar", type: column.type === "decimal" ? "decimal" : "number", text: String(cell) };
  }
  const text = String(cell);
  if (column.type === "decimal") {
    return { kind: "scalar", type: "decimal", text };
  }
  if (column.type === "datetime" || column.type === "datetimeoffset" || (column.type === "any" && sampledTypes.includes("date") && ISO_DATE.test(text))) {
    const time = Date.parse(text);
    if (!Number.isNaN(time)) {
      return { kind: "scalar", type: "date", text: new Date(time).toISOString() };
    }
  }
  if (sampledTypes.includes("objectId") && OBJECT_ID.test(text)) {
    return { kind: "scalar", type: "objectId", text: text.toLowerCase() };
  }
  if (column.type === "any" && (sampledTypes.includes("object") || sampledTypes.includes("array")) && /^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return { kind: "json", json: text };
    } catch {
      // plain text that starts with a bracket
    }
  }
  return { kind: "scalar", type: "string", text };
}

/** The value as Extended JSON (relaxed), ready for JSON.stringify; undefined for a large value. */
export function extendedJson(value: CellValue): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "large":
      return undefined;
    case "json":
      return JSON.parse(value.json);
    case "scalar":
      switch (value.type) {
        case "string":
          return value.text;
        case "boolean":
          return value.text === "true";
        case "number": {
          const number = Number(value.text);
          return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : { $numberLong: value.text };
        }
        case "decimal":
          return { $numberDecimal: value.text };
        case "date":
          return { $date: value.text };
        case "objectId":
          return { $oid: value.text };
      }
  }
}

/**
 * The filter condition matching (or, with `exclude`, excluding) a field's selected values: = / ≠ for one value, is one of / is none of
 * for several. Undefined when the values cannot be one condition: documents, arrays, large values, or a mix of types.
 */
export function conditionFor(field: string, values: readonly CellValue[], exclude: boolean): Condition | undefined {
  if (field === "" || field === EXTRA_COLUMN || values.length === 0) {
    return undefined;
  }
  if (values.every((value) => value.kind === "null")) {
    return { field, op: exclude ? "ne" : "eq", type: "null", value: "" };
  }
  const scalars = values.filter((value): value is Extract<CellValue, { kind: "scalar" }> => value.kind === "scalar");
  if (scalars.length !== values.length || new Set(scalars.map((value) => value.type)).size !== 1) {
    return undefined;
  }
  const type = scalars[0].type;
  const texts = [...new Set(scalars.map((value) => value.text))];
  if (texts.length === 1) {
    return { field, op: exclude ? "ne" : "eq", type, value: texts[0] };
  }
  const op = exclude ? "nin" : "in";
  return operatorsFor(type).includes(op) ? { field, op, type, value: texts.map(listItem).join(", ") } : undefined;
}

/**
 * A row rebuilt from its cells, for results that cannot be fetched again by `_id` (e.g. an aggregation's output). Null cells are left out,
 * since the grid shows a missing field as null too, and the keys in the extra column are merged in.
 */
export function documentFromCells(columns: readonly Column[], cells: readonly unknown[], sampledTypes: (field: string) => readonly string[]): Record<string, unknown> | undefined {
  const document: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    const value = readCell(column, cells[index], sampledTypes(column.name));
    if (value.kind === "large") {
      return undefined;
    }
    if (value.kind === "null") {
      continue;
    }
    const json = extendedJson(value);
    if (column.name === EXTRA_COLUMN && json !== null && typeof json === "object" && !Array.isArray(json)) {
      Object.assign(document, json);
    } else {
      document[column.name] = json;
    }
  }
  return document;
}

type Target = {
  connectionId: string;
  database: string;
  /** The collection the results come from, when known: the query bar's, or the one the editor's command names. */
  collection: string;
  /** The query bar's state, when it is in control of this tab's text. */
  bar?: StoredBar;
};

/** Registers the MongoDB items in the result grid's context menu. */
export function registerGridActions(context: PluginContext): Disposable {
  return context.tableOutputContextMenu.registerProvider({
    id: `${PLUGIN_ID}.grid`,
    getItems: (menu) => itemsFor(context, menu)
  });
}

export async function itemsFor(context: PluginContext, menu: TableOutputContextMenuContext): Promise<TableOutputContextMenuItem[]> {
  const { fileId, selection } = menu;
  if (menu.engineId !== ENGINE_ID || !fileId || !selection.hasSelection) {
    return [];
  }
  const target = targetOf(context, fileId);
  if (!target) {
    return [];
  }
  const sampled = target.collection ? await sampledTypes(context, target) : new Map<string, string[]>();
  const typesOf = (field: string): readonly string[] => sampled.get(field) ?? [];
  const rawCell = (rowIndex: number, columnIndex: number, fallback: unknown): unknown => {
    const row = menu.cellValuesByRow?.[rowIndex];
    return row ? row[columnIndex] : fallback;
  };

  // Selected values per column, in column order
  const byColumn = new Map<number, CellValue[]>();
  for (const cell of selection.selectedCells) {
    const column = menu.columns[cell.columnIndex];
    if (column) {
      const values = byColumn.get(cell.columnIndex) ?? [];
      values.push(readCell(column, rawCell(cell.rowIndex, cell.columnIndex, cell.value), typesOf(column.name)));
      byColumn.set(cell.columnIndex, values);
    }
  }

  const items: TableOutputContextMenuItem[] = [];
  if (target.bar) {
    const bar = target.bar;
    const conditions = [...byColumn].map(([columnIndex, values]) => conditionFor(menu.columns[columnIndex].name, values, false));
    if (conditions.length > 0 && conditions.every((condition) => condition !== undefined) && canNarrow(bar.state)) {
      const added = conditions as Condition[];
      items.push({
        id: `${PLUGIN_ID}.grid.filter`,
        label: `Filter: ${filterSummary({ combine: "and", conditions: added })}`,
        order: 10,
        run: () => applyConditions(context, fileId, bar, added)
      });
    }
    if (byColumn.size === 1) {
      const [[columnIndex, values]] = [...byColumn];
      const excluded = conditionFor(menu.columns[columnIndex].name, values, true);
      if (excluded && canNarrow(bar.state)) {
        items.push({
          id: `${PLUGIN_ID}.grid.exclude`,
          label: `Exclude: ${filterSummary({ combine: "and", conditions: [excluded] })}`,
          order: 11,
          run: () => applyConditions(context, fileId, bar, [excluded])
        });
      }
    }
  }

  if (selection.selectedCells.length === 1) {
    const [only] = [...byColumn.values()];
    const value = only?.[0];
    if (value && value.kind !== "large") {
      items.push({
        id: `${PLUGIN_ID}.grid.copyValue`,
        label: "Copy value as Extended JSON",
        order: 20,
        // Embedded documents are copied as the server wrote them, so long integers keep every digit
        run: () => copy(context, value.kind === "json" ? value.json : JSON.stringify(extendedJson(value)))
      });
    }
  }

  const rows = [...selection.selectedRowIndexes].sort((a, b) => a - b);
  if (rows.length > 0) {
    const idColumn = menu.columns.findIndex((column) => column.name === "_id");
    const ids = idColumn < 0 || !target.collection ? undefined
      : rows.map((row) => readCell(menu.columns[idColumn], menu.cellValuesByRow?.[row]?.[idColumn], typesOf("_id")));
    const fetchable = ids !== undefined && ids.every((id) => id.kind === "scalar" || id.kind === "json");
    const fromCells = rows.map((row) => {
      const cells = menu.cellValuesByRow?.[row];
      return cells ? documentFromCells(menu.columns, cells, typesOf) : undefined;
    });
    if (fetchable || fromCells.every((document) => document !== undefined)) {
      items.push({
        id: `${PLUGIN_ID}.grid.copyDocuments`,
        label: rows.length === 1 ? "Copy document as Extended JSON" : `Copy ${rows.length} documents as Extended JSON`,
        order: 21,
        run: async () => {
          const fetched = fetchable ? await fetchDocuments(context, target, ids.map(extendedJson)) : undefined;
          const texts = fetched ?? fromCells.map((document) => JSON.stringify(document, null, 2));
          await copy(context, texts.length === 1 ? texts[0] : `[\n${texts.join(",\n")}\n]`);
        }
      });
    }
  }
  return items;
}

/** Conditions are added with AND; a filter matching any of several conditions cannot take one more without changing its meaning. */
function canNarrow(state: BarState): boolean {
  return state.collection !== "" && (state.filter.combine === "and" || state.filter.conditions.length <= 1);
}

function targetOf(context: PluginContext, fileId: string): Target | undefined {
  const file = context.files.getFile(fileId);
  const connection = resolveConnection(file, parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)));
  if (!connection) {
    return undefined;
  }
  const selected = readSelectedDatabase(context.files.getEditorState(fileId, DATABASE_STATE_KEY));
  const database = (selected?.connectionId === connection.connectionId ? selected.database : "") || connection.defaultDatabase || "";
  const editor = context.editors.getActiveEditor();
  const text = editor?.fileId === fileId ? editor.content?.getContent() : undefined;
  const stored = readStored(context.files.getEditorState(fileId, QUERY_BAR_STATE_KEY));
  // Only when the bar wrote what the editor holds: otherwise a filter from the grid would overwrite hand edits
  const bar = text !== undefined && stored !== undefined && stored.state.collection !== "" && isOwned(text, stored) ? stored : undefined;
  return { connectionId: connection.connectionId, database, collection: bar?.state.collection ?? guessCollection(text ?? ""), bar };
}

/** The collection's sampled field types, waiting briefly for a sample still loading (the query bar has usually loaded it already). */
function sampledTypes(context: PluginContext, target: Target): Promise<Map<string, string[]>> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (types: Map<string, string[]>): void => {
      if (!settled) {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(types);
      }
    };
    const check = (): void => {
      if (!target.database) {
        finish(new Map());
        return;
      }
      const fields = fieldsOf(context, target.connectionId, target.database, target.collection);
      if (fields.status === "loaded") {
        finish(new Map(fields.items.map((field) => [field.name, field.types])));
      } else if (fields.status === "error") {
        finish(new Map());
      }
    };
    const timer = setTimeout(() => finish(new Map()), SAMPLE_WAIT_MS);
    unsubscribe = subscribeExplorer(check);
    check();
  });
}

async function applyConditions(context: PluginContext, fileId: string, bar: StoredBar, conditions: Condition[]): Promise<void> {
  const existing = bar.state.filter.conditions;
  const same = (a: Condition, b: Condition): boolean => a.field === b.field && a.op === b.op && a.type === b.type && a.value === b.value;
  const added = conditions.filter((condition) => !existing.some((other) => same(condition, other)));
  const next = withFilter(bar.state, { combine: "and", conditions: [...existing, ...added] });
  const text = textFor(next);
  context.files.setEditorState(fileId, QUERY_BAR_STATE_KEY, { state: next, written: text } satisfies StoredBar);
  if (!(await writeToFile(context, fileId, text, true))) {
    context.files.setEditorState(fileId, QUERY_BAR_STATE_KEY, bar);
    context.notifications.notify({ title: "MongoDB", message: "Click into the query's editor tab, then try again.", severity: "warning" });
  }
}

/** Whole documents from the server, or undefined when they cannot be fetched (e.g. the results came from a view's pipeline). */
async function fetchDocuments(context: PluginContext, target: Target, ids: unknown[]): Promise<string[] | undefined> {
  try {
    const documents = await context.queryEngines.invoke<string[]>({
      engineId: ENGINE_ID,
      action: ACTION_DOCUMENTS,
      payload: { connectionId: target.connectionId, database: target.database, collection: target.collection, ids: JSON.stringify(ids) }
    }, { silent: true });
    return Array.isArray(documents) && documents.length === ids.length ? documents : undefined;
  } catch {
    return undefined;
  }
}

async function copy(context: PluginContext, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    context.notifications.notify({ title: "MongoDB", message: `Could not copy: ${error instanceof Error ? error.message : String(error)}`, severity: "error" });
  }
}
