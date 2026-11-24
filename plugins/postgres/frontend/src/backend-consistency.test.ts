import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIALECT_ID, PLUGIN_ID, POSTGRES_DRIVER } from "./plugin.js";

describe("postgresPlugin", () => {
  it("uses the backend's plugin id, dialect id and driver class", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    const backend = new URL("../../backend/src/main/java/com/queryeer/plugin/jdbc/postgres/", import.meta.url);
    const dialect = readFileSync(new URL("PostgresDialect.java", backend), "utf8");
    const contributor = readFileSync(new URL("PostgresDialectContributor.java", backend), "utf8");

    expect(manifest.id).toBe(PLUGIN_ID);
    expect(dialect).toContain(`DIALECT_ID = "${DIALECT_ID}"`);
    expect(contributor).toContain(`DRIVER_CLASS_NAME = "${POSTGRES_DRIVER.driverClassName}"`);
  });
});
