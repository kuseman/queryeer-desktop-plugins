import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { DIALECT_ID, PLUGIN_ID, POSTGRES_DRIVER, postgresPlugin } from "./plugin.js";

function createContext() {
  const dispose = vi.fn();
  const registration = vi.fn(() => ({ dispose }));
  const context = {
    jdbcDrivers: { registerDriver: vi.fn() },
    jdbcDialects: { registerDialect: vi.fn(() => ({ dispose })) },
    jdbcTreeActions: { registerTemplate: registration },
    symbolActions: { registerTemplate: vi.fn(() => ({ dispose })) },
    whenExpressions: { registerTemplates: vi.fn(() => ({ dispose })) },
    queryEngines: { registerExecutionContextProvider: vi.fn(() => ({ dispose })) }
  };
  return { context, pluginContext: context as unknown as PluginContext, dispose };
}

describe("postgresPlugin", () => {
  it("registers pgJDBC for the postgres dialect", () => {
    const { context, pluginContext } = createContext();

    void postgresPlugin.activate(pluginContext);

    expect(context.jdbcDrivers.registerDriver).toHaveBeenCalledWith(POSTGRES_DRIVER);
    expect(POSTGRES_DRIVER).toMatchObject({ groupId: "org.postgresql", artifactId: "postgresql" });
    expect(POSTGRES_DRIVER.downloadPageUrl).toMatch(/^https:\/\//);
  });

  it("turns on query plans, leaving the plan commands to core", () => {
    const { context, pluginContext } = createContext();

    void postgresPlugin.activate(pluginContext);

    expect(context.jdbcDialects.registerDialect).toHaveBeenCalledWith({ dialectId: DIALECT_ID, supportsQueryPlan: true });
    expect(context.queryEngines.registerExecutionContextProvider).not.toHaveBeenCalled();
  });

  it("registers its templates under the plugin's id, for postgres connections only", () => {
    const { context, pluginContext } = createContext();

    void postgresPlugin.activate(pluginContext);

    expect(context.jdbcTreeActions.registerTemplate).toHaveBeenCalledWith(expect.objectContaining({
      id: `${PLUGIN_ID}.treeAction.selectTop100`,
      action: expect.objectContaining({ when: expect.stringContaining(`node.dialectId == '${DIALECT_ID}'`) })
    }));
    expect(context.symbolActions.registerTemplate).toHaveBeenCalledWith(expect.objectContaining({
      id: `${PLUGIN_ID}.symbolAction.describe`,
      action: expect.objectContaining({ query: expect.stringContaining("symbol.attributes.name") })
    }));
    expect(context.whenExpressions.registerTemplates).toHaveBeenCalledWith([
      expect.objectContaining({ when: expect.stringContaining(`dialectId == '${DIALECT_ID}'`) })
    ]);
  });

  it("removes its registrations on deactivate", () => {
    const { pluginContext, dispose } = createContext();

    void postgresPlugin.activate(pluginContext);
    void postgresPlugin.deactivate?.();
    void postgresPlugin.deactivate?.();

    expect(dispose).toHaveBeenCalledTimes(4);
  });
});
