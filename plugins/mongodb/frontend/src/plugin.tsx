import type { Plugin, PluginContext } from "@queryeer/api/plugin/Plugin";
import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { CSSProperties } from "react";
import { buildEngineState, readSelectedDatabase, resolveConnection } from "./binding.js";
import { connectionFingerprint, isValidConnection, parseConnections } from "./connections.js";
import { ConnectionsSettingsEditor, type TestConnectionResult } from "./ConnectionsSettingsEditor.js";
import {
  ACTION_TEST_CONNECTION,
  CONNECTIONS_RENDERER_ID,
  CONNECTIONS_SETTING_ID,
  CONNECTIONS_VALIDATOR_ID,
  DATABASE_STATE_KEY,
  ENGINE_ID,
  FILE_EXTENSION,
  FILE_LABEL,
  MIME_TYPE,
  OPEN_CONNECTIONS_COMMAND_ID,
  PLUGIN_ID,
  SETTINGS_MODULE_ID
} from "./constants.js";
import { MongoIcon } from "./MongoIcon.js";
import { clearDatabaseCache, MongoConnectionView, MongoStatusLabel } from "./MongoConnectionView.js";
import { clearExplorerCache } from "./MongoExplorer.js";
import { registerGridActions } from "./gridActions.js";
import { MongoQueryBar } from "./MongoQueryBar.js";
import { MONGO_LANGUAGE_ID, mongoLanguage } from "./mongoLanguage.js";
import { mongoOutline } from "./mongoOutline.js";
import styles from "./styles.css";

const STYLE_ELEMENT_ID = "com-queryeer-mongodb-styles";

/** Registrations that return a Disposable. Several host APIs return nothing yet (API-GAPS.md F6) and live until restart. */
let disposables: Array<Disposable | (() => void)> = [];

export const mongoPlugin: Plugin = {
  manifest: {
    id: PLUGIN_ID,
    name: "MongoDB",
    version: "0.1.0",
    kind: "feature",
    description: "Native MongoDB query engine",
    dependencies: ["core.queryengine", "core.settings", "core.files"]
  },

  activate: (context) => {
    injectStyles();
    registerFileType(context);
    registerSettings(context);
    registerEngine(context);
  },

  deactivate: () => {
    for (const disposable of disposables) {
      if (typeof disposable === "function") {
        disposable();
      } else {
        disposable.dispose();
      }
    }
    disposables = [];
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
};

function registerFileType(context: PluginContext): void {
  const { files } = context;
  // No single "register file type" API yet (API-GAPS.md F4)
  files.registerMimeResolver((_uri, hint) => (hint?.extension?.toLowerCase() === FILE_EXTENSION ? MIME_TYPE : undefined));
  disposables.push(files.capabilities.registerCapabilities(MIME_TYPE, ["editable", "backupable", "creatable"]));
  files.capabilities.registerLabel?.(MIME_TYPE, FILE_LABEL);
  files.capabilities.registerPreferredExtension?.(MIME_TYPE, FILE_EXTENSION);
  files.capabilities.registerContentCategory(MIME_TYPE, "text");
  files.mimeIcons.registerMimeIcon({ moduleId: PLUGIN_ID, mimeType: MIME_TYPE, icon: MongoIcon });
  // Highlighting for both forms a .mongo file can hold: JSON command documents and shell statements
  disposables.push(context.editorLanguages.registerLanguage(mongoLanguage));
  disposables.push(context.editorLanguages.registerMimeType(MIME_TYPE, MONGO_LANGUAGE_ID));
  // One outline entry per statement, like core's JSON and SQL outlines (@outline-pattern needs core: API-GAPS.md F24)
  context.outline.registerOutlineProvider({ mimeType: MIME_TYPE, provider: mongoOutline });
}

function registerSettings(context: PluginContext): void {
  context.settings.registerAdvancedValidator({
    id: CONNECTIONS_VALIDATOR_ID,
    validate: ({ value }) => {
      if (!Array.isArray(value)) {
        return { ok: false, message: "Expected a list of connections" };
      }
      const parsed = parseConnections(value);
      if (parsed.length !== value.length) {
        return { ok: false, message: "Every connection needs a unique ID and at least one host" };
      }
      const invalid = parsed.find((connection) => !isValidConnection(connection));
      return invalid ? { ok: false, message: `Connection "${invalid.title ?? invalid.hosts}" has errors` } : { ok: true };
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
        testConnection={(connection) => testConnection(context, connection)}
      />
    )
  });

  context.settings.registerSettings({
    moduleId: SETTINGS_MODULE_ID,
    title: "MongoDB",
    order: 40,
    settings: [
      {
        id: CONNECTIONS_SETTING_ID,
        moduleId: SETTINGS_MODULE_ID,
        title: "MongoDB Connections",
        description: "Connections for MongoDB query files. Passwords are kept in the Queryeer vault.",
        sectionPath: ["Query Engine", "MongoDB"],
        tags: ["mongodb", "connection", "database"],
        type: "json",
        defaultValue: [],
        advanced: { rendererId: CONNECTIONS_RENDERER_ID, validatorId: CONNECTIONS_VALIDATOR_ID }
      }
    ]
  });

  // Cached database lists may be stale once connection details change (not for a new title or color)
  let lastConnections = connectionFingerprint(context.settings.getValue(CONNECTIONS_SETTING_ID));
  disposables.push(
    context.settings.subscribe(() => {
      const next = connectionFingerprint(context.settings.getValue(CONNECTIONS_SETTING_ID));
      if (next !== lastConnections) {
        lastConnections = next;
        clearDatabaseCache();
        clearExplorerCache();
      }
    })
  );
}

function registerEngine(context: PluginContext): void {
  context.commands.registerCommand({
    id: OPEN_CONNECTIONS_COMMAND_ID,
    title: "Manage MongoDB Connections",
    category: "Preferences",
    handler: () => context.settings.open(CONNECTIONS_SETTING_ID)
  });

  disposables.push(context.queryEngines.registerEngine({ engineId: ENGINE_ID, mimeTypes: [MIME_TYPE] }));

  // Every execution (and file-scoped invoke) carries the file's connection and selected database, like JDBC.
  // The backend trusts engineState over its file session, which is not updated on rebind (API-GAPS.md B1).
  disposables.push(
    context.queryEngines.registerExecutionContextProvider(ENGINE_ID, ({ fileId }) => {
      const file = fileId ? context.files.getFile(fileId) : undefined;
      const engineState = buildEngineState(
        file,
        parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)),
        file ? readSelectedDatabase(context.files.getEditorState(file.fileId, DATABASE_STATE_KEY)) : undefined
      );
      return engineState ? { engineState } : undefined;
    })
  );

  // Connection and database pickers: a sidebar view shown only for MongoDB files, like JDBC's "SQL Databases" view
  context.layout.registerView({
    id: `${PLUGIN_ID}.navigation`,
    title: "MongoDB",
    defaultZone: "primarySidebar",
    order: 31,
    canMoveZones: true,
    canCollapse: true,
    flex: 1,
    minHeight: 120,
    when: `activeFile?.mimeType == '${MIME_TYPE}'`,
    panelActions: [
      { id: `${PLUGIN_ID}.navigation.settings`, icon: "⚙", title: "Manage MongoDB connections", commandId: OPEN_CONNECTIONS_COMMAND_ID }
    ],
    render: ({ activeFile }) => <MongoConnectionView context={context} file={activeFile} />
  });

  // Query bar in the query editor's header strip
  disposables.push(
    context.queryEngines.registerEditorHeaderItem({
      id: `${PLUGIN_ID}.queryBar`,
      engineId: ENGINE_ID,
      title: "Query",
      order: 0,
      render: ({ fileId, file }) => (file?.mimeType === MIME_TYPE ? <MongoQueryBar context={context} fileId={fileId} /> : null)
    })
  );

  // Result grid: filter by a cell's value, copy values and documents as Extended JSON
  disposables.push(registerGridActions(context));

  // Read-only "connection | database" in the query editor status bar, like JDBC's
  disposables.push(
    context.queryEngines.registerEditorStatusItem({
      id: `${PLUGIN_ID}.status`,
      engineId: ENGINE_ID,
      alignment: "right",
      order: 100,
      render: ({ file }) => <MongoStatusLabel context={context} file={file} />
    })
  );

  // The connection's color as an accent on its tabs, like JDBC's
  context.layout.registerTabHeaderStyle({
    id: `${PLUGIN_ID}.tabHeaderStyle.connectionColor`,
    order: 60,
    render: ({ file }) => {
      if (file.engineBinding?.engineId !== ENGINE_ID) {
        return null;
      }
      const color = resolveConnection(file, parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)))?.color;
      return color ? { className: "qmongo-tab-accent", style: { "--qmongo-tab-accent-color": color } as CSSProperties } : null;
    }
  });
}

async function testConnection(context: PluginContext, connection: Record<string, unknown>): Promise<TestConnectionResult> {
  const result = await context.queryEngines.invoke<{ ok?: boolean; version?: string; message?: string }>({
    engineId: ENGINE_ID,
    action: ACTION_TEST_CONNECTION,
    payload: { connection }
  });
  return result?.ok ? { ok: true, version: result.version ?? "unknown" } : { ok: false, message: result?.message ?? "Connection failed" };
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
