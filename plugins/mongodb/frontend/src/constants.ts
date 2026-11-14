// Shared identifiers. The backend uses the same values (MongoBackendPlugin, MongoConnectionSettings, MongoQueryEngineProvider).

export const PLUGIN_ID = "com.queryeer.mongodb";
export const ENGINE_ID = "mongodb";

export const MIME_TYPE = "application/vnd.queryeer.mongodb";
export const FILE_EXTENSION = "mongo";
export const FILE_LABEL = "MongoDB Query";

export const SETTINGS_MODULE_ID = `${PLUGIN_ID}.connections`;
export const CONNECTIONS_SETTING_ID = `${SETTINGS_MODULE_ID}.list`;
export const CONNECTIONS_RENDERER_ID = `${CONNECTIONS_SETTING_ID}.renderer`;
export const CONNECTIONS_VALIDATOR_ID = `${CONNECTIONS_SETTING_ID}.validator`;

export const OPEN_CONNECTIONS_COMMAND_ID = `${PLUGIN_ID}.openConnectionsSettings`;

/** Per-file editor state key holding the selected database ({@link SelectedDatabase}). */
export const DATABASE_STATE_KEY = `${PLUGIN_ID}.database`;

export const ACTION_DATABASES = "mongodb.databases";
export const ACTION_TEST_CONNECTION = "mongodb.testConnection";
export const ACTION_COLLECTIONS = "mongodb.collections";
export const ACTION_INDEXES = "mongodb.indexes";
export const ACTION_FIELDS = "mongodb.fields";
export const ACTION_VALUES = "mongodb.values";
export const ACTION_DOCUMENTS = "mongodb.documents";

/** Per-file editor state key holding the query bar's state and the text it last wrote ({@link StoredBar} in queryBarModel.ts). */
export const QUERY_BAR_STATE_KEY = `${PLUGIN_ID}.queryBar`;
