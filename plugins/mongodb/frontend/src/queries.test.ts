import { describe, expect, it } from "vitest";
import {
  COLLECTION_ACTIONS,
  collectionCommand,
  commandText,
  databaseStatsCommand,
  distinctCommand,
  distinctTitle,
  queryTitle,
  shellCollection,
  shellTemplateText,
  slowQueriesCommand,
  tabTitle,
  TEMPLATES,
  templateCommand,
  validatorCommand
} from "./queries.js";
import { formatCount, formatJsonForTooltip, formatPresence } from "./MongoExplorer.js";

describe("templateCommand", () => {
  it("names the collection first, as the server expects, with a placeholder when none is known", () => {
    for (const { id } of TEMPLATES) {
      expect(Object.keys(templateCommand(id, "orders"))[0]).toBe(id);
      expect(Object.values(templateCommand(id, "orders"))[0]).toBe("orders");
      expect(Object.values(templateCommand(id, ""))[0]).toBe("collection");
    }
    expect(templateCommand("aggregate", "orders")).toMatchObject({ cursor: {} });
  });
});

describe("shellTemplateText", () => {
  // The backend's ShellParserTest parses these exact texts and checks they give the JSON templates' commands
  it("writes mongosh statements", () => {
    expect(shellTemplateText("find", "orders")).toBe("db.orders.find({}, {}).sort({ _id: 1 }).skip(0).limit(50)\n");
    expect(shellTemplateText("count", "orders")).toBe("db.orders.countDocuments({})\n");
    expect(shellTemplateText("distinct", "orders")).toBe("db.orders.distinct(\"field\", {})\n");
    expect(shellTemplateText("aggregate", "orders")).toBe([
      "db.orders.aggregate([",
      "  { $match: {} },",
      "  { $group: { _id: \"$field\", count: { $sum: 1 } } },",
      "  { $sort: { count: -1 } },",
      "  { $limit: 50 }",
      "])",
      ""
    ].join("\n"));
  });

  it("uses getCollection for names that are not dotted identifiers", () => {
    expect(shellCollection("orders")).toBe("db.orders");
    expect(shellCollection("reports.monthly")).toBe("db.reports.monthly");
    expect(shellCollection("variantsku-pricehistory")).toBe("db.getCollection(\"variantsku-pricehistory\")");
    expect(shellCollection("2024")).toBe("db.getCollection(\"2024\")");
    expect(shellCollection("")).toBe("db.collection");
    expect(shellTemplateText("count", "a b")).toBe("db.getCollection(\"a b\").countDocuments({})\n");
  });
});

describe("collectionCommand", () => {
  it("builds a read-only command for every explorer action", () => {
    expect(collectionCommand("browse", "orders")).toEqual({ find: "orders", filter: {}, limit: 50 });
    expect(collectionCommand("sample", "orders")).toEqual({ aggregate: "orders", pipeline: [{ $sample: { size: 20 } }], cursor: {} });
    expect(collectionCommand("count", "orders")).toEqual({ count: "orders" });
    expect(collectionCommand("indexes", "orders")).toEqual({ listIndexes: "orders" });

    const schema = collectionCommand("schema", "orders") as { aggregate: string; pipeline: Array<Record<string, unknown>>; cursor: object };
    expect(schema.aggregate).toBe("orders");
    expect(schema.pipeline.map((stage) => Object.keys(stage)[0])).toEqual(["$sample", "$project", "$unwind", "$group", "$sort"]);
    // Command names must stay on the backend allowlist and pipelines must stay write-free
    for (const action of COLLECTION_ACTIONS) {
      const command = collectionCommand(action.id, "c");
      expect(["find", "aggregate", "count", "listIndexes"]).toContain(Object.keys(command)[0]);
      expect(JSON.stringify(command)).not.toMatch(/"\$(out|merge)"/);
    }
  });

  it("keeps unusual collection names intact through JSON", () => {
    const text = commandText(collectionCommand("browse", 'we"ird.name'));
    expect(JSON.parse(text)).toEqual({ find: 'we"ird.name', filter: {}, limit: 50 });
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("distinctCommand", () => {
  it("builds an allowed distinct command and a tab title", () => {
    expect(distinctCommand("orders", "status")).toEqual({ distinct: "orders", key: "status", query: {} });
    expect(distinctTitle("orders", "customer.name")).toBe("orders.customer.name (Distinct)");
  });
});

describe("formatPresence", () => {
  it("shows a percentage only when the field is missing from some sampled documents", () => {
    expect(formatPresence({ count: 1000, sampled: 1000 })).toBe("");
    expect(formatPresence({ count: 870, sampled: 1000 })).toBe("87%");
    expect(formatPresence({ count: 3, sampled: 1000 })).toBe("<1%");
    expect(formatPresence({ count: 0, sampled: 0 })).toBe("");
  });
});

describe("queryTitle", () => {
  it("labels the tab and strips characters invalid in file names", () => {
    expect(queryTitle("orders", "browse")).toBe("orders (Browse)");
    expect(queryTitle("a/b:c", "schema")).toBe("a_b_c (Schema)");
  });
});

describe("formatCount", () => {
  it("abbreviates large counts", () => {
    expect(formatCount(null)).toBe("");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(45_678)).toBe("46k");
    expect(formatCount(4_100_000)).toBe("4.1M");
    expect(formatCount(25_000_000)).toBe("25M");
  });
});

describe("database and validator commands", () => {
  it("builds dbStats, the slow-query find and the validator lookup", () => {
    expect(databaseStatsCommand()).toEqual({ dbStats: 1, scale: 1 });
    const slow = slowQueriesCommand() as { find: string; sort: object; limit: number; projection: Record<string, number> };
    expect(slow.find).toBe("system.profile");
    expect(slow.sort).toEqual({ millis: -1 });
    expect(slow.limit).toBe(50);
    expect(slow.projection).toMatchObject({ millis: 1, planSummary: 1, docsExamined: 1, command: 1 });
    expect(validatorCommand("customers")).toEqual({ listCollections: 1, filter: { name: "customers" } });
    expect(tabTitle("shop", "Slowest queries")).toBe("shop (Slowest queries)");
  });
});

describe("formatJsonForTooltip", () => {
  it("indents JSON, keeps other text as-is and truncates long text", () => {
    expect(formatJsonForTooltip('{"a": 1}')).toBe('{\n  "a": 1\n}');
    expect(formatJsonForTooltip("{x: 1}")).toBe("{x: 1}");
    const long = formatJsonForTooltip(JSON.stringify({ a: "x".repeat(3000) }));
    expect(long.length).toBe(1501);
    expect(long.endsWith("…")).toBe(true);
  });
});
