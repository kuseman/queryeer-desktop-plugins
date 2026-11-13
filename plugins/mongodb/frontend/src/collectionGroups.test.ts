import { describe, expect, it } from "vitest";
import { badgeFor, describeEntry, groupCollections, validationBadge, type CollectionInfo } from "./collectionGroups.js";

const c = (name: string, extra: Partial<CollectionInfo> = {}): CollectionInfo => ({ name, type: "collection", count: 10, ...extra });

describe("groupCollections", () => {
  it("splits collections, views and system collections and folds GridFS buckets", () => {
    const groups = groupCollections([
      c("fs.chunks"),
      c("fs.files"),
      c("metrics", { type: "timeseries", timeField: "ts" }),
      c("openOrders", { type: "view", count: null, viewOn: "orders" }),
      c("orders"),
      c("photos.files"), // no matching .chunks: not a GridFS bucket
      c("system.buckets.metrics"),
      c("system.profile"),
      c("system.views")
    ]);

    expect(groups.collections.map((e) => [e.label, e.name])).toEqual([
      ["fs", "fs.files"],
      ["metrics", "metrics"],
      ["orders", "orders"],
      ["photos.files", "photos.files"]
    ]);
    expect(groups.views.map((e) => e.name)).toEqual(["openOrders"]);
    expect(groups.system.map((e) => e.name)).toEqual(["system.buckets.metrics", "system.profile", "system.views"]);
  });

  it("returns empty groups for an empty database", () => {
    expect(groupCollections([])).toEqual({ collections: [], views: [], system: [] });
  });
});

describe("badgeFor / describeEntry", () => {
  it("labels and describes special collections", () => {
    const [bucket, metrics] = groupCollections([
      c("fs.chunks"),
      c("fs.files"),
      c("metrics", { type: "timeseries", timeField: "ts", metaField: "sensor", granularity: "seconds" })
    ]).collections;
    const view = groupCollections([c("v", { type: "view", count: null, viewOn: "orders", pipeline: "[{\"$match\": {}}]" })]).views[0];

    expect(badgeFor(bucket)).toBe("GridFS");
    expect(describeEntry(bucket)).toContain("fs.chunks");
    expect(badgeFor(metrics)).toBe("time series");
    expect(describeEntry(metrics)).toContain('time field "ts", meta field "sensor", granularity seconds');
    expect(badgeFor(view)).toBe("view");
    expect(describeEntry(view)).toBe('View on orders\nPipeline: [{"$match": {}}]');
    expect(badgeFor(groupCollections([c("orders")]).collections[0])).toBeUndefined();
  });
});

describe("validationBadge", () => {
  it("only flags enforcement that differs from strict/error", () => {
    expect(validationBadge(c("a", { validator: "{}", validationLevel: "strict", validationAction: "error" }))).toBeUndefined();
    expect(validationBadge(c("a", { validator: "{}", validationLevel: "strict", validationAction: "warn" }))).toBe("warn");
    expect(validationBadge(c("a", { validator: "{}", validationLevel: "moderate", validationAction: "warn" }))).toBe("moderate, warn");
    expect(validationBadge(c("a"))).toBeUndefined();
  });
});
