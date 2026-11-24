// Shared identifiers. The backend uses the same values (ElasticsearchBackendPlugin, ElasticsearchConnectionSettings, PayloadbuilderElasticsearchCatalogProvider).

export const PLUGIN_ID = "com.queryeer.elasticsearch";

export const SETTINGS_MODULE_ID = `${PLUGIN_ID}.connections`;
export const CONNECTIONS_SETTING_ID = `${SETTINGS_MODULE_ID}.list`;
export const CONNECTIONS_RENDERER_ID = `${CONNECTIONS_SETTING_ID}.renderer`;
export const CONNECTIONS_VALIDATOR_ID = `${CONNECTIONS_SETTING_ID}.validator`;

export const OPEN_CONNECTIONS_COMMAND_ID = `${PLUGIN_ID}.openConnectionsSettings`;

/** The plugin's own backend actions (`context.backend.invoke`), not payloadbuilder's: they work without it. */
export const ACTION_LIST_INDICES = "indices.list";
export const ACTION_TEST_CONNECTION = "connection.test";
/**
 * The backend waits for the connection's own timeouts, or 10 s to connect and 30 s for an answer; the frontend waits a
 * little longer, so the backend's message wins in the usual case.
 */
export const LIST_INDICES_TIMEOUT_MS = 125_000;
export const TEST_CONNECTION_TIMEOUT_MS = 45_000;

/** The frontend plugin of Queryeer's payloadbuilder engine; an optional dependency of this plugin. */
export const PAYLOADBUILDER_PLUGIN_ID = "core.queryengine.payloadbuilder";
/** The same id as Queryeer's built-in catalog, so files that use it keep working; this one replaces it. */
export const ELASTICSEARCH_CATALOG_ID = "elasticsearch";

/** Queryeer's built-in Elasticsearch connections, copied once into this plugin's settings (migration.ts). */
export const LEGACY_SETTINGS_MODULE_ID = "core.queryengine.payloadbuilder.elasticsearch";
export const LEGACY_CONNECTIONS_SETTING_ID = `${LEGACY_SETTINGS_MODULE_ID}.connections`;
export const MIGRATION_ID = "connections-from-core.v1";
