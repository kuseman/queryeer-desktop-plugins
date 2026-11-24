import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { PluginBackend } from "@queryeer/api/plugin/PluginBackend";
import type { ExternalPlugin } from "@queryeer/api/plugin/PluginModule";
import { parseConnections } from "./connections.js";
import { ConnectionsSettingsEditor, type TestConnectionResult } from "./ConnectionsSettingsEditor.js";
import {
  ACTION_TEST_CONNECTION,
  CONNECTIONS_RENDERER_ID,
  CONNECTIONS_SETTING_ID,
  CONNECTIONS_VALIDATOR_ID,
  OPEN_CONNECTIONS_COMMAND_ID,
  PAYLOADBUILDER_PLUGIN_ID,
  SETTINGS_MODULE_ID,
  TEST_CONNECTION_TIMEOUT_MS
} from "./constants.js";
import { registerMigration } from "./migration.js";
import { registerPayloadbuilderCatalog } from "./payloadbuilderCatalog.js";
import styles from "./styles.css";

const STYLE_ELEMENT_ID = "com-queryeer-elasticsearch-styles";

/** Registrations to undo on deactivate. */
let disposables: Disposable[] = [];

export const elasticsearchPlugin: ExternalPlugin = {
  manifest: {
    kind: "feature",
    // Payloadbuilder is optional: with it, the plugin's connections serve its elasticsearch catalog
    dependencies: ["core.settings", { id: PAYLOADBUILDER_PLUGIN_ID, optional: true }]
  },

  activate: (context) => {
    const backend = context.backend;
    injectStyles();
    registerSettings(context, backend);
    // After the settings, so they are loaded when it runs
    registerMigration(context.settings);
    const catalog = registerPayloadbuilderCatalog(context, backend);
    if (catalog) {
      disposables.push(catalog);
    }
  },

  deactivate: () => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
    disposables = [];
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
};

function registerSettings(context: PluginContext, backend: PluginBackend): void {
  context.settings.registerAdvancedValidator({
    id: CONNECTIONS_VALIDATOR_ID,
    // Only the structure: a field problem (an endpoint without http://, say) shows in the editor. Rejecting it here
    // would also reject a migrated connection, and the migration would fail on every start.
    validate: ({ value }) => {
      if (!Array.isArray(value)) {
        return { ok: false, message: "Expected a list of connections" };
      }
      return parseConnections(value).length === value.length ? { ok: true } : { ok: false, message: "Every connection needs a unique ID and an endpoint" };
    }
  });

  context.settings.registerAdvancedRenderer({
    id: CONNECTIONS_RENDERER_ID,
    render: ({ value, setValue, readonly }) => (
      <ConnectionsSettingsEditor
        value={value}
        setValue={setValue}
        readonly={readonly}
        components={context.components}
        testConnection={(connection) => testConnection(backend, connection)}
        copySecrets={context.settings.copySecrets.bind(context.settings)}
      />
    )
  });

  disposables.push(
    context.settings.registerSettings({
      moduleId: SETTINGS_MODULE_ID,
      title: "Elasticsearch",
      order: 42,
      settings: [
        {
          id: CONNECTIONS_SETTING_ID,
          moduleId: SETTINGS_MODULE_ID,
          title: "Elasticsearch Connections",
          description: "Elasticsearch clusters for the payloadbuilder elasticsearch catalog. Passwords are kept in the Queryeer vault.",
          sectionPath: ["Query Engine", "Elasticsearch"],
          tags: ["elasticsearch", "connection", "cluster"],
          type: "json",
          defaultValue: [],
          advanced: { rendererId: CONNECTIONS_RENDERER_ID, validatorId: CONNECTIONS_VALIDATOR_ID }
        }
      ]
    })
  );

  disposables.push(
    context.commands.registerCommand({
      id: OPEN_CONNECTIONS_COMMAND_ID,
      title: "Manage Elasticsearch Connections",
      category: "Preferences",
      handler: () => context.settings.open(CONNECTIONS_SETTING_ID)
    })
  );
}

/** Connects with the edited connection, saved or not; the backend resolves its vault secret. */
export async function testConnection(backend: PluginBackend, connection: Record<string, unknown>): Promise<TestConnectionResult> {
  const result = await backend.invoke<{ ok?: boolean; clusterName?: string; version?: string; message?: string }>(
    ACTION_TEST_CONNECTION,
    { connection },
    { timeoutMs: TEST_CONNECTION_TIMEOUT_MS }
  );
  return result?.ok
    ? { ok: true, clusterName: result.clusterName, version: result.version }
    : { ok: false, message: result?.message ?? "Connection failed" };
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = styles;
  document.head.appendChild(style);
}
