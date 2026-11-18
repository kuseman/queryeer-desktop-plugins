import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  DIALECT_ID,
  MARIADB_DRIVER,
  mysqlPlugin,
  PLUGIN_ID,
  SYMBOL_ACTION_TEMPLATES,
  TREE_ACTION_TEMPLATES,
  WHEN_EXPRESSION_TEMPLATES
} from "./plugin.js";

function createContext() {
  const dispose = vi.fn();
  const context = {
    jdbcDrivers: { registerDriver: vi.fn() },
    jdbcTreeActions: { registerTemplate: vi.fn(() => ({ dispose })) },
    symbolActions: { registerTemplate: vi.fn(() => ({ dispose })) },
    whenExpressions: { registerTemplates: vi.fn(() => ({ dispose })), registerVariables: vi.fn(() => ({ dispose })) }
  };
  return { context, pluginContext: context as unknown as PluginContext, dispose };
}

/** What the expression runtime does with `${…}` in a query, for the plain property paths these templates use. */
function render(query: string, values: Record<string, unknown>): string {
  return query.replace(/\$\{([^}]+)\}/g, (_match, path: string) =>
    String(path.trim().split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], values)));
}

describe("mysqlPlugin", () => {
  it("registers MariaDB Connector/J for the mysql dialect", () => {
    const { context, pluginContext } = createContext();

    void mysqlPlugin.activate(pluginContext);

    expect(context.jdbcDrivers.registerDriver).toHaveBeenCalledWith(MARIADB_DRIVER);
    expect(MARIADB_DRIVER.downloadPageUrl).toMatch(/^https:\/\//);
  });

  it("offers its action and when-expression templates through the public registries, and removes them on deactivate", () => {
    const { context, pluginContext, dispose } = createContext();

    void mysqlPlugin.activate(pluginContext);

    for (const template of TREE_ACTION_TEMPLATES) {
      expect(context.jdbcTreeActions.registerTemplate).toHaveBeenCalledWith(template);
    }
    for (const template of SYMBOL_ACTION_TEMPLATES) {
      expect(context.symbolActions.registerTemplate).toHaveBeenCalledWith(template);
    }
    expect(context.whenExpressions.registerTemplates).toHaveBeenCalledWith(WHEN_EXPRESSION_TEMPLATES);

    void mysqlPlugin.deactivate?.();
    expect(dispose).toHaveBeenCalledTimes(TREE_ACTION_TEMPLATES.length + SYMBOL_ACTION_TEMPLATES.length + 1);
  });

  it("only offers its templates for MySQL nodes and files", () => {
    for (const template of TREE_ACTION_TEMPLATES) {
      expect(template.action.when).toContain(`node.dialectId == '${DIALECT_ID}'`);
    }
    for (const template of [...SYMBOL_ACTION_TEMPLATES.map((t) => t.action), ...WHEN_EXPRESSION_TEMPLATES]) {
      expect(template.when).toContain(`activeFile.metadata.core.queryengine.jdbc?.dialectId == '${DIALECT_ID}'`);
    }
  });

  it("quotes the tree node's database and name for MySQL", () => {
    const node = { kind: "view", name: "open orders", attributes: { catalog: "shop" } };
    const [selectTop100, showCreate] = TREE_ACTION_TEMPLATES;

    expect(render(selectTop100.action.query, { node })).toBe("select * from `shop`.`open orders` limit 100");
    expect(render(showCreate.action.query, { node })).toBe("show create view `shop`.`open orders`");
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
