import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { DIALECT_ID, MARIADB_DRIVER, mysqlPlugin, PLUGIN_ID } from "./plugin.js";

describe("mysqlPlugin", () => {
  it("registers MariaDB Connector/J for the mysql dialect", () => {
    const registerDriver = vi.fn();
    const context = { jdbcDrivers: { registerDriver } } as unknown as PluginContext;

    void mysqlPlugin.activate(context);

    expect(registerDriver).toHaveBeenCalledWith(MARIADB_DRIVER);
    expect(MARIADB_DRIVER.downloadPageUrl).toMatch(/^https:\/\//);
  });

  it("uses the backend's plugin id, dialect id and driver class", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    const dialect = readFileSync(
      new URL("../../backend/src/main/java/com/queryeer/plugin/jdbc/mysql/MySqlDialect.java", import.meta.url),
      "utf8"
    );

    expect(mysqlPlugin.manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(mysqlPlugin.manifest.version);
    expect(dialect).toContain(`DIALECT_ID = "${DIALECT_ID}"`);
    expect(dialect).toContain(`DRIVER_CLASS_NAME = "${MARIADB_DRIVER.driverClassName}"`);
  });
});
