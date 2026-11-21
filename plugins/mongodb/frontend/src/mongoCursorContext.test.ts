import { describe, expect, it } from "vitest";
import { cursorContext } from "./mongoCursorContext.js";

/** The context at `|` in the text. */
function at(textWithCursor: string) {
  const offset = textWithCursor.indexOf("|");
  return cursorContext(textWithCursor.replace("|", ""), offset);
}

describe("cursorContext", () => {
  it("knows a db member, with the names of a dotted collection so far", () => {
    expect(at("db.|")).toMatchObject({ prefix: "", member: { receiver: "db", segments: [] } });
    expect(at("db.ord|")).toMatchObject({ prefix: "ord", member: { receiver: "db", segments: [], segmentsFrom: 3, dotFrom: 2 } });
    expect(at("db.reports.mo|")).toMatchObject({ prefix: "mo", member: { receiver: "path", segments: ["reports"], segmentsFrom: 3 } });
    expect(at("db\n  .orders\n  .f|")).toMatchObject({ prefix: "f", member: { receiver: "path", segments: ["orders"] } });
  });

  it("knows a collection's and a cursor's members", () => {
    expect(at("db['my-coll'].|")).toMatchObject({ member: { receiver: "collection" }, target: { collection: "my-coll" } });
    expect(at("db.getCollection(\"a-b\").c|")).toMatchObject({ prefix: "c", member: { receiver: "collection" }, target: { collection: "a-b" } });
    expect(at("db.orders.find({ a: 1 }).|")).toMatchObject({ member: { receiver: "cursor" }, target: { collection: "orders" } });
    expect(at("db.orders.find().sort({ a: 1 })\n  .li|")).toMatchObject({ prefix: "li", member: { receiver: "cursor" } });
    expect(at("db.getSiblingDB('other').|")).toMatchObject({ member: { receiver: "db", segments: [] }, target: { database: "other" } });
    expect(at("db.getSiblingDB('other').things.find({ |")).toMatchObject({ target: { database: "other", collection: "things" }, object: { role: "filter" } });
  });

  it("knows filter keys, operators on a field, and nested filters", () => {
    expect(at("db.orders.find({ sta|")).toMatchObject({ prefix: "sta", object: { role: "filter", expectKey: true }, target: { collection: "orders" } });
    expect(at("db.orders.find({ status: 'A', |")).toMatchObject({ prefix: "", object: { role: "filter", expectKey: true } });
    expect(at("db.orders.find({ total: { $g|")).toMatchObject({ prefix: "$g", object: { role: "fieldCondition", expectKey: true } });
    expect(at("db.orders.find({ $or: [ { a: 1 }, { |")).toMatchObject({ object: { role: "filter", expectKey: true } });
    expect(at("db.orders.find({ items: { $elemMatch: { |")).toMatchObject({ object: { role: "filter" } });
    expect(at("db.orders.find({}, { na|")).toMatchObject({ object: { role: "projection" } });
    expect(at("db.orders.find().sort({ |")).toMatchObject({ object: { role: "sort" } });
  });

  it("takes a dotted key as one prefix, and quoted keys as strings", () => {
    expect(at("db.orders.find({ address.ci|")).toMatchObject({ prefix: "address.ci", prefixFrom: 17, object: { role: "filter", expectKey: true } });
    expect(at("db.orders.find({ \"addr|")).toMatchObject({ prefix: "addr", inString: { quote: "\"", from: 17 }, object: { role: "filter", expectKey: true } });
    expect(at("db.orders.find({ status |")).toMatchObject({ prefix: "" });
  });

  it("knows pipeline stages, $group accumulators and $lookup", () => {
    expect(at("db.orders.aggregate([ { $ma|")).toMatchObject({ prefix: "$ma", object: { role: "stage", expectKey: true } });
    expect(at("db.orders.aggregate([ { $match: { st|")).toMatchObject({ object: { role: "filter" } });
    expect(at("db.orders.aggregate([ { $match: {} }, { |")).toMatchObject({ object: { role: "stage" } });
    expect(at("db.orders.aggregate([ { $group: { _id: '$a', total: { $s|")).toMatchObject({ object: { role: "accumulator" } });
    expect(at("db.orders.aggregate([ { $group: { total: { $sum: \"$am|")).toMatchObject({ prefix: "$am", inString: { quote: "\"" }, object: { role: "accumulator", expectKey: false, key: "$sum" } });
    expect(at("db.orders.aggregate([ { $lookup: { from: \"|")).toMatchObject({ object: { role: "lookup", key: "from" }, inString: {} });
    expect(at("db.orders.aggregate([ { $facet: { a: [ { |")).toMatchObject({ object: { role: "stage" } });
  });

  it("knows JSON command documents and their collection", () => {
    expect(at("{ |")).toMatchObject({ object: { role: "command", expectKey: true } });
    expect(at("{ \"find\": \"orders\", \"filter\": { |")).toMatchObject({ object: { role: "filter" }, target: { collection: "orders" } });
    expect(at("{ \"find\": \"orders\", |")).toMatchObject({ object: { role: "command", command: "find", expectKey: true } });
    expect(at("{ \"aggregate\": \"orders\", \"pipeline\": [ { |")).toMatchObject({ object: { role: "stage" }, target: { collection: "orders" } });
    expect(at("db.runCommand({ |")).toMatchObject({ object: { role: "command" } });
  });

  it("knows the call around the cursor and which argument it is in", () => {
    expect(at("db.orders.find(|")).toMatchObject({ call: { name: "find", receiver: "collection", argIndex: 0 }, inCallArguments: true });
    expect(at("db.orders.find({ a: 1 }, |")).toMatchObject({ call: { name: "find", argIndex: 1 } });
    expect(at("db.orders.find({ a: { $in: [1, 2|")).toMatchObject({ call: { name: "find", argIndex: 0 }, inCallArguments: false });
    expect(at("db.orders.find().limit(|")).toMatchObject({ call: { name: "limit", receiver: "cursor" } });
    expect(at("db.orders.find()|")).not.toHaveProperty("call");
  });

  it("keeps statements apart, and offers nothing inside comments and regular expressions", () => {
    expect(at("db.a.find({ x: 1 })\ndb.b.find({ |")).toMatchObject({ target: { collection: "b" }, object: { role: "filter" } });
    expect(at("db.a.find() // db.|")).toMatchObject({ inComment: true });
    expect(at("db.a.find({ n: /ab|")).toMatchObject({ inComment: true });
    expect(at("/* db.| */")).toMatchObject({ inComment: true });
    expect(at("db.a.find({ n: /a,b/i, |")).toMatchObject({ object: { role: "filter", expectKey: true } });
  });

  it("never throws on half-typed or odd text", () => {
    for (const text of ["", "}", ")))", "db", "db..", "db[", "db[\"x", "{ : , }", "db.a.find({ x: [ } ) ]", "'"]) {
      for (let i = 0; i <= text.length; i++) {
        expect(() => cursorContext(text, i)).not.toThrow();
      }
    }
  });
});
