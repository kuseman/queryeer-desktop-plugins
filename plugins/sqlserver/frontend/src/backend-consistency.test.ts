import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIALECT_ID, PLUGIN_ID, SQLSERVER_DRIVER } from "./plugin.js";

describe("sqlServerPlugin", () => {
  it("uses the backend's plugin id, dialect id, driver class and plan option", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    const backend = new URL("../../backend/src/main/java/com/queryeer/plugin/jdbc/sqlserver/", import.meta.url);
    const dialect = readFileSync(new URL("SqlServerDialect.java", backend), "utf8");
    const contributor = readFileSync(new URL("SqlServerDialectContributor.java", backend), "utf8");
    const executor = readFileSync(new URL("SqlServerQueryExecutor.java", backend), "utf8");

    expect(manifest.id).toBe(PLUGIN_ID);
    expect(dialect).toContain(`DIALECT_ID = "${DIALECT_ID}"`);
    expect(contributor).toContain(`DRIVER_CLASS_NAME = "${SQLSERVER_DRIVER.driverClassName}"`);
    expect(executor).toContain(`.get("sqlserverPlanXmlOutput")`);
    // Its packages load parent-first and its native authentication library is preloaded: Windows authentication
    expect(manifest.runtime.shared.parentFirstPackagePrefixes).toEqual(["com.microsoft.sqlserver.jdbc."]);
    expect(manifest.runtime.shared.nativeLibraries[0].filePatterns).toContain("mssql-jdbc_auth*.dll");
  });
});
