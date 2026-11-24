import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { parseConnection, parseConnections, serializeConnection, type ElasticsearchConnection } from "./connections.js";
import { CONNECTIONS_SETTING_ID, LEGACY_CONNECTIONS_SETTING_ID, LEGACY_SETTINGS_MODULE_ID, MIGRATION_ID } from "./constants.js";

/**
 * Copies Queryeer's built-in Elasticsearch connections into the plugin's settings, once per installation
 * (DEVELOPMENT-PLUGIN.md §7.7.1).
 *
 * - Connection ids stay the same, so files that use the `elasticsearch` catalog keep their connection.
 * - Each password gets its own vault entry (`copySecrets`): the built-in connection keeps its own, and editing one never
 *   changes the other. This works while the vault is locked.
 * - A password stored as plain text, not in the vault, isn't copied: the plugin never keeps one in settings.
 * - Connections the plugin already has (by id) are skipped, so a run that failed half-way can run again.
 * - Queryeer's own settings are left as they are.
 */
export function registerMigration(settings: PluginContext["settings"]): void {
  settings.runOnce(MIGRATION_ID, () => migrateConnections(settings));
}

export async function migrateConnections(settings: PluginContext["settings"]): Promise<void> {
  const legacyValues = await settings.readModuleValues(LEGACY_SETTINGS_MODULE_ID);
  const legacy = legacyValues[LEGACY_CONNECTIONS_SETTING_ID];
  if (!Array.isArray(legacy) || legacy.length === 0) {
    return;
  }
  const current = parseConnections(settings.getValue(CONNECTIONS_SETTING_ID));
  const known = new Set(current.map((connection) => connection.connectionId));
  const toMigrate: ElasticsearchConnection[] = [];
  for (const entry of legacy) {
    const connection = parseConnection(entry);
    if (connection && !known.has(connection.connectionId)) {
      known.add(connection.connectionId);
      toMigrate.push(connection);
    }
  }
  if (toMigrate.length === 0) {
    return;
  }
  // A copy that fails (no such vault entry) leaves the password empty
  const migrated = await settings.copySecrets(toMigrate);
  const result = await settings.setValue(CONNECTIONS_SETTING_ID, [...current, ...migrated].map(serializeConnection));
  if (!result.ok) {
    // Runs again on the next start
    throw new Error(`Could not save the migrated Elasticsearch connections: ${result.message}`);
  }
}
