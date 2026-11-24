// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { PLUGIN_ID, SQLITE_DRIVER, SQLITE_MIME_TYPE, sqlitePlugin } from "./plugin.js";

function createContext() {
  const dispose = vi.fn();
  const registration = vi.fn(() => ({ dispose }));
  const context = {
    jdbcDrivers: { registerDriver: vi.fn() },
    layout: { registerEditor: vi.fn(() => ({ dispose })) },
    files: {
      registerMimeResolver: vi.fn(() => ({ dispose })),
      capabilities: {
        registerCapabilities: registration,
        registerContentCategory: registration,
        registerLabel: registration
      }
    }
  };
  return { context, pluginContext: context as unknown as PluginContext, dispose };
}

describe("sqlitePlugin", () => {
  it("registers sqlite-jdbc for the sqlite dialect", () => {
    const { context, pluginContext } = createContext();

    void sqlitePlugin.activate(pluginContext);

    expect(context.jdbcDrivers.registerDriver).toHaveBeenCalledWith(SQLITE_DRIVER);
    expect(SQLITE_DRIVER.downloadPageUrl).toMatch(/^https:\/\//);
  });

  it("resolves SQLite's file extensions, in any case, to its MIME type", () => {
    const { context, pluginContext } = createContext();

    void sqlitePlugin.activate(pluginContext);
    const [[resolver]] = context.files.registerMimeResolver.mock.calls as unknown as [[(uri: string, hint?: { extension?: string }) => string | undefined]];

    expect(resolver("file:///data/shop.db", { extension: "db" })).toBe(SQLITE_MIME_TYPE);
    expect(resolver("file:///data/shop.SQLITE3", { extension: "SQLITE3" })).toBe(SQLITE_MIME_TYPE);
    expect(resolver("file:///data/shop.sql", { extension: "sql" })).toBeUndefined();
    expect(resolver("file:///data/shop")).toBeUndefined();
    expect(context.files.capabilities.registerContentCategory).toHaveBeenCalledWith(SQLITE_MIME_TYPE, "binary");
    expect(context.files.capabilities.registerLabel).toHaveBeenCalledWith(SQLITE_MIME_TYPE, "SQLite Database");
  });

  it("shows its welcome screen for SQLite files, styled once", () => {
    const { context, pluginContext } = createContext();

    void sqlitePlugin.activate(pluginContext);
    void sqlitePlugin.deactivate?.();
    void sqlitePlugin.activate(pluginContext);

    expect(context.layout.registerEditor).toHaveBeenLastCalledWith(expect.objectContaining({
      id: `${PLUGIN_ID}.welcome`,
      supportedMimeTypes: [SQLITE_MIME_TYPE]
    }));
    expect(document.querySelectorAll("style").length).toBe(1);
  });

  it("removes its registrations and styles on deactivate", () => {
    const { pluginContext, dispose } = createContext();

    void sqlitePlugin.activate(pluginContext);
    void sqlitePlugin.deactivate?.();

    expect(dispose).toHaveBeenCalledTimes(5);
    expect(document.querySelectorAll("style").length).toBe(0);
  });
});
