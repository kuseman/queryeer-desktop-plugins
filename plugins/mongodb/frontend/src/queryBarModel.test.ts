import { describe, expect, it } from "vitest";
import { collectionCommand, commandText } from "./queries.js";
import {
  guessCollection,
  addSortKey,
  clauseFor,
  filterFor,
  filterSummary,
  newCondition,
  operatorsFor,
  parseValue,
  valueTypeFor,
  withFilter,
  withValueType,
  type Condition,
  type Filter,
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
  splitList,
  CHOOSABLE_VALUE_TYPES,
  isSortable,
  suggestsValues,
  valueOptions,
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

describe("filter", () => {
  const row = (field: string, op: Condition["op"], type: Condition["type"], value = ""): Condition => ({ field, op, type, value });
  const filter = (conditions: Condition[], combine: Filter["combine"] = "and"): Filter => ({ combine, conditions });

  it("reads values by type as Extended JSON", () => {
    expect(parseValue("number", " 42 ")).toEqual({ value: 42 });
    expect(parseValue("number", "-1.5e3")).toEqual({ value: -1500 });
    expect(parseValue("number", "9007199254740993")).toEqual({ value: { $numberLong: "9007199254740993" } });
    expect(parseValue("decimal", "12.50")).toEqual({ value: { $numberDecimal: "12.50" } });
    expect(parseValue("date", "2026-11-14")).toEqual({ value: { $date: "2026-11-14T00:00:00.000Z" } });
    expect(parseValue("date", "2026-11-14 08:30")).toEqual({ value: { $date: "2026-11-14T08:30:00.000Z" } });
    expect(parseValue("date", "2026-11-14T08:30:00+01:00")).toEqual({ value: { $date: "2026-11-14T07:30:00.000Z" } });
    expect(parseValue("objectId", "650000000000000000000001")).toEqual({ value: { $oid: "650000000000000000000001" } });
    expect(parseValue("boolean", "false")).toEqual({ value: false });
    expect(parseValue("null", "anything")).toEqual({ value: null });
    expect(parseValue("string", " keeps spaces ")).toEqual({ value: " keeps spaces " });
    for (const [type, text] of [["number", "12a"], ["decimal", ""], ["date", "yesterday"], ["date", "14/11/2026"], ["objectId", "abc"]] as const) {
      expect(parseValue(type, text)).toHaveProperty("error");
    }
  });

  it("writes one clause per operator", () => {
    expect(clauseFor(row("status", "eq", "string", "paid"))).toEqual({ clause: { status: "paid" } });
    expect(clauseFor(row("total", "gte", "number", "100"))).toEqual({ clause: { total: { $gte: 100 } } });
    expect(clauseFor(row("total", "ne", "decimal", "0"))).toEqual({ clause: { total: { $ne: { $numberDecimal: "0" } } } });
    expect(clauseFor(row("status", "in", "string", 'new, paid, "a, b"'))).toEqual({ clause: { status: { $in: ["new", "paid", "a, b"] } } });
    expect(clauseFor(row("qty", "nin", "number", "1, 2"))).toEqual({ clause: { qty: { $nin: [1, 2] } } });
    expect(clauseFor(row("name", "contains", "string", "a.b"))).toEqual({ clause: { name: { $regex: "a\\.b", $options: "i" } } });
    expect(clauseFor(row("name", "startsWith", "string", "Al"))).toEqual({ clause: { name: { $regex: "^Al", $options: "" } } });
    expect(clauseFor(row("name", "regex", "string", "^a.*z$"))).toEqual({ clause: { name: { $regex: "^a.*z$", $options: "" } } });
    expect(clauseFor(row("phone", "exists", "string"))).toEqual({ clause: { phone: { $exists: true } } });
    expect(clauseFor(row("phone", "missing", "string"))).toEqual({ clause: { phone: { $exists: false } } });
    expect(clauseFor(row("notes", "eq", "null"))).toEqual({ clause: { notes: null } });
    expect(clauseFor(row("address.city", "eq", "string", "Oslo"))).toEqual({ clause: { "address.city": "Oslo" } });
  });

  it("reports incomplete or invalid rows", () => {
    expect(clauseFor(row("", "eq", "string", "x"))).toEqual({ error: "Pick a field" });
    expect(clauseFor(row("name", "contains", "string", ""))).toHaveProperty("error");
    expect(clauseFor(row("name", "regex", "string", "(unclosed"))).toHaveProperty("error");
    expect(clauseFor(row("qty", "in", "number", "1, two"))).toEqual({ error: "two: Not a number" });
    expect(clauseFor(row("qty", "in", "number", " , "))).toHaveProperty("error");
  });

  it("keeps AND flat, merges ranges on one field, and falls back to $and when it cannot merge", () => {
    expect(filterFor(filter([]))).toEqual({});
    expect(filterFor(filter([row("status", "eq", "string", "paid"), row("total", "gt", "number", "10")])))
      .toEqual({ status: "paid", total: { $gt: 10 } });
    expect(filterFor(filter([row("total", "gte", "number", "10"), row("total", "lt", "number", "20")])))
      .toEqual({ total: { $gte: 10, $lt: 20 } });
    expect(filterFor(filter([row("total", "gt", "number", "10"), row("total", "gt", "number", "20")])))
      .toEqual({ $and: [{ total: { $gt: 10 } }, { total: { $gt: 20 } }] });
    expect(filterFor(filter([row("name", "contains", "string", "a"), row("name", "ne", "string", "b")])))
      .toEqual({ $and: [{ name: { $regex: "a", $options: "i" } }, { name: { $ne: "b" } }] });
    expect(filterFor(filter([row("status", "eq", "string", "new"), row("status", "eq", "string", "paid")]))).toHaveProperty("$and");
  });

  it("writes $or for any, and leaves invalid rows out", () => {
    expect(filterFor(filter([row("status", "eq", "string", "new"), row("express", "eq", "boolean", "true")], "or")))
      .toEqual({ $or: [{ status: "new" }, { express: true }] });
    expect(filterFor(filter([row("status", "eq", "string", "new"), row("total", "gt", "number", "x")], "or"))).toEqual({ status: "new" });
  });

  it("types new rows from the sampled BSON types", () => {
    expect(valueTypeFor(["int", "double"])).toBe("number");
    expect(valueTypeFor(["null", "date"])).toBe("date");
    expect(valueTypeFor(["decimal"])).toBe("decimal");
    expect(valueTypeFor(["objectId"])).toBe("objectId");
    expect(valueTypeFor(["bool"])).toBe("boolean");
    expect(valueTypeFor(["object"])).toBe("document");
    expect(valueTypeFor(["null", "object"])).toBe("document");
    expect(valueTypeFor(["object", "string"])).toBe("string");
    expect(valueTypeFor(["array"])).toBe("string");
    expect(valueTypeFor([])).toBe("string");
    expect(newCondition("express", ["bool"])).toEqual({ field: "express", op: "eq", type: "boolean", value: "true" });
    expect(withValueType(row("name", "contains", "string", "x"), "number")).toEqual(row("name", "eq", "number", "x"));
    expect(withValueType(row("total", "gt", "number", "5"), "decimal").op).toBe("gt");
    expect(operatorsFor("boolean")).not.toContain("gt");
  });

  it("puts the filter in the find, resets paging, and survives a round trip through editor state", () => {
    const state = withFilter({ ...initialState("orders"), skip: 100 }, filter([row("status", "eq", "string", "paid")]));
    expect(state.skip).toBe(0);
    expect(commandFor(state).filter).toEqual({ status: "paid" });
    expect(withCollection(state, "customers").filter.conditions).toEqual([]);
    const stored = { state, written: textFor(state) };
    expect(readStored(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    const { filter: _filter, ...older } = initialState("orders");
    expect(readStored({ state: older, written: "x" })?.state.filter).toEqual({ combine: "and", conditions: [] });
    expect(readStored({ state: { ...initialState("o"), filter: { combine: "xor", conditions: [] } }, written: "x" })).toBeUndefined();
  });

  it("summarises the filter for its chip", () => {
    expect(filterSummary(filter([]))).toBe("none");
    expect(filterSummary(filter([row("status", "eq", "string", "paid")]))).toBe('status = "paid"');
    expect(filterSummary(filter([row("total", "gt", "number", "5")]))).toBe("total > 5");
    expect(filterSummary(filter([row("phone", "missing", "string")]))).toBe("phone is missing");
    expect(filterSummary(filter([row("a", "eq", "number", "1"), row("b", "eq", "number", "2"), row("c", "eq", "number", "x")], "or")))
      .toBe("2 conditions (any)");
  });
});

describe("embedded fields and value suggestions", () => {
  const row = (field: string, op: Condition["op"], type: Condition["type"], value = ""): Condition => ({ field, op, type, value });

  it("only tests a document field for presence, and does not sort by documents or arrays", () => {
    expect(operatorsFor("document")).toEqual(["exists", "missing"]);
    expect(newCondition("payload.source", ["object"])).toEqual({ field: "payload.source", op: "exists", type: "document", value: "" });
    expect(withValueType(row("payload.source", "eq", "string", "x"), "document").op).toBe("exists");
    expect(withValueType(row("payload.source", "missing", "document"), "string").op).toBe("missing");
    expect(clauseFor(row("payload.source", "exists", "document"))).toEqual({ clause: { "payload.source": { $exists: true } } });
    expect(CHOOSABLE_VALUE_TYPES).not.toContain("document");
    expect(isSortable(["object"])).toBe(false);
    expect(isSortable(["array", "null"])).toBe(false);
    expect(isSortable(["object", "string"])).toBe(true);
    expect(isSortable(["int"])).toBe(true);
    expect(isSortable([])).toBe(true);
  });

  it("never projects a field together with its parent", () => {
    let state = toggleProjectionField(initialState("events"), "payload");
    state = toggleProjectionField(state, "payload.orderId");
    expect(state.projection.fields).toEqual(["payload.orderId"]);
    state = toggleProjectionField(state, "payload.status");
    expect(state.projection.fields).toEqual(["payload.orderId", "payload.status"]);
    state = toggleProjectionField(state, "payload");
    expect(state.projection.fields).toEqual(["payload"]);
    expect(toggleProjectionField(toggleProjectionField(state, "payloadSize"), "payload").projection.fields).toEqual(["payloadSize"]);
  });

  it("suggests values only where a short list helps", () => {
    expect(suggestsValues(row("status", "eq", "string"))).toBe(true);
    expect(suggestsValues(row("payload.qty", "in", "number"))).toBe(true);
    expect(suggestsValues(row("status", "contains", "string"))).toBe(false);
    expect(suggestsValues(row("createdAt", "gt", "date"))).toBe(false);
    expect(suggestsValues(row("_id", "eq", "string"))).toBe(false);
    expect(suggestsValues(row("", "eq", "string"))).toBe(false);
  });

  it("lists values of the row's type, and builds on the list typed so far", () => {
    const values = [
      { type: "string", text: "new" },
      { type: "string", text: "paid" },
      { type: "string", text: 'a, "b"' },
      { type: "int", text: "1" },
      { type: "long", text: "1" },
      { type: "double", text: "2.5" }
    ];
    expect(valueOptions(row("status", "eq", "string"), "", values)).toEqual(["new", "paid", 'a, "b"']);
    expect(valueOptions(row("qty", "eq", "number"), "", values)).toEqual(["1", "2.5"]);
    expect(valueOptions(row("status", "in", "string"), "", values)).toEqual(["new", "paid", '"a, \\"b\\""']);
    expect(valueOptions(row("status", "in", "string"), "new, pa", values)).toEqual(["new, paid", 'new, "a, \\"b\\""']);
    expect(splitList('new, "a, \\"b\\""')).toEqual(["new", 'a, "b"']);
  });
});

describe("guessCollection", () => {
  it("finds the collection of the first command, in either form", () => {
    expect(guessCollection('{ "find": "orders", "filter": {} }')).toBe("orders");
    expect(guessCollection("db.orders.find({ a: 1 })")).toBe("orders");
    expect(guessCollection("db.reports.monthly.aggregate([])")).toBe("reports.monthly");
    expect(guessCollection("db . orders\n  . countDocuments()")).toBe("orders");
    expect(guessCollection('db.getCollection("system.profile").find()')).toBe("system.profile");
    expect(guessCollection('db.customers.find()\n{ "count": "orders" }')).toBe("customers");
    expect(guessCollection('{ "count": "orders" }\ndb.customers.find()')).toBe("orders");
    expect(guessCollection("db.runCommand({ ping: 1 })")).toBe("");
    expect(guessCollection("db.getSiblingDB('x').orders.find()")).toBe("");
  });
});
