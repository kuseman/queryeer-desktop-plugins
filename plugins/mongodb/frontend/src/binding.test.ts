import { describe, expect, it } from "vitest";
import type { FileEntity } from "@queryeer/api/files/FileEntity";
import { buildEngineState, readSelectedDatabase, resolveConnection } from "./binding.js";
import { parseConnections } from "./connections.js";

const connections = parseConnections([
  { connectionId: "prod", hosts: "p" },
  { connectionId: "dev", hosts: "d" },
  { connectionId: "off", hosts: "o", enabled: false }
]);

function file(connectionId?: string, engineId = "mongodb"): FileEntity {
  return {
    fileId: "f1",
    version: 1,
    uri: "file:///q.mongo",
    mimeType: "application/vnd.queryeer.mongodb",
    engineBinding: connectionId === undefined ? undefined : { engineId, connectionId },
    dirtyVsBackend: false,
    dirtyVsDisk: false,
    diskState: "unknown",
    openedAt: "2026-01-01T00:00:00Z"
  } as unknown as FileEntity;
}

describe("resolveConnection", () => {
  it("uses the bound connection when it exists and is enabled", () => {
    expect(resolveConnection(file("dev"), connections)?.connectionId).toBe("dev");
    expect(resolveConnection(file("off"), connections)).toBeUndefined();
    expect(resolveConnection(file("gone"), connections)).toBeUndefined();
  });

  it("falls back to the only enabled connection when nothing is bound", () => {
    expect(resolveConnection(file(), connections)).toBeUndefined();
    expect(resolveConnection(file(), connections.slice(1))?.connectionId).toBe("dev");
  });

  it("ignores bindings that belong to another engine", () => {
    expect(resolveConnection(file("prod", "jdbc"), connections.slice(1))?.connectionId).toBe("dev");
  });
});

describe("buildEngineState", () => {
  it("sends the connection and the database selected for that connection", () => {
    expect(buildEngineState(file("prod"), connections, { connectionId: "prod", database: "shop" })).toEqual({ connectionId: "prod", database: "shop" });
  });

  it("drops a database selected for a different connection", () => {
    expect(buildEngineState(file("dev"), connections, { connectionId: "prod", database: "shop" })).toEqual({ connectionId: "dev" });
  });

  it("returns nothing without a usable connection, so the backend reports it", () => {
    expect(buildEngineState(file(), connections, undefined)).toBeUndefined();
  });
});

describe("readSelectedDatabase", () => {
  it("accepts only complete values", () => {
    expect(readSelectedDatabase({ connectionId: "c", database: "d" })).toEqual({ connectionId: "c", database: "d" });
    expect(readSelectedDatabase({ connectionId: "c", database: "" })).toBeUndefined();
    expect(readSelectedDatabase("x")).toBeUndefined();
    expect(readSelectedDatabase(undefined)).toBeUndefined();
  });
});
