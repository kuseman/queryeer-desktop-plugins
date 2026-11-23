import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { ExternalPlugin } from "@queryeer/api/plugin/PluginModule";
import { hostCopySecrets, isValidConnection, parseConnections } from "./connections.js";
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
import { registerPayloadbuilderCatalog } from "./payloadbuilderCatalog.js";
import { pluginBackend, type PluginBackend } from "./pluginBackend.js";
import styles from "./styles.css";

const STYLE_ELEMENT_ID = "com-queryeer-kafka-styles";

/** Registrations to undo on deactivate. */
let disposables: Disposable[] = [];

export const kafkaPlugin: ExternalPlugin = {
  manifest: {
    kind: "feature",
    // Payloadbuilder is optional: with it, the plugin's connections serve its kafka catalog
    dependencies: ["core.settings", { id: PAYLOADBUILDER_PLUGIN_ID, optional: true }]
  },

  activate: (context) => {
    const backend = pluginBackend(context);
    injectStyles();
    registerSettings(context, backend);
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
    validate: ({ value }) => {
      if (!Array.isArray(value)) {
        return { ok: false, message: "Expected a list of connections" };
      }
      const parsed = parseConnections(value);
      if (parsed.length !== value.length) {
        return { ok: false, message: "Every connection needs a unique ID and bootstrap servers" };
      }
      const invalid = parsed.find((connection) => !isValidConnection(connection));
      return invalid ? { ok: false, message: `Connection "${invalid.title ?? invalid.bootstrapServers}" has errors` } : { ok: true };
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
        copySecrets={hostCopySecrets(context.settings)}
      />
    )
  });

  disposables.push(
    context.settings.registerSettings({
      moduleId: SETTINGS_MODULE_ID,
      title: "Kafka",
      order: 41,
      settings: [
        {
          id: CONNECTIONS_SETTING_ID,
          moduleId: SETTINGS_MODULE_ID,
          title: "Kafka Connections",
          description: "Kafka clusters for the payloadbuilder kafka catalog. Passwords and JAAS configurations are kept in the Queryeer vault.",
          sectionPath: ["Query Engine", "Kafka"],
          tags: ["kafka", "connection", "cluster"],
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
      title: "Manage Kafka Connections",
      category: "Preferences",
      handler: () => context.settings.open(CONNECTIONS_SETTING_ID)
    })
  );
}

/** Connects with the edited connection, saved or not; the backend resolves its vault secrets. */
export async function testConnection(backend: PluginBackend, connection: Record<string, unknown>): Promise<TestConnectionResult> {
  const result = await backend.invoke<{ ok?: boolean; clusterId?: string; brokers?: number; message?: string }>(
    ACTION_TEST_CONNECTION,
    { connection },
    { timeoutMs: TEST_CONNECTION_TIMEOUT_MS }
  );
  return result?.ok
    ? { ok: true, clusterId: result.clusterId, brokers: result.brokers }
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
