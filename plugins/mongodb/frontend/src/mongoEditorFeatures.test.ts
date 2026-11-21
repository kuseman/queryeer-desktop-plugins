import { describe, expect, it, vi } from "vitest";
import { CompletionTriggerKind, type CompletionItem, type TextDocument } from "@queryeer/api/editor/EditorApi";
import { createMongoEditorFeatures, type FieldSample, type MongoEditorData } from "./mongoEditorFeatures.js";

const ORDERS_FIELDS: FieldSample[] = [
  { name: "status", types: ["string"], count: 100, sampled: 100 },
  { name: "total", types: ["double", "int"], count: 98, sampled: 100 },
  { name: "address.city", types: ["string"], count: 40, sampled: 100 }
];

function fakeData(overrides: Partial<MongoEditorData> = {}): MongoEditorData {
  return {
    scope: (fileId) => (fileId === "file-1" ? { connectionId: "local", database: "shop" } : undefined),
    collections: async (_connectionId, database) => (database === "shop" ? ["orders", "reports.monthly", "my-coll"] : ["things"]),
    fields: async (_connectionId, _database, collection) => (collection === "orders" ? ORDERS_FIELDS : []),
    validate: async () => [],
    ...overrides
  };
}

/** A document of the text without `|`, and the cursor's position at `|`. */
function documentAt(textWithCursor: string, fileId: string | undefined = "file-1") {
  const offset = textWithCursor.indexOf("|");
  const text = textWithCursor.replace("|", "");
  const lines = text.split("\n");
  const before = text.slice(0, offset).split("\n");
  const document: TextDocument = {
    uri: "file:///c%3A/work/q.mongo",
    languageId: "mongodb",
    ...(fileId ? { fileId } : {}),
    getText: () => text,
    lineCount: lines.length,
    lineAt: (lineNumber) => ({
      lineNumber,
      text: lines[lineNumber - 1],
      range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: lines[lineNumber - 1].length + 1 }
    })
  };
  return { document, position: { lineNumber: before.length, column: before[before.length - 1].length + 1 } };
}

const token = { isCancellationRequested: false };

async function complete(textWithCursor: string, data = fakeData(), fileId?: string): Promise<CompletionItem[]> {
  const { document, position } = documentAt(textWithCursor, fileId);
  const result = await createMongoEditorFeatures(data).completion.provideCompletionItems(document, position, { triggerKind: CompletionTriggerKind.Invoked }, token);
  return result?.suggestions ?? [];
}

const labels = (items: CompletionItem[]) => items.map((item) => item.label);
const byLabel = (items: CompletionItem[], label: string) => items.find((item) => item.label === label);

describe("completion", () => {
  it("offers collections and db methods after db., quoting names that need it", async () => {
    const items = await complete("db.|");

    expect(labels(items)).toEqual(expect.arrayContaining(["orders", "reports.monthly", "my-coll", "getCollection", "getSiblingDB", "runCommand"]));
    expect(byLabel(items, "orders")).toMatchObject({ insertText: "orders", range: { startColumn: 4, endColumn: 4 } });
    // Replaces the dot: db["my-coll"]
    expect(byLabel(items, "my-coll")).toMatchObject({ insertText: "[\"my-coll\"]", range: { startColumn: 3, endColumn: 4 }, filterText: ".my-coll" });
  });

  it("completes the rest of a collection named with dots, and offers collection methods on the path", async () => {
    const items = await complete("db.reports.mo|");

    expect(byLabel(items, "reports.monthly")).toMatchObject({ insertText: "monthly", filterText: "monthly", range: { startColumn: 12, endColumn: 14 } });
    expect(labels(items)).not.toContain("orders");
    expect(labels(items)).toEqual(expect.arrayContaining(["find", "aggregate", "countDocuments"]));
  });

  it("offers collection methods, then cursor methods", async () => {
    expect(labels(await complete("db.orders.find().|"))).toEqual(expect.arrayContaining(["sort", "limit", "skip", "explain"]));
    expect(labels(await complete("db['my-coll'].|"))).toEqual(expect.arrayContaining(["find", "aggregate"]));
    expect(labels(await complete("db.orders.find().|"))).not.toContain("aggregate");
  });

  it("offers collections inside db[\"…\"] and getCollection(\"…\")", async () => {
    expect(labels(await complete("db[\"my|"))).toEqual(["orders", "reports.monthly", "my-coll"]);
    expect(byLabel(await complete("db.getCollection('my|"), "my-coll")).toMatchObject({ insertText: "my-coll", range: { startColumn: 19, endColumn: 21 } });
  });

  it("offers the collection's fields and filter operators as filter keys, quoting dotted names", async () => {
    const items = await complete("db.orders.find({ |");

    expect(labels(items)).toEqual(expect.arrayContaining(["status", "total", "address.city", "$or", "$expr"]));
    expect(byLabel(items, "total")).toMatchObject({ insertText: "total", detail: "double | int", documentation: "In 98 of 100 sampled documents." });
    expect(byLabel(items, "address.city")).toMatchObject({ insertText: "\"address.city\"" });
    // A dotted name typed so far is replaced as a whole
    expect(byLabel(await complete("db.orders.find({ address.ci|"), "address.city")).toMatchObject({ range: { startColumn: 18, endColumn: 28 } });
    // Inside quotes, as is
    expect(byLabel(await complete("db.orders.find({ \"addr|"), "address.city")).toMatchObject({ insertText: "address.city" });
  });

  it("offers operators on a field's value, with $ in the replaced word", async () => {
    const items = await complete("db.orders.find({ total: { $g|");

    expect(labels(items)).toEqual(expect.arrayContaining(["$gt", "$gte", "$in", "$elemMatch"]));
    expect(labels(items)).not.toContain("status");
    expect(byLabel(items, "$gt")).toMatchObject({ insertText: "$gt", range: { startColumn: 27, endColumn: 29 } });
  });

  it("offers stages, accumulators, and $field references in aggregation values", async () => {
    expect(labels(await complete("db.orders.aggregate([ { $|"))).toEqual(expect.arrayContaining(["$match", "$group", "$lookup"]));
    expect(labels(await complete("db.orders.aggregate([ { $group: { _id: null, n: { |"))).toEqual(expect.arrayContaining(["$sum", "$avg", "$push"]));
    expect(labels(await complete("db.orders.aggregate([ { $group: { _id: \"$st|"))).toEqual(["$status", "$total", "$address.city"]);
    // Not in a filter: a "$…" string is a value there
    expect(await complete("db.orders.find({ status: \"$|")).toEqual([]);
    expect(labels(await complete("db.orders.aggregate([ { $lookup: { from: \"|"))).toContain("orders");
  });

  it("offers commands and their options in JSON command documents", async () => {
    expect(labels(await complete("{ |"))).toEqual(expect.arrayContaining(["find", "aggregate", "count", "distinct"]));
    expect(labels(await complete("{ \"find\": \"orders\", |"))).toEqual(expect.arrayContaining(["filter", "sort", "limit"]));
    expect(labels(await complete("{ \"find\": \"orders\", \"filter\": { |"))).toContain("status");
    expect(labels(await complete("{ \"find\": \"|"))).toContain("orders");
  });

  it("offers what it knows without a connection, collection or backend", async () => {
    expect(labels(await complete("db.orders.find({ |", fakeData(), "file-2"))).toEqual(expect.arrayContaining(["$or"]));
    expect(labels(await complete("db.orders.find({ |", fakeData(), "file-2"))).not.toContain("status");
    const failing = fakeData({ collections: () => Promise.reject(new Error("locked")), fields: () => Promise.reject(new Error("locked")) });
    expect(labels(await complete("db.|", failing))).toEqual(expect.arrayContaining(["getCollection"]));
    expect(labels(await complete("db.orders.find({ |", failing))).toEqual(expect.arrayContaining(["$and"]));
  });

  it("uses the database of getSiblingDB", async () => {
    const collections = vi.fn(fakeData().collections);
    expect(labels(await complete("db.getSiblingDB('other').|", fakeData({ collections })))).toContain("things");
    expect(collections).toHaveBeenCalledWith("local", "other");
  });

  it("offers nothing in comments, regular expressions and plain values", async () => {
    expect(await complete("// db.|")).toEqual([]);
    expect(await complete("db.orders.find({ a: /x|")).toEqual([]);
    expect(await complete("db.orders.find({ status: \"A|")).toEqual([]);
  });
});

describe("hover", () => {
  async function hover(textWithCursor: string) {
    const { document, position } = documentAt(textWithCursor);
    return createMongoEditorFeatures(fakeData()).hover.provideHover(document, position, token);
  }

  it("explains operators, by where they are", async () => {
    expect((await hover("db.orders.find({ total: { $g|t: 1 } })"))?.contents[0].value).toContain("greater than the given value");
    expect(await hover("db.orders.aggregate([ { $cou|nt: \"n\" } ])")).toMatchObject({
      range: { startColumn: 25, endColumn: 31 },
      contents: [{ value: expect.stringContaining("Counts the documents into a field") }]
    });
    expect((await hover("db.orders.aggregate([ { $group: { _id: null, n: { $cou|nt: {} } } } ])"))?.contents[0].value).toContain("number of documents in the group");
  });

  it("shows a method's signature, and a field's sampled types", async () => {
    expect((await hover("db.orders.fi|nd({})"))?.contents[0].value).toContain("find(filter?, projection?, options?)");
    expect((await hover("db.orders.find().li|mit(5)"))?.contents[0].value).toContain("limit(count)");
    expect(await hover("db.orders.find({ address.ci|ty: 'x' })")).toMatchObject({
      range: { startColumn: 18, endColumn: 30 },
      contents: [{ value: "**address.city**: string\n\nIn 40 of 100 sampled documents." }]
    });
  });

  it("shows nothing for values, strings and unknown names", async () => {
    expect(await hover("db.orders.find({ status: \"$g|t\" })")).toEqual({ contents: [] });
    expect(await hover("db.orders.find({ nope|: 1 })")).toEqual({ contents: [] });
    expect(await hover("db.orders.find({ a: tr|ue })")).toEqual({ contents: [] });
  });
});

describe("signature help", () => {
  function help(textWithCursor: string) {
    const { document, position } = documentAt(textWithCursor);
    return createMongoEditorFeatures(fakeData()).signatureHelp.provideSignatureHelp(document, position, token);
  }

  it("shows the call's signature with the argument the cursor is in", () => {
    expect(help("db.orders.find({ a: 1 }, |")).toMatchObject({ activeParameter: 1, signatures: [{ label: "find(filter?, projection?, options?)" }] });
    expect(help("db.orders.find({ a: { $in: [1, |")).toMatchObject({ activeParameter: 0 });
    expect(help("db.orders.distinct(\"status\", |")).toMatchObject({ activeParameter: 1, signatures: [{ label: "distinct(field, filter?, options?)" }] });
    expect(help("db.getSiblingDB(|")).toMatchObject({ signatures: [{ label: "getSiblingDB(database)" }] });
    expect(help("db.orders.find().sort({}).limit(|")).toMatchObject({ signatures: [{ label: "limit(count)" }] });
    expect(help("db.orders.find()|")).toBeNull();
  });
});

describe("diagnostics", () => {
  async function diagnose(text: string, data: MongoEditorData) {
    const { document } = documentAt(`${text}|`);
    return createMongoEditorFeatures(data).diagnostics.provideDiagnostics(document, token);
  }

  it("underlines the word where the backend's parser stopped", async () => {
    const validate = vi.fn(async () => [{ message: "Invalid arguments to find()", line: 2, column: 11 }]);

    expect(await diagnose("db.a.find()\ndb.orders.find({ a. })", fakeData({ validate }))).toEqual([{
      range: { startLineNumber: 2, startColumn: 11, endLineNumber: 2, endColumn: 15 },
      message: "Invalid arguments to find()",
      severity: "error",
      source: "mongodb"
    }]);
    expect(validate).toHaveBeenCalledWith("db.a.find()\ndb.orders.find({ a. })");
  });

  it("keeps a position past the line's end on its last character", async () => {
    const validate = async () => [{ message: "Unexpected end", line: 1, column: 20 }];
    expect((await diagnose("db.orders.find(", fakeData({ validate })))?.[0].range).toEqual({ startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 16 });
  });

  it("shows nothing for an empty file or when the backend can't be asked", async () => {
    const validate = vi.fn(async () => [{ message: "x", line: 1, column: 1 }]);
    expect(await diagnose("  \n", fakeData({ validate }))).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(await diagnose("db.x(", fakeData({ validate: () => Promise.reject(new Error("backend stopped")) }))).toEqual([]);
  });
});

describe("completion, cases from review", () => {
  it("treats a JSON command right after a shell statement, or in a list, as a command", async () => {
    expect(labels(await complete("db.a.find()\n{ \"find\": \"orders\", \"filter\": { |"))).toEqual(expect.arrayContaining(["status", "$or"]));
    expect(labels(await complete("db.a.find()\n{ |"))).toEqual(expect.arrayContaining(["find", "aggregate"]));
    expect(labels(await complete("[ { \"find\": \"orders\", \"filter\": { |"))).toContain("status");
    expect(labels(await complete("[ { \"find\": \"a\" }, { |"))).toContain("aggregate");
  });

  it("quotes a collection completed in db[ without a quote, and offers no methods there", async () => {
    const items = await complete("db[or|");
    expect(byLabel(items, "orders")).toMatchObject({ insertText: "\"orders\"", range: { startColumn: 4, endColumn: 6 } });
    expect(byLabel(items, "my-coll")).toMatchObject({ insertText: "\"my-coll\"" });
    expect(labels(items)).not.toContain("getCollection");
  });

  it("offers only the calls the backend accepts after each method", async () => {
    expect(labels(await complete("db.orders.find().|"))).toEqual(expect.arrayContaining(["sort", "limit", "count", "size"]));
    expect(labels(await complete("db.orders.findOne({}).sort({}).|"))).toContain("limit");
    expect(labels(await complete("db.orders.aggregate([]).|")).sort()).toEqual(["batchSize", "explain", "pretty", "toArray"]);
    expect(labels(await complete("db.orders.countDocuments({}).|")).sort()).toEqual(["explain", "pretty", "toArray"]);
  });

  it("ends an unclosed regular expression at its line", async () => {
    // A stray / at the end of a line: the next line's db isn't read as its flags
    expect(labels(await complete("db.a.find({ a: 1 }) /\ndb.orders.find({ |"))).toContain("status");
  });

  it("offers the joined collection's fields in a $lookup or $unionWith pipeline", async () => {
    const fields = vi.fn(async (_c: string, _d: string, collection: string) => (collection === "orders" ? ORDERS_FIELDS : [{ name: "sku", types: ["string"], count: 1, sampled: 1 }]));
    const data = fakeData({ fields });
    expect(labels(await complete("db.orders.aggregate([ { $lookup: { from: \"items\", pipeline: [ { $match: { |", data))).toContain("sku");
    expect(labels(await complete("db.orders.aggregate([ { $unionWith: { coll: \"items\", pipeline: [ { $match: { |", data))).toContain("sku");
    expect(labels(await complete("db.orders.aggregate([ { $unionWith: { |", data))).toEqual(["coll", "pipeline"]);
    expect(labels(await complete("db.orders.aggregate([ { $unionWith: { coll: \"|", data))).toContain("orders");
    // The stage itself is still about the outer collection
    expect(labels(await complete("db.orders.aggregate([ { $lookup: { from: \"items\" } }, { $match: { |", data))).toContain("status");
  });

  it("offers collections only as the value of commands that take one", async () => {
    expect(await complete("{ \"dbStats\": \"|")).toEqual([]);
    expect(labels(await complete("{ \"collStats\": \"|"))).toContain("orders");
  });
});
