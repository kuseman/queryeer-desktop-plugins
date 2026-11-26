import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  DIALECT_ID,
  LEGACY_PLAN_XML_OUTPUT_SETTING_ID,
  LEGACY_SETTINGS_MODULE_ID,
  MIGRATION_ID,
  migratePlanXmlOutput,
  PLAN_XML_OUTPUT_SETTING_ID,
  PLUGIN_ID,
  SETTINGS_MODULE_ID,
  SQLSERVER_DRIVER,
  sqlServerPlugin
} from "./plugin.js";

type ExecutionContextProvider = (params: { fileId?: string; options?: { dialectOptions?: Record<string, unknown> } }) => unknown;

function createContext(values: Record<string, unknown> = {}, files: Record<string, { metadata?: Record<string, unknown> }> = {}) {
  const dispose = vi.fn();
  const registration = vi.fn(() => ({ dispose }));
  const context = {
    jdbcDrivers: { registerDriver: vi.fn() },
    jdbcDialects: { registerDialect: vi.fn(() => ({ dispose })) },
    jdbcTreeActions: { registerTemplate: registration },
    symbolActions: { registerTemplate: vi.fn(() => ({ dispose })) },
    whenExpressions: { registerTemplates: vi.fn(() => ({ dispose })) },
    queryEngines: { registerExecutionContextProvider: vi.fn((_engineId: string, _provider: ExecutionContextProvider) => ({ dispose })) },
    files: { getFile: vi.fn((fileId: string) => files[fileId]) },
    settings: {
      registerSettings: vi.fn(() => ({ dispose })),
      getValue: vi.fn((settingId: string) => values[settingId]),
      setValue: vi.fn(async (settingId: string, value: unknown) => {
        values[settingId] = value;
        return { ok: true as const };
      }),
      readModuleValues: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
      runOnce: vi.fn()
    }
  };
  return { context, pluginContext: context as unknown as PluginContext, dispose };
}

describe("sqlServerPlugin", () => {
  it("registers Microsoft's driver with its version-locked Windows authentication library", () => {
    const { context, pluginContext } = createContext();

    void sqlServerPlugin.activate(pluginContext);

    expect(context.jdbcDrivers.registerDriver).toHaveBeenCalledWith(SQLSERVER_DRIVER);
    expect(SQLSERVER_DRIVER).toMatchObject({ groupId: "com.microsoft.sqlserver", artifactId: "mssql-jdbc", compatibleVersionRegex: "\\.jre11$" });
    expect(SQLSERVER_DRIVER.companionArtifacts).toEqual([
      expect.objectContaining({ id: "native-auth", kind: "nativeLibrary", targetDirectory: "libNative", versionLockedToDriver: true })
    ]);
  });

  it("turns on query plans and registers its templates under the plugin's id, for SQL Server connections only", () => {
    const { context, pluginContext } = createContext();

    void sqlServerPlugin.activate(pluginContext);

    expect(context.jdbcDialects.registerDialect).toHaveBeenCalledWith({ dialectId: DIALECT_ID, supportsQueryPlan: true });
    const treeActions = context.jdbcTreeActions.registerTemplate.mock.calls.map((call: unknown[]) => call[0] as { id: string; action: { when: string } });
    expect(treeActions.map((template) => template.id)).toEqual([
      `${PLUGIN_ID}.treeAction.definitionToText`,
      `${PLUGIN_ID}.treeAction.definitionToNewQuery`,
      `${PLUGIN_ID}.treeAction.help`,
      `${PLUGIN_ID}.treeAction.selectTop100`
    ]);
    expect(treeActions.every((template) => template.action.when.startsWith(`node.dialectId == '${DIALECT_ID}'`))).toBe(true);
    expect(context.symbolActions.registerTemplate).toHaveBeenCalledWith(expect.objectContaining({
      id: `${PLUGIN_ID}.symbolAction.describe`,
      action: expect.objectContaining({ query: expect.stringContaining("fn.sqlserver.identifier") })
    }));
    expect(context.whenExpressions.registerTemplates).toHaveBeenCalledWith([
      expect.objectContaining({ when: expect.stringContaining(`dialectId == '${DIALECT_ID}'`) })
    ]);
  });

  it("sends the plan XML setting with a SQL Server file's queries only", () => {
    const values: Record<string, unknown> = { [PLAN_XML_OUTPUT_SETTING_ID]: "include" };
    const files = {
      sqlserver: { metadata: { "core.queryengine.jdbc.dialectId": DIALECT_ID } },
      postgres: { metadata: { "core.queryengine.jdbc.dialectId": "postgres" } }
    };
    const { context, pluginContext } = createContext(values, files);

    void sqlServerPlugin.activate(pluginContext);
    const [engineId, provider] = context.queryEngines.registerExecutionContextProvider.mock.calls[0];

    expect(engineId).toBe("jdbc");
    expect(provider({ fileId: "sqlserver", options: { dialectOptions: { other: 1 } } })).toEqual({
      options: { dialectOptions: { other: 1, sqlserverPlanXmlOutput: "include" } }
    });
    expect(provider({ fileId: "postgres" })).toBeUndefined();
    expect(provider({})).toBeUndefined();
    values[PLAN_XML_OUTPUT_SETTING_ID] = undefined;
    expect(provider({ fileId: "sqlserver" })).toEqual({ options: { dialectOptions: { sqlserverPlanXmlOutput: "suppress" } } });
  });

  it("registers the plan XML setting in its own settings module, and the move of the old value once", () => {
    const { context, pluginContext } = createContext();

    void sqlServerPlugin.activate(pluginContext);

    expect(context.settings.registerSettings).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: SETTINGS_MODULE_ID,
      settings: [expect.objectContaining({ id: PLAN_XML_OUTPUT_SETTING_ID, moduleId: SETTINGS_MODULE_ID, defaultValue: "suppress" })]
    }));
    expect(context.settings.runOnce).toHaveBeenCalledWith(MIGRATION_ID, expect.any(Function));
  });

  it("removes its registrations on deactivate", () => {
    const { pluginContext, dispose } = createContext();

    void sqlServerPlugin.activate(pluginContext);
    void sqlServerPlugin.deactivate?.();
    void sqlServerPlugin.deactivate?.();

    // Dialect, settings, 4 tree actions, 2 symbol actions, when-expressions, execution context provider
    expect(dispose).toHaveBeenCalledTimes(10);
  });
});

describe("migratePlanXmlOutput", () => {
  it("copies Queryeer's built-in 'include' to the plugin's setting", async () => {
    const values: Record<string, unknown> = {};
    const { context, pluginContext } = createContext(values);
    context.settings.readModuleValues.mockResolvedValue({ [LEGACY_PLAN_XML_OUTPUT_SETTING_ID]: "include" });

    await migratePlanXmlOutput(pluginContext.settings);

    expect(context.settings.readModuleValues).toHaveBeenCalledWith(LEGACY_SETTINGS_MODULE_ID);
    expect(values[PLAN_XML_OUTPUT_SETTING_ID]).toBe("include");
  });

  it("leaves the default alone when there is nothing to copy", async () => {
    for (const legacy of [{}, { [LEGACY_PLAN_XML_OUTPUT_SETTING_ID]: "suppress" }]) {
      const { context, pluginContext } = createContext();
      context.settings.readModuleValues.mockResolvedValue(legacy);

      await migratePlanXmlOutput(pluginContext.settings);

      expect(context.settings.setValue).not.toHaveBeenCalled();
    }
  });

  it("fails, to run again on the next start, when the value can't be saved", async () => {
    const { context, pluginContext } = createContext();
    context.settings.readModuleValues.mockResolvedValue({ [LEGACY_PLAN_XML_OUTPUT_SETTING_ID]: "include" });
    context.settings.setValue.mockResolvedValue({ ok: false, message: "settings are read-only" } as never);

    await expect(migratePlanXmlOutput(pluginContext.settings)).rejects.toThrow("settings are read-only");
  });
});
