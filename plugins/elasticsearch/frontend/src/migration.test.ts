import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { CONNECTIONS_SETTING_ID, LEGACY_CONNECTIONS_SETTING_ID, LEGACY_SETTINGS_MODULE_ID, MIGRATION_ID } from "./constants.js";
import { migrateConnections, registerMigration } from "./migration.js";

type Settings = PluginContext["settings"];

/** The settings calls the migration makes: Queryeer's old module, the plugin's own setting, and a vault that copies refs. */
function settings(legacy: unknown, current: unknown = [], saveResult: { ok: true } | { ok: false; message: string } = { ok: true }) {
  const stored: { value: unknown } = { value: current };
  const readModuleValues = vi.fn(async (moduleId: string) => (moduleId === LEGACY_SETTINGS_MODULE_ID && legacy !== undefined ? { [LEGACY_CONNECTIONS_SETTING_ID]: legacy } : {}));
  const setValue = vi.fn(async (_settingId: string, value: unknown) => {
    if (saveResult.ok) {
      stored.value = value;
    }
    return saveResult;
  });
  // Copies every { secretRef } to a new ref; "missing" has no vault entry
  const copySecrets = async <T,>(value: T): Promise<T> =>
    JSON.parse(JSON.stringify(value), (_key, entry) =>
      entry && typeof entry === "object" && typeof entry.secretRef === "string" ? (entry.secretRef === "missing" ? undefined : { secretRef: `${entry.secretRef}-copy` }) : entry
    ) as T;
  const api = {
    readModuleValues,
    setValue,
    copySecrets,
    getValue: (settingId: string) => (settingId === CONNECTIONS_SETTING_ID ? stored.value : undefined),
    runOnce: vi.fn()
  } as unknown as Settings;
  return { api, stored, setValue, readModuleValues };
}

describe("migrateConnections", () => {
  it("copies Queryeer's connections with their ids, and gives each password its own vault entry", async () => {
    const { api, stored } = settings([
      { connectionId: "prod", title: "Production", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", authPassword: { secretRef: "pw" }, enabled: true },
      { connectionId: "local", endpoint: "http://localhost:9200", authType: "NONE", enabled: false }
    ]);

    await migrateConnections(api);

    expect(stored.value).toEqual([
      { connectionId: "prod", title: "Production", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", authPassword: { secretRef: "pw-copy" }, enabled: true },
      { connectionId: "local", endpoint: "http://localhost:9200", authType: "NONE", enabled: false }
    ]);
  });

  it("keeps the plugin's own connections and skips ones it already has, so a failed run can run again", async () => {
    const { api, stored } = settings(
      [
        { connectionId: "prod", endpoint: "https://old:9200", authType: "NONE" },
        { connectionId: "test", endpoint: "http://test:9200", authType: "NONE" }
      ],
      [{ connectionId: "prod", endpoint: "https://es:9200", authType: "NONE", trustCertificate: true, enabled: true }]
    );

    await migrateConnections(api);

    expect(stored.value).toEqual([
      { connectionId: "prod", endpoint: "https://es:9200", authType: "NONE", trustCertificate: true, enabled: true },
      { connectionId: "test", endpoint: "http://test:9200", authType: "NONE", enabled: true }
    ]);
  });

  it("leaves out a plain-text password and one whose vault entry is gone, but keeps the connection", async () => {
    const { api, stored } = settings([
      { connectionId: "plain", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", authPassword: "hunter2" },
      { connectionId: "gone", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", authPassword: { secretRef: "missing" } }
    ]);

    await migrateConnections(api);

    expect(stored.value).toEqual([
      { connectionId: "plain", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", enabled: true },
      { connectionId: "gone", endpoint: "https://es:9200", authType: "BASIC", authUsername: "app", enabled: true }
    ]);
    expect(JSON.stringify(stored.value)).not.toContain("hunter2");
  });

  it("skips entries without an id or endpoint, and saves nothing without connections to copy", async () => {
    const empty = settings(undefined);
    await migrateConnections(empty.api);
    expect(empty.setValue).not.toHaveBeenCalled();

    const incomplete = settings([{ connectionId: "noendpoint" }, "not a connection"]);
    await migrateConnections(incomplete.api);
    expect(incomplete.setValue).not.toHaveBeenCalled();

    const known = settings([{ connectionId: "prod", endpoint: "https://es:9200" }], [{ connectionId: "prod", endpoint: "https://es:9200" }]);
    await migrateConnections(known.api);
    expect(known.setValue).not.toHaveBeenCalled();
  });

  it("throws when the save fails, so it runs again on the next start", async () => {
    const { api } = settings([{ connectionId: "prod", endpoint: "https://es:9200" }], [], { ok: false, message: "disk full" });

    await expect(migrateConnections(api)).rejects.toThrow("Could not save the migrated Elasticsearch connections: disk full");
  });

  it("registers as a run-once task", () => {
    const { api } = settings([]);

    registerMigration(api);

    expect(api.runOnce).toHaveBeenCalledWith(MIGRATION_ID, expect.any(Function));
  });
});
