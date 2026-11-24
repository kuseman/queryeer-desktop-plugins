import type { Disposable } from "@queryeer/api/editor/EditorApi";
import { fileUriToPath } from "@queryeer/api/files/Resolvers";
import type { ExternalPlugin } from "@queryeer/api/plugin/PluginModule";
import type { JdbcManagedDriverContribution } from "@queryeer/api/queryengine/JdbcDriverExtension";
import { DIALECT_ID, PLUGIN_ID, SQLITE_EXTENSIONS, SQLITE_MIME_TYPE } from "./constants.js";
import { SqliteWelcomeEditor } from "./SqliteWelcomeEditor.js";
import styles from "./styles.css";

export { DIALECT_ID, PLUGIN_ID, SQLITE_EXTENSIONS, SQLITE_MIME_TYPE } from "./constants.js";

const STYLE_ELEMENT_ID = `${PLUGIN_ID}.styles`;

/** xerial's sqlite-jdbc, with SQLite's native library inside. Never bundled: core downloads it after the user confirms. */
export const SQLITE_DRIVER: JdbcManagedDriverContribution = {
  dialectId: DIALECT_ID,
  displayName: "SQLite JDBC Driver",
  groupId: "org.xerial",
  artifactId: "sqlite-jdbc",
  driverClassName: "org.sqlite.JDBC",
  downloadPageUrl: "https://github.com/xerial/sqlite-jdbc/releases"
};

let disposables: Disposable[] = [];

/**
 * Registers the driver, SQLite's file type, and the screen an opened database file shows (create a connection to it, or
 * open a query file for the one there is). The connection form comes from the backend's `connectionSetup()` fields,
 * with a browse button for the file, and the database tree from its schema resolvers.
 */
export const sqlitePlugin: ExternalPlugin = {
  manifest: {
    kind: "feature",
    dependencies: ["core.queryengine.jdbc"]
  },

  activate: (context) => {
    context.jdbcDrivers.registerDriver(SQLITE_DRIVER);
    injectStyles();
    const { files } = context;
    disposables = [
      files.registerMimeResolver((_uri, hint) => {
        const extension = hint?.extension?.toLowerCase();
        return extension && SQLITE_EXTENSIONS.includes(extension) ? SQLITE_MIME_TYPE : undefined;
      }),
      files.capabilities.registerCapabilities(SQLITE_MIME_TYPE, []),
      files.capabilities.registerContentCategory(SQLITE_MIME_TYPE, "binary"),
      ...(files.capabilities.registerLabel ? [files.capabilities.registerLabel(SQLITE_MIME_TYPE, "SQLite Database")] : []),
      context.layout.registerEditor({
        id: `${PLUGIN_ID}.welcome`,
        title: "SQLite Database",
        order: 100,
        supportedMimeTypes: [SQLITE_MIME_TYPE],
        openIntents: ["view", "edit"],
        priority: 10,
        render: (renderContext) => {
          const file = renderContext?.activeFile;
          return file ? (
            <SqliteWelcomeEditor
              key={file.fileId}
              fileId={file.fileId}
              filePath={fileUriToPath(file.uri)}
              settings={context.settings}
              fileMediator={context.fileMediator}
            />
          ) : null;
        }
      })
    ];
  },

  deactivate: () => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
};

function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = styles;
  document.head.appendChild(style);
}
