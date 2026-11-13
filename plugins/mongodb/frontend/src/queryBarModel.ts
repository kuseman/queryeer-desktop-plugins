// The query bar's state and the `find` it generates. The flow is one way: the bar writes the editor text, and never
// reads it back. When the editor no longer holds what the bar last wrote, the user has edited by hand and the bar
// steps aside until they take over again.

import { commandText } from "./queries.js";

export type SortKey = { field: string; direction: 1 | -1 };

/** Include mode shows only the listed fields; exclude mode shows everything but them. No fields means all fields. */
export type Projection = { mode: "include" | "exclude"; fields: string[] };

export type BarState = {
  collection: string;
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
  return { collection, projection: { mode: "include", fields: [] }, sort: [], skip: 0, limit: DEFAULT_LIMIT };
}

/** The `find` command for a state. Optional parts are left out when empty, so a fresh state equals the explorer's Browse. */
export function commandFor(state: BarState): Record<string, unknown> {
  const command: Record<string, unknown> = { find: state.collection, filter: {} };
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
  if (typeof collection !== "string" || !isRecord(projection) || !Array.isArray(sort) || !isCount(skip) || !isCount(limit)) {
    return undefined;
  }
  if ((projection.mode !== "include" && projection.mode !== "exclude") || !Array.isArray(projection.fields)) {
    return undefined;
  }
  const fields = projection.fields.filter((field): field is string => typeof field === "string");
  const keys = sort.filter((key): key is SortKey => isRecord(key) && typeof key.field === "string" && (key.direction === 1 || key.direction === -1));
  return {
    state: { collection, projection: { mode: projection.mode, fields }, sort: keys.map(({ field, direction }) => ({ field, direction })), skip, limit },
    written: raw.written
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// State changes used by the builders. Each returns a new state.

/** Switching collection starts over: fields and sort belong to the old collection. The limit is kept. */
export function withCollection(state: BarState, collection: string): BarState {
  return { ...initialState(collection), limit: state.limit };
}

export function toggleProjectionField(state: BarState, field: string): BarState {
  const { fields } = state.projection;
  const next = fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field];
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
