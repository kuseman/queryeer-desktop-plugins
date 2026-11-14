// The query bar's state and the `find` it generates. The flow is one way: the bar writes the editor text, and never
// reads it back. When the editor no longer holds what the bar last wrote, the user has edited by hand and the bar
// steps aside until they take over again.

import { commandText } from "./queries.js";

export type SortKey = { field: string; direction: 1 | -1 };

/** Include mode shows only the listed fields; exclude mode shows everything but them. No fields means all fields. */
export type Projection = { mode: "include" | "exclude"; fields: string[] };

/** How a condition's value text is read. */
/** How a filter value is read. `document` marks a field sampled only as embedded documents, which can only be tested for presence. */
export type ValueType = "string" | "number" | "decimal" | "date" | "objectId" | "boolean" | "null" | "document";

export type Operator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin"
  | "contains" | "startsWith" | "regex" | "exists" | "missing";

/** One filter row. `value` is the text as typed; `type` says how to read it. Incomplete rows are kept but not written. */
export type Condition = { field: string; op: Operator; type: ValueType; value: string };

export type Filter = { combine: "and" | "or"; conditions: Condition[] };

export type BarState = {
  collection: string;
  filter: Filter;
  projection: Projection;
  sort: SortKey[];
  skip: number;
  /** 0 means no limit. */
  limit: number;
};

/** What is kept per file: the bar's state and the exact text it last wrote into the editor. */
export type StoredBar = { state: BarState; written: string };

export const DEFAULT_LIMIT = 50;
export const LIMIT_CHOICES: readonly number[] = [20, 50, 100, 500, 1000];

export function initialState(collection = ""): BarState {
  return { collection, filter: emptyFilter(), projection: { mode: "include", fields: [] }, sort: [], skip: 0, limit: DEFAULT_LIMIT };
}

function emptyFilter(): Filter {
  return { combine: "and", conditions: [] };
}

/** The `find` command for a state. Optional parts are left out when empty, so a fresh state equals the explorer's Browse. */
export function commandFor(state: BarState): Record<string, unknown> {
  const command: Record<string, unknown> = { find: state.collection, filter: filterFor(state.filter) };
  if (state.projection.fields.length > 0) {
    const value = state.projection.mode === "include" ? 1 : 0;
    const projection: Record<string, number> = Object.fromEntries(state.projection.fields.map((field) => [field, value]));
    // MongoDB returns _id even from an inclusion projection unless it is excluded explicitly
    if (state.projection.mode === "include" && !state.projection.fields.includes("_id")) {
      projection._id = 0;
    }
    command.projection = projection;
  }
  if (state.sort.length > 0) {
    command.sort = Object.fromEntries(state.sort.map((key) => [key.field, key.direction]));
  }
  if (state.skip > 0) {
    command.skip = state.skip;
  }
  if (state.limit > 0) {
    command.limit = state.limit;
  }
  return command;
}

/** The editor text for a state; empty when no collection is chosen yet. */
export function textFor(state: BarState): string {
  return state.collection ? commandText(commandFor(state)) : "";
}

/**
 * True when the bar still owns the editor: the editor is empty, or holds exactly what the bar last wrote
 * (line endings and trailing whitespace aside). Anything else means the text was edited by hand.
 */
export function isOwned(editorText: string, stored: StoredBar | undefined): boolean {
  if (!editorText.trim()) {
    return true;
  }
  return stored !== undefined && normalize(editorText) === normalize(stored.written);
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

/** Reads the stored bar from editor state, or undefined when it is missing or not in the expected shape. */
export function readStored(raw: unknown): StoredBar | undefined {
  if (!isRecord(raw) || typeof raw.written !== "string" || !isRecord(raw.state)) {
    return undefined;
  }
  const { collection, projection, sort, skip, limit } = raw.state;
  // Bars stored before the filter existed have none
  const filter = raw.state.filter === undefined ? emptyFilter() : readFilter(raw.state.filter);
  if (!filter) {
    return undefined;
  }
  if (typeof collection !== "string" || !isRecord(projection) || !Array.isArray(sort) || !isCount(skip) || !isCount(limit)) {
    return undefined;
  }
  if ((projection.mode !== "include" && projection.mode !== "exclude") || !Array.isArray(projection.fields)) {
    return undefined;
  }
  const fields = projection.fields.filter((field): field is string => typeof field === "string");
  const keys = sort.filter((key): key is SortKey => isRecord(key) && typeof key.field === "string" && (key.direction === 1 || key.direction === -1));
  return {
    state: { collection, filter, projection: { mode: projection.mode, fields }, sort: keys.map(({ field, direction }) => ({ field, direction })), skip, limit },
    written: raw.written
  };
}

function readFilter(raw: unknown): Filter | undefined {
  if (!isRecord(raw) || (raw.combine !== "and" && raw.combine !== "or") || !Array.isArray(raw.conditions)) {
    return undefined;
  }
  const conditions = raw.conditions.filter((c): c is Condition =>
    isRecord(c) && typeof c.field === "string" && typeof c.value === "string"
    && (OPERATORS as readonly unknown[]).includes(c.op) && (VALUE_TYPES as readonly unknown[]).includes(c.type));
  return { combine: raw.combine, conditions: conditions.map(({ field, op, type, value }) => ({ field, op, type, value })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// State changes used by the builders. Each returns a new state.

/** Switching collection starts over: filter, fields and sort belong to the old collection. The limit is kept. */
export function withCollection(state: BarState, collection: string): BarState {
  return { ...initialState(collection), limit: state.limit };
}

/**
 * Checks or unchecks a field. Checking a field unchecks its parent and its own fields (`payload` vs `payload.orderId`): MongoDB rejects
 * a projection naming both ("path collision").
 */
export function toggleProjectionField(state: BarState, field: string): BarState {
  const { fields } = state.projection;
  const overlaps = (other: string): boolean => other === field || other.startsWith(`${field}.`) || field.startsWith(`${other}.`);
  const next = fields.includes(field) ? fields.filter((f) => f !== field) : [...fields.filter((f) => !overlaps(f)), field];
  return { ...state, projection: { ...state.projection, fields: next } };
}

export function withProjectionMode(state: BarState, mode: Projection["mode"]): BarState {
  return { ...state, projection: { ...state.projection, mode } };
}

export function clearProjection(state: BarState): BarState {
  return { ...state, projection: { ...state.projection, fields: [] } };
}

export function addSortKey(state: BarState, field: string, direction: 1 | -1 = 1): BarState {
  return state.sort.some((key) => key.field === field) ? state : { ...state, sort: [...state.sort, { field, direction }], skip: 0 };
}

export function flipSortKey(state: BarState, field: string): BarState {
  return {
    ...state,
    sort: state.sort.map((key) => (key.field === field ? { field, direction: key.direction === 1 ? -1 : 1 } : key)),
    skip: 0
  };
}

export function removeSortKey(state: BarState, field: string): BarState {
  return { ...state, sort: state.sort.filter((key) => key.field !== field), skip: 0 };
}

/** Replaces the filter; a different filter means different results, so paging starts over. */
export function withFilter(state: BarState, filter: Filter): BarState {
  return { ...state, filter, skip: 0 };
}

export function withLimit(state: BarState, limit: number): BarState {
  return { ...state, limit, skip: 0 };
}

/** The next (+1) or previous (-1) page, or undefined when there is no limit to page by. */
export function page(state: BarState, direction: 1 | -1): BarState | undefined {
  if (state.limit <= 0) {
    return undefined;
  }
  return { ...state, skip: Math.max(0, state.skip + direction * state.limit) };
}

// Short texts for the bar's chips.

export function projectionSummary(projection: Projection): string {
  const count = projection.fields.length;
  if (count === 0) {
    return "all";
  }
  return projection.mode === "include" ? `${count} ${count === 1 ? "field" : "fields"}` : `all but ${count}`;
}

export function sortSummary(sort: readonly SortKey[]): string {
  return sort.length === 0 ? "none" : sort.map((key) => `${key.field} ${key.direction === 1 ? "↑" : "↓"}`).join(", ");
}

/** "51–100" for skip 50 and limit 50; "51–" without a limit. */
export function rangeLabel(state: BarState): string {
  const first = state.skip + 1;
  return state.limit > 0 ? `${first.toLocaleString()}–${(state.skip + state.limit).toLocaleString()}` : `${first.toLocaleString()}–`;
}

// The filter: rows of field · operator · typed value, combined with AND or OR.

export const VALUE_TYPES: readonly ValueType[] = ["string", "number", "decimal", "date", "objectId", "boolean", "null", "document"];
/** The value types offered in a row's type list; `document` comes only from the sample. */
export const CHOOSABLE_VALUE_TYPES: readonly ValueType[] = VALUE_TYPES.filter((type) => type !== "document");

export const VALUE_TYPE_LABELS: Record<ValueType, string> = {
  string: "text",
  number: "number",
  decimal: "decimal",
  date: "date",
  objectId: "ObjectId",
  boolean: "true/false",
  null: "null",
  document: "document"
};

export const OPERATORS: readonly Operator[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "startsWith", "regex", "exists", "missing"];

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "is one of",
  nin: "is none of",
  contains: "contains",
  startsWith: "starts with",
  regex: "matches regex",
  exists: "exists",
  missing: "is missing"
};

/** Operators that make sense for a value type. exists/missing take no value and fit every type. */
export function operatorsFor(type: ValueType): Operator[] {
  switch (type) {
    case "string":
      return ["eq", "ne", "contains", "startsWith", "regex", "in", "nin", "gt", "gte", "lt", "lte", "exists", "missing"];
    case "boolean":
    case "null":
      return ["eq", "ne", "exists", "missing"];
    case "document":
      // Comparing whole documents needs the exact field order; only presence is useful
      return ["exists", "missing"];
    default:
      return ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "exists", "missing"];
  }
}

export function takesValue(op: Operator): boolean {
  return op !== "exists" && op !== "missing";
}

const NUMERIC_TYPES = ["int", "long", "double"];

/**
 * The value type for a field, from the BSON types the sample found ($type names). Nulls are skipped in favour of a
 * real type, and a mix of int, long and double reads as a number. Unknown fields read as text.
 */
export function valueTypeFor(types: readonly string[]): ValueType {
  const real = types.filter((type) => type !== "null" && type !== "missing");
  if (real.length === 0) {
    return types.includes("null") ? "null" : "string";
  }
  if (real.every((type) => NUMERIC_TYPES.includes(type))) {
    return "number";
  }
  if (real.every((type) => type === "object")) {
    return "document";
  }
  switch (real[0]) {
    case "decimal":
      return "decimal";
    case "date":
      return "date";
    case "objectId":
      return "objectId";
    case "bool":
      return "boolean";
    case "int":
    case "long":
    case "double":
      return "number";
    default:
      return "string";
  }
}

/** A new row for a field, typed from its sampled types. */
export function newCondition(field: string, types: readonly string[] = []): Condition {
  const type = valueTypeFor(types);
  return { field, op: operatorsFor(type)[0], type, value: type === "boolean" ? "true" : "" };
}

/** Changing the type keeps the operator when it still applies, otherwise falls back to "=". */
export function withValueType(condition: Condition, type: ValueType): Condition {
  const op = operatorsFor(type).includes(condition.op) ? condition.op : operatorsFor(type)[0];
  const value = type === "boolean" ? (condition.value === "false" ? "false" : "true") : type === "null" ? "" : condition.value;
  return { ...condition, type, op, value };
}

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The value as Extended JSON, or an error message when the text does not fit the type. */
export function parseValue(type: ValueType, text: string): { value: unknown } | { error: string } {
  const trimmed = text.trim();
  switch (type) {
    case "string":
      return { value: text };
    case "null":
      return { value: null };
    case "boolean":
      return trimmed === "true" || trimmed === "false" ? { value: trimmed === "true" } : { error: "Use true or false" };
    case "number": {
      if (!NUMBER_PATTERN.test(trimmed)) {
        return { error: "Not a number" };
      }
      const number = Number(trimmed);
      // Whole numbers beyond what a double holds exactly keep every digit as a long
      if (/^[+-]?\d+$/.test(trimmed) && !Number.isSafeInteger(number)) {
        return { value: { $numberLong: trimmed.replace(/^\+/, "") } };
      }
      return { value: number };
    }
    case "decimal":
      return NUMBER_PATTERN.test(trimmed) ? { value: { $numberDecimal: trimmed.replace(/^\+/, "") } } : { error: "Not a number" };
    case "date": {
      // A bare date means midnight UTC, and a time without a zone is read as UTC too
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? `${trimmed}T00:00:00Z`
        : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed;
      const time = /^\d{4}-\d{2}-\d{2}T/.test(iso) ? Date.parse(iso) : NaN;
      return Number.isNaN(time) ? { error: "Use a date like 2026-11-14 or 2026-11-14T08:30:00Z" } : { value: { $date: new Date(time).toISOString() } };
    }
    case "document":
      return { error: "A document can only be tested with exists or is missing" };
    case "objectId":
      return /^[0-9a-fA-F]{24}$/.test(trimmed) ? { value: { $oid: trimmed.toLowerCase() } } : { error: "An ObjectId is 24 hex characters" };
  }
}

/** The query clause for one row (`{ field: ... }`), or an error message when the row is incomplete or invalid. */
export function clauseFor(condition: Condition): { clause: Record<string, unknown> } | { error: string } {
  const field = condition.field.trim();
  if (!field) {
    return { error: "Pick a field" };
  }
  const { op } = condition;
  if (op === "exists" || op === "missing") {
    return { clause: { [field]: { $exists: op === "exists" } } };
  }
  if (op === "contains" || op === "startsWith" || op === "regex") {
    if (!condition.value) {
      return { error: "Type some text" };
    }
    if (op === "regex" && !isValidRegex(condition.value)) {
      return { error: "Not a valid regular expression" };
    }
    const pattern = op === "regex" ? condition.value : `${op === "startsWith" ? "^" : ""}${escapeRegex(condition.value)}`;
    // contains ignores case, like a search box; starts with and regex are exact
    return { clause: { [field]: { $regex: pattern, $options: op === "contains" ? "i" : "" } } };
  }
  if (op === "in" || op === "nin") {
    const parts = (condition.type === "string" ? splitList(condition.value) : condition.value.split(",").map((part) => part.trim()))
      .filter((part) => part !== "");
    if (parts.length === 0) {
      return { error: "List one or more values, separated by commas" };
    }
    const values: unknown[] = [];
    for (const part of parts) {
      const parsed = parseValue(condition.type, part);
      if ("error" in parsed) {
        return { error: `${part}: ${parsed.error}` };
      }
      values.push(parsed.value);
    }
    return { clause: { [field]: { [`$${op}`]: values } } };
  }
  const parsed = parseValue(condition.type, condition.value);
  if ("error" in parsed) {
    return parsed;
  }
  return { clause: { [field]: op === "eq" ? parsed.value : { [`$${op}`]: parsed.value } } };
}

/**
 * The `filter` document. AND keeps one flat document when it can: one key per field, with several operators on the
 * same field merged (`{ total: { $gte: 10, $lt: 20 } }`). Anything that does not merge cleanly falls back to `$and`.
 * Invalid rows are left out.
 */
export function filterFor(filter: Filter): Record<string, unknown> {
  const clauses = filter.conditions.flatMap((condition) => {
    const result = clauseFor(condition);
    return "clause" in result ? [result.clause] : [];
  });
  if (clauses.length === 0) {
    return {};
  }
  if (clauses.length === 1) {
    return clauses[0];
  }
  if (filter.combine === "or") {
    return { $or: clauses };
  }
  const merged: Record<string, unknown> = {};
  for (const clause of clauses) {
    const [field, value] = Object.entries(clause)[0];
    if (!(field in merged)) {
      merged[field] = value;
      continue;
    }
    const existing = merged[field];
    if (!isOperatorDocument(existing) || !isOperatorDocument(value) || Object.keys(value).some((key) => key in existing)) {
      return { $and: clauses };
    }
    merged[field] = { ...existing, ...value };
  }
  return merged;
}

const VALUE_WRAPPERS = ["$date", "$oid", "$numberDecimal", "$numberLong", "$regex", "$options"];

/** A query operator document ($gt, $in, ...) that can share a field with others. Plain values and regexes cannot. */
function isOperatorDocument(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$") && !VALUE_WRAPPERS.includes(key));
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits `a, b, c` for text lists. Double quotes keep a comma inside a value: `"Smith, J", Doe`. */
export function splitList(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\\" && i + 1 < text.length) {
        current += text[++i];
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === "") {
      quoted = true;
      wasQuoted = true;
      current = "";
    } else if (char === ",") {
      parts.push(wasQuoted ? current : current.trim());
      current = "";
      wasQuoted = false;
    } else if (!wasQuoted) {
      current += char;
    }
  }
  parts.push(wasQuoted ? current : current.trim());
  return parts;
}

/** Short text for the Filter chip. */
export function filterSummary(filter: Filter): string {
  const valid = filter.conditions.filter((condition) => "clause" in clauseFor(condition));
  if (valid.length === 0) {
    return "none";
  }
  if (valid.length > 1) {
    return `${valid.length} conditions (${filter.combine === "and" ? "all" : "any"})`;
  }
  const [only] = valid;
  if (!takesValue(only.op)) {
    return `${only.field} ${OPERATOR_LABELS[only.op]}`;
  }
  const value = only.type === "null" ? "null" : only.type === "string" && only.op === "eq" ? `"${only.value}"` : only.value;
  return `${only.field} ${OPERATOR_LABELS[only.op]} ${value}`;
}

/** A distinct value of a field as the backend lists it: its `$type` name and its text. */
export type SuggestedValue = { type: string; text: string };

/** Whether a row can use value suggestions: comparisons and lists, on types where a short list of values is likely. */
export function suggestsValues(condition: Condition): boolean {
  return condition.field.trim() !== "" && condition.field !== "_id"
    && ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"].includes(condition.op)
    && ["string", "number", "decimal"].includes(condition.type);
}

/**
 * The suggestions for a row's value input: the field's values that read as the row's value type. For "is one of" lists each suggestion
 * is the text typed so far up to the last comma plus one more value (quoted when needed), leaving out values already in the list.
 */
export function valueOptions(condition: Condition, draft: string, values: readonly SuggestedValue[]): string[] {
  const texts = [...new Set(values.filter((value) => valueTypeFor([value.type]) === condition.type).map((value) => value.text))];
  if (condition.op !== "in" && condition.op !== "nin") {
    return texts;
  }
  const comma = draft.lastIndexOf(",");
  const prefix = comma < 0 ? "" : `${draft.slice(0, comma + 1)} `;
  const chosen = new Set(comma < 0 ? [] : splitList(draft.slice(0, comma)));
  return texts.filter((text) => !chosen.has(text)).map((text) => prefix + listItem(text));
}

/** One value for an "is one of" list, quoted when it holds a comma or a quote, or has spaces at either end. */
export function listItem(text: string): string {
  return /[,"]/.test(text) || text !== text.trim() ? `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"` : text;
}

/** Whether a field is worth sorting by: not when the sample only found embedded documents or arrays (nulls aside). */
export function isSortable(types: readonly string[]): boolean {
  const real = types.filter((type) => type !== "null" && type !== "missing");
  return real.length === 0 || real.some((type) => type !== "object" && type !== "array");
}

const SHELL_METHODS = "find|findOne|aggregate|countDocuments|estimatedDocumentCount|count|distinct|getIndexes|stats|explain";

/**
 * The collection the first command in `text` reads, or "" when it cannot tell: a JSON command (`"find": "orders"`) or a shell statement
 * (`db.orders.find(`, `db.reports.monthly.find(`, `db.getCollection("orders")`). Prefills the collection when taking over a command the bar
 * did not write, and tells the grid actions where results came from.
 */
export function guessCollection(text: string): string {
  const json = /["']?(?:find|aggregate|count|distinct|listIndexes)["']?\s*:\s*["']([^"']+)["']/.exec(text);
  const getCollection = /\bdb\s*\.\s*getCollection\s*\(\s*["']([^"']+)["']\s*\)/.exec(text);
  const shell = new RegExp(`\\bdb\\s*\\.\\s*((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)+?)(?:${SHELL_METHODS})\\s*\\(`).exec(text);
  const found = [
    json && { at: json.index, name: json[1] },
    getCollection && { at: getCollection.index, name: getCollection[1] },
    shell && { at: shell.index, name: shell[1].replace(/\s+/g, "").replace(/\.$/, "") }
  ].filter((candidate): candidate is { at: number; name: string } => Boolean(candidate) && candidate!.name !== "getSiblingDB");
  // The first command in the text wins
  return found.sort((a, b) => a.at - b.at)[0]?.name ?? "";
}
