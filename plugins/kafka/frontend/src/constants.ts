// Shared identifiers. The backend uses the same values (KafkaBackendPlugin, KafkaConnectionSettings, PayloadbuilderKafkaCatalogProvider).

export const PLUGIN_ID = "com.queryeer.kafka";

export const SETTINGS_MODULE_ID = `${PLUGIN_ID}.connections`;
export const CONNECTIONS_SETTING_ID = `${SETTINGS_MODULE_ID}.list`;
export const CONNECTIONS_RENDERER_ID = `${CONNECTIONS_SETTING_ID}.renderer`;
export const CONNECTIONS_VALIDATOR_ID = `${CONNECTIONS_SETTING_ID}.validator`;

export const OPEN_CONNECTIONS_COMMAND_ID = `${PLUGIN_ID}.openConnectionsSettings`;

/** The plugin's own backend actions (`context.backend.invoke`), not payloadbuilder's: they work without it. */
export const ACTION_LIST_TOPICS = "topics.list";
export const ACTION_TEST_CONNECTION = "connection.test";
/** The backend waits 30 s for the topics and 10 s for a test; the frontend waits a little longer, so the backend's message wins. */
export const LIST_TOPICS_TIMEOUT_MS = 35_000;
export const TEST_CONNECTION_TIMEOUT_MS = 15_000;

/** The frontend plugin of Queryeer's payloadbuilder engine; an optional dependency of this plugin. */
export const PAYLOADBUILDER_PLUGIN_ID = "core.queryengine.payloadbuilder";
/** The same id as Queryeer's built-in catalog, so files that use it keep working; this one replaces it. */
export const KAFKA_CATALOG_ID = "kafka";
