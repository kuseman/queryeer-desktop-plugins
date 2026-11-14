// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { Column } from "@queryeer/api/queryengine/OutputExtension";
import type { TableOutputContextMenuContext } from "@queryeer/api/queryengine/TableOutputContextMenuExtension";
import { ACTION_DOCUMENTS, ACTION_FIELDS, CONNECTIONS_SETTING_ID, QUERY_BAR_STATE_KEY } from "./constants.js";
import { clearExplorerCache } from "./MongoExplorer.js";
import { conditionFor, documentFromCells, extendedJson, itemsFor, readCell, type CellValue } from "./gridActions.js";
import { initialState, textFor, withFilter, type StoredBar } from "./queryBarModel.js";

const col = (name: string, type: Column["type"]): Column => ({ name, type });
const scalar = (type: Extract<CellValue, { kind: "scalar" }>["type"], text: string): CellValue => ({ kind: "scalar", type, text });

describe("reading grid cells", () => {
  it("types cells from the column and the field sample", () => {
    expect(readCell(col("status", "string"), "paid")).toEqual(scalar("string", "paid"));
    expect(readCell(col("_id", "string"), "65A000000000000000000001", ["objectId"])).toEqual(scalar("objectId", "65a000000000000000000001"));
    expect(readCell(col("code", "string"), "65a000000000000000000001", ["string"]), "hex text in a text field stays text")
      .toEqual(scalar("string", "65a000000000000000000001"));
    expect(readCell(col("qty", "int"), 3)).toEqual(scalar("number", "3"));
    expect(readCell(col("total", "decimal"), 12.5)).toEqual(scalar("decimal", "12.5"));
    expect(readCell(col("total", "decimal"), "12.50")).toEqual(scalar("decimal", "12.50"));
    expect(readCell(col("at", "datetimeoffset"), "2026-11-14T08:30:00Z")).toEqual(scalar("date", "2026-11-14T08:30:00.000Z"));
    expect(readCell(col("at", "any"), "2026-11-14T08:30:00Z", ["date", "string"])).toEqual(scalar("date", "2026-11-14T08:30:00.000Z"));
    expect(readCell(col("express", "boolean"), false)).toEqual(scalar("boolean", "false"));
    expect(readCell(col("note", "string"), null)).toEqual({ kind: "null" });
    expect(readCell(col("customer", "object"), "{\"name\": \"A\"}")).toEqual({ kind: "json", json: "{\"name\": \"A\"}" });
    expect(readCell(col("payload", "any"), "{\"a\": 1}", ["object", "string"])).toEqual({ kind: "json", json: "{\"a\": 1}" });
    expect(readCell(col("payload", "any"), "{not json", ["object", "string"])).toEqual(scalar("string", "{not json"));
    expect(readCell(col("big", "object"), { kind: "largeValue", logicalType: "json", byteLength: 99999, preview: "{", ref: "r1" })).toEqual({ kind: "large" });
  });

  it("writes values as relaxed Extended JSON", () => {
    expect(extendedJson(scalar("objectId", "65a000000000000000000001"))).toEqual({ $oid: "65a000000000000000000001" });
    expect(extendedJson(scalar("date", "2026-11-14T08:30:00.000Z"))).toEqual({ $date: "2026-11-14T08:30:00.000Z" });
    expect(extendedJson(scalar("decimal", "12.50"))).toEqual({ $numberDecimal: "12.50" });
    expect(extendedJson(scalar("number", "1.5"))).toBe(1.5);
    expect(extendedJson(scalar("number", "9007199254740993"))).toEqual({ $numberLong: "9007199254740993" });
    expect(extendedJson(scalar("boolean", "true"))).toBe(true);
    expect(extendedJson({ kind: "null" })).toBeNull();
    expect(extendedJson({ kind: "json", json: "{\"a\": [1]}" })).toEqual({ a: [1] });
  });

  it("turns selected values into one condition", () => {
    expect(conditionFor("status", [scalar("string", "paid")], false)).toEqual({ field: "status", op: "eq", type: "string", value: "paid" });
    expect(conditionFor("status", [scalar("string", "paid")], true)?.op).toBe("ne");
    expect(conditionFor("status", [scalar("string", "new"), scalar("string", "a, b"), scalar("string", "new")], false))
      .toEqual({ field: "status", op: "in", type: "string", value: "new, \"a, b\"" });
    expect(conditionFor("qty", [scalar("number", "1"), scalar("number", "2")], true)).toEqual({ field: "qty", op: "nin", type: "number", value: "1, 2" });
    expect(conditionFor("note", [{ kind: "null" }], false)).toEqual({ field: "note", op: "eq", type: "null", value: "" });
    expect(conditionFor("express", [scalar("boolean", "true"), scalar("boolean", "false")], false), "no lists of booleans").toBeUndefined();
    expect(conditionFor("mixed", [scalar("string", "1"), scalar("number", "1")], false)).toBeUndefined();
    expect(conditionFor("customer", [{ kind: "json", json: "{}" }], false)).toBeUndefined();
    expect(conditionFor("$extra", [scalar("string", "x")], false)).toBeUndefined();
  });

  it("rebuilds a row, leaving out nulls and merging the extra column", () => {
    const columns = [col("_id", "string"), col("total", "decimal"), col("note", "string"), col("$extra", "object")];
    const types = (field: string) => (field === "_id" ? ["objectId"] : []);
    expect(documentFromCells(columns, ["65a000000000000000000001", "9.90", null, "{\"late\": true}"], types))
      .toEqual({ _id: { $oid: "65a000000000000000000001" }, total: { $numberDecimal: "9.90" }, late: true });
    expect(documentFromCells(columns, ["x", { kind: "largeValue", preview: "", ref: "r", byteLength: 1, logicalType: "text" }, null, null], types)).toBeUndefined();
  });
});

describe("grid context menu", () => {
  const editorState = new Map<string, unknown>();
  let text = "";
  const executeCommand = vi.fn(async () => ({ commandId: "x", executed: true }));
  const notify = vi.fn();
  const invoke = vi.fn(async ({ action, payload }: { action: string; payload: { ids?: string } }) => {
    if (action === ACTION_FIELDS) {
      return [
        { name: "_id", types: ["objectId"], count: 2, sampled: 2 },
        { name: "status", types: ["string"], count: 2, sampled: 2 }
      ];
    }
    if (action === ACTION_DOCUMENTS) {
      return (JSON.parse(payload.ids ?? "[]") as Array<{ $oid: string }>).map((id) => `{\n  "_id": {"$oid": "${id.$oid}"},\n  "status": "paid"\n}`);
    }
    return [];
  });
  const writeText = vi.fn(async (_text: string) => {});

  const context = {
    files: {
      getFile: () => ({ fileId: "f1", engineBinding: { engineId: "mongodb", connectionId: "c1" } }),
      getEditorState: (_fileId: string, key: string) => editorState.get(key),
      setEditorState: (_fileId: string, key: string, value: unknown) => editorState.set(key, value)
    },
    settings: { getValue: (id: string) => (id === CONNECTIONS_SETTING_ID ? [{ connectionId: "c1", hosts: "localhost", defaultDatabase: "shop" }] : undefined) },
    editors: {
      getActiveEditor: () => ({ fileId: "f1", content: { getContent: () => text, setContent: (next: string) => (text = next) } })
    },
    commands: { executeCommand },
    notifications: { notify },
    queryEngines: { invoke }
  } as unknown as PluginContext;

  const columns = [col("_id", "string"), col("status", "string")];
  const rows: Record<number, unknown[]> = {
    0: ["65a000000000000000000001", "paid"],
    1: ["65a000000000000000000002", "new"]
  };
  const menu = (cells: Array<[number, number]>): TableOutputContextMenuContext => ({
    resultSetIndex: 0,
    columns,
    fileId: "f1",
    engineId: "mongodb",
    cellValuesByRow: rows,
    selection: {
      hasSelection: cells.length > 0,
      selectedCells: cells.map(([rowIndex, columnIndex]) => ({ rowIndex, columnIndex, value: rows[rowIndex][columnIndex] })),
      selectedRowIndexes: [...new Set(cells.map(([row]) => row))],
      selectedColumnIndexes: [...new Set(cells.map(([, column]) => column))],
      isSingleColumnSelection: new Set(cells.map(([, column]) => column)).size === 1,
      isSingleRowSelection: new Set(cells.map(([row]) => row)).size === 1
    }
  });
  const ownedBar = (state = initialState("orders")): void => {
    const stored: StoredBar = { state, written: textFor(state) };
    editorState.set(QUERY_BAR_STATE_KEY, stored);
    text = stored.written;
  };

  beforeEach(() => {
    clearExplorerCache();
    editorState.clear();
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    clearExplorerCache();
  });

  it("filters the query bar by a cell value and runs", async () => {
    ownedBar();
    const items = await itemsFor(context, menu([[0, 1]]));
    expect(items.map((item) => item.label)).toEqual([
      "Filter: status = \"paid\"",
      "Exclude: status ≠ paid",
      "Copy value as Extended JSON",
      "Copy document as Extended JSON"
    ]);
    await items[0].run();
    expect(JSON.parse(text).filter).toEqual({ status: "paid" });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect((editorState.get(QUERY_BAR_STATE_KEY) as StoredBar).written).toBe(text);
  });

  it("types an _id from the sample, and lists several values", async () => {
    ownedBar();
    const items = await itemsFor(context, menu([[0, 0], [1, 0]]));
    await items.find((item) => item.label.startsWith("Filter"))!.run();
    expect(JSON.parse(text).filter).toEqual({ _id: { $in: [{ $oid: "65a000000000000000000001" }, { $oid: "65a000000000000000000002" }] } });
  });

  it("adds to an AND filter but leaves an OR filter alone", async () => {
    const state = withFilter(initialState("orders"), { combine: "or", conditions: [
      { field: "status", op: "eq", type: "string", value: "new" },
      { field: "status", op: "eq", type: "string", value: "x" }
    ] });
    ownedBar(state);
    const labels = (await itemsFor(context, menu([[0, 1]]))).map((item) => item.label);
    expect(labels.some((label) => label.startsWith("Filter") || label.startsWith("Exclude"))).toBe(false);
  });

  it("offers no filter when the editor text was edited by hand", async () => {
    ownedBar();
    text = "{ \"find\": \"orders\", \"filter\": { \"hand\": 1 } }";
    const labels = (await itemsFor(context, menu([[0, 1]]))).map((item) => item.label);
    expect(labels).toEqual(["Copy value as Extended JSON", "Copy document as Extended JSON"]);
  });

  it("copies values and whole documents fetched by _id", async () => {
    ownedBar();
    const value = (await itemsFor(context, menu([[0, 0]]))).find((item) => item.label === "Copy value as Extended JSON")!;
    await value.run();
    expect(writeText).toHaveBeenLastCalledWith("{\"$oid\":\"65a000000000000000000001\"}");

    const documents = (await itemsFor(context, menu([[1, 1], [0, 1]]))).find((item) => item.label === "Copy 2 documents as Extended JSON")!;
    await documents.run();
    const copied = JSON.parse(writeText.mock.calls.at(-1)![0]) as Array<{ _id: { $oid: string } }>;
    expect(copied.map((document) => document._id.$oid)).toEqual(["65a000000000000000000001", "65a000000000000000000002"]);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ action: ACTION_DOCUMENTS }), { silent: true });
  });

  it("stays out of other engines' grids", async () => {
    ownedBar();
    expect(await itemsFor(context, { ...menu([[0, 1]]), engineId: "jdbc" })).toEqual([]);
  });
});
