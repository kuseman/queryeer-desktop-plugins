import { describe, expect, it } from "vitest";
import { collectionCommand, commandText } from "./queries.js";
import {
  addSortKey,
  clearProjection,
  commandFor,
  flipSortKey,
  initialState,
  isOwned,
  page,
  projectionSummary,
  rangeLabel,
  readStored,
  removeSortKey,
  sortSummary,
  textFor,
  toggleProjectionField,
  withCollection,
  withLimit,
  withProjectionMode
} from "./queryBarModel.js";

describe("commandFor / textFor", () => {
  it("writes the same text as the explorer's Browse for a fresh state", () => {
    expect(textFor(initialState("orders"))).toBe(commandText(collectionCommand("browse", "orders")));
  });

  it("adds projection, sort and skip only when set", () => {
    let state = initialState("orders");
    state = toggleProjectionField(state, "total");
    state = toggleProjectionField(state, "status");
    state = addSortKey(state, "total");
    state = flipSortKey(state, "total");
    state = { ...state, skip: 100 };
    expect(commandFor(state)).toEqual({
      find: "orders",
      filter: {},
      projection: { total: 1, status: 1, _id: 0 },
      sort: { total: -1 },
      skip: 100,
      limit: 50
    });
    expect(commandFor(withProjectionMode(state, "exclude")).projection).toEqual({ total: 0, status: 0 });
    expect(commandFor(withLimit(state, 0))).not.toHaveProperty("limit");
    expect(commandFor(toggleProjectionField(state, "_id")).projection).toEqual({ total: 1, status: 1, _id: 1 });
  });

  it("writes nothing until a collection is chosen", () => {
    expect(textFor(initialState())).toBe("");
  });
});

describe("isOwned", () => {
  const stored = { state: initialState("orders"), written: textFor(initialState("orders")) };

  it("owns an empty editor and the exact text it wrote", () => {
    expect(isOwned("", undefined)).toBe(true);
    expect(isOwned("  \n", stored)).toBe(true);
    expect(isOwned(stored.written, stored)).toBe(true);
    expect(isOwned(stored.written.replace(/\n/g, "\r\n").trimEnd(), stored)).toBe(true);
  });

  it("treats any other text as edited by hand", () => {
    expect(isOwned(stored.written.replace("50", "51"), stored)).toBe(false);
    expect(isOwned('{ "count": "orders" }', undefined)).toBe(false);
  });
});

describe("state changes", () => {
  it("starts over on a new collection but keeps the limit", () => {
    const state = withCollection(toggleProjectionField(withLimit(initialState("orders"), 100), "a"), "customers");
    expect(state).toEqual({ ...initialState("customers"), limit: 100 });
  });

  it("edits projection and sort, resetting paging when the order changes", () => {
    let state = { ...initialState("orders"), skip: 50 };
    state = toggleProjectionField(state, "a");
    expect(state.skip).toBe(50);
    expect(clearProjection(state).projection.fields).toEqual([]);
    expect(toggleProjectionField(state, "a").projection.fields).toEqual([]);

    state = addSortKey(state, "total");
    expect(state.skip).toBe(0);
    expect(addSortKey(state, "total").sort).toHaveLength(1);
    expect(removeSortKey(state, "total").sort).toEqual([]);
  });

  it("pages by the limit, never below zero", () => {
    const state = initialState("orders");
    expect(page(state, 1)?.skip).toBe(50);
    expect(page({ ...state, skip: 20 }, -1)?.skip).toBe(0);
    expect(page(withLimit(state, 0), 1)).toBeUndefined();
  });
});

describe("summaries", () => {
  it("describes projection, sort and the page range", () => {
    const state = initialState("orders");
    expect(projectionSummary(state.projection)).toBe("all");
    expect(projectionSummary(toggleProjectionField(state, "a").projection)).toBe("1 field");
    expect(projectionSummary(withProjectionMode(toggleProjectionField(toggleProjectionField(state, "a"), "b"), "exclude").projection)).toBe("all but 2");
    expect(sortSummary([])).toBe("none");
    expect(sortSummary(flipSortKey(addSortKey(addSortKey(state, "total"), "_id"), "total").sort)).toBe("total ↓, _id ↑");
    expect(rangeLabel({ ...state, skip: 50 })).toBe("51–100");
    expect(rangeLabel(withLimit(state, 0))).toBe("1–");
  });
});

describe("readStored", () => {
  it("accepts a stored bar and rejects malformed values", () => {
    const stored = { state: addSortKey(initialState("orders"), "a"), written: "x" };
    expect(readStored(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readStored(undefined)).toBeUndefined();
    expect(readStored({ written: "x" })).toBeUndefined();
    expect(readStored({ state: { ...initialState("o"), skip: -1 }, written: "x" })).toBeUndefined();
    expect(readStored({ state: { ...initialState("o"), projection: { mode: "both", fields: [] } }, written: "x" })).toBeUndefined();
  });
});
