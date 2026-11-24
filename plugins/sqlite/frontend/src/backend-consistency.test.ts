import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIALECT_ID, PLUGIN_ID } from "./constants.js";
import { SQLITE_DRIVER } from "./plugin.js";

// Node environment (not jsdom), so import.meta.url is a file URL
describe("sqlitePlugin", () => {
  it("uses the backend's plugin id, dialect id and driver class", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    const backend = new URL("../../backend/src/main/java/com/queryeer/plugin/jdbc/sqlite/", import.meta.url);
    const dialect = readFileSync(new URL("SqliteDialect.java", backend), "utf8");
    const contributor = readFileSync(new URL("SqliteDialectContributor.java", backend), "utf8");

    expect(manifest.id).toBe(PLUGIN_ID);
    expect(dialect).toContain(`DIALECT_ID = "${DIALECT_ID}"`);
    expect(contributor).toContain(`DRIVER_CLASS_NAME = "${SQLITE_DRIVER.driverClassName}"`);
  });
});
