import { describe, expect, it } from "vitest";
import { mongoOutline } from "./mongoOutline.js";

const names = (text: string) => mongoOutline(text).map((symbol) => `${symbol.name} (${symbol.detail}) ${symbol.range.startLineNumber}-${symbol.range.endLineNumber}`);

describe("mongoOutline", () => {
  it("lists every statement in either form, named by command and collection", () => {
    expect(names([
      "// Orders",
      "db.orders.find({ status: 'paid' })",
      "  .sort({ total: -1 })",
      "  .limit(10)",
      "{ \"aggregate\": \"orders\", \"pipeline\": [], \"cursor\": {} }",
      "db.getCollection(\"campaign-variantsku\").count()",
      "db.reports.monthly.countDocuments({}); db.runCommand({ dbStats: 1 })",
      "{ \"dbStats\": 1 }",
      "{ \"explain\": { \"find\": \"orders\" }, \"verbosity\": \"executionStats\" }",
      "db.orders.find().explain('executionStats')",
      "db.getSiblingDB('other').things.findOne()"
    ].join("\n"))).toEqual([
      "find orders (shell) 2-4",
      "aggregate orders (JSON) 5-5",
      "count campaign-variantsku (shell) 6-6",
      "countDocuments reports.monthly (shell) 7-7",
      "runCommand dbStats (shell) 7-7",
      "dbStats (JSON) 8-8",
      "explain find orders (JSON) 9-9",
      "explain find orders (shell) 10-10",
      "findOne (shell) 11-11"
    ]);
  });

  it("skips brackets, dots and db. inside strings, comments and regular expressions", () => {
    expect(names([
      "/* db.orders.drop() in a comment */",
      "db.orders.find({ note: \"a ) and a } and db.x.find()\", name: /^a\\)[/]/ }) // db.other.find()",
      "{ \"find\": \"orders\", \"filter\": { \"text\": \"{ not a document }\" } }"
    ].join("\n"))).toEqual([
      "find orders (shell) 2-2",
      "find orders (JSON) 3-3"
    ]);
  });

  it("copes with half-typed text", () => {
    expect(names("db.orders.find({ status:")).toEqual(["find orders (shell) 1-1"]);
    expect(names("{ \"find\": \"orders\", \"filter\": {")).toEqual(["find orders (JSON) 1-1"]);
    expect(names("db.")).toEqual(["db (shell) 1-1"]);
    expect(names("orders.find()\nhello")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  it("gives ranges that cover the statement and select its first line", () => {
    const [find] = mongoOutline("\n  db.orders\n    .find()\n");
    expect(find.range).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 12 });
    expect(find.selectionRange).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 12 });
    expect(mongoOutline("db.a.find()\r\ndb.b.find()").map((symbol) => symbol.range.startLineNumber)).toEqual([1, 2]);
  });
});
