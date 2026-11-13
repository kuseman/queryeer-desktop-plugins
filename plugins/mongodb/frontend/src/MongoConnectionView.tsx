import { useCallback, useEffect, useState } from "react";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { FileEntity } from "@queryeer/api/files/FileEntity";
import { readSelectedDatabase, resolveConnection, type SelectedDatabase } from "./binding.js";
import { connectionLabel, parseConnections, type MongoConnection } from "./connections.js";
import { ACTION_DATABASES, CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, ENGINE_ID } from "./constants.js";
import { MongoExplorer } from "./MongoExplorer.js";

type DatabaseList = { status: "loading" } | { status: "loaded"; names: string[] } | { status: "error"; message: string };

/** Database names per connection, shared by every open MongoDB file so switching tabs does not refetch. */
const databaseCache = new Map<string, DatabaseList>();
const cacheListeners = new Set<() => void>();

function setCached(connectionId: string, list: DatabaseList): void {
  databaseCache.set(connectionId, list);
  cacheListeners.forEach((listener) => listener());
}

/** Forgets cached database lists, e.g. after connection settings changed. */
export function clearDatabaseCache(): void {
  databaseCache.clear();
  cacheListeners.forEach((listener) => listener());
}

async function loadDatabases(context: PluginContext, fileId: string, connectionId: string, interactive: boolean): Promise<void> {
  setCached(connectionId, { status: "loading" });
  try {
    const names = await context.queryEngines.invoke<unknown>(
      { engineId: ENGINE_ID, fileId, action: ACTION_DATABASES, payload: { connectionId } },
      // Silent on automatic loads so switching tabs never pops a vault prompt; the refresh button is interactive
      { silent: !interactive }
    );
    setCached(connectionId, { status: "loaded", names: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string").sort() : [] });
  } catch (error) {
    setCached(connectionId, { status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

/** Re-renders on settings, file and database-cache changes, and returns the current connection state for a file. */
function useMongoFileState(context: PluginContext, file: FileEntity | undefined): {
  current: FileEntity | undefined;
  connections: MongoConnection[];
  connection: MongoConnection | undefined;
  selectedDatabase: string;
  databases: DatabaseList | undefined;
  rerender: () => void;
} {
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const unsubscribeSettings = context.settings.subscribe(rerender);
    const unsubscribeFiles = context.files.subscribe(rerender);
    cacheListeners.add(rerender);
    return () => {
      unsubscribeSettings();
      unsubscribeFiles();
      cacheListeners.delete(rerender);
    };
  }, [context, rerender]);

  const connections = parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID));
  const current = file ? context.files.getFile(file.fileId) ?? file : undefined;
  const connection = resolveConnection(current, connections);
  const selected = current ? readSelectedDatabase(context.files.getEditorState(current.fileId, DATABASE_STATE_KEY)) : undefined;
  const selectedDatabase = selected && connection && selected.connectionId === connection.connectionId ? selected.database : "";
  const databases = connection ? databaseCache.get(connection.connectionId) : undefined;
  return { current, connections, connection, selectedDatabase, databases, rerender };
}

/**
 * Sidebar view shown for MongoDB query files (layout.registerView with a MIME `when` expression, like JDBC's "SQL Databases" view).
 * Holds the file's connection and database pickers and the explorer tree. The query bar is in the query editor's header.
 */
export function MongoConnectionView({ context, file }: { context: PluginContext; file: FileEntity | undefined }): JSX.Element {
  const { current, connections, connection, selectedDatabase, databases, rerender } = useMongoFileState(context, file);

  useEffect(() => {
    if (current && connection && !databaseCache.has(connection.connectionId)) {
      void loadDatabases(context, current.fileId, connection.connectionId, false);
    }
  }, [context, current?.fileId, connection?.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) {
    return <div className="qmongo-view qmongo-muted">Open a MongoDB query file.</div>;
  }

  const enabled = connections.filter((c) => c.enabled);
  if (enabled.length === 0) {
    return (
      <div className="qmongo-view">
        <div className="qmongo-muted">No MongoDB connections yet.</div>
        <button type="button" className="qmongo-button" onClick={() => context.settings.open(CONNECTIONS_SETTING_ID)}>
          Add connection…
        </button>
      </div>
    );
  }

  const onConnectionChange = (connectionId: string): void => {
    context.files.setEditorState(current.fileId, DATABASE_STATE_KEY, undefined);
    void context.fileMediator.bindEngine(current.fileId, ENGINE_ID, connectionId || undefined).then(rerender);
  };

  const onDatabaseChange = (database: string): void => {
    if (!connection) {
      return;
    }
    const next: SelectedDatabase | undefined = database ? { connectionId: connection.connectionId, database } : undefined;
    context.files.setEditorState(current.fileId, DATABASE_STATE_KEY, next);
    rerender();
  };

  const databaseOptions = databases?.status === "loaded" ? [...databases.names] : [];
  if (selectedDatabase && !databaseOptions.includes(selectedDatabase)) {
    databaseOptions.unshift(selectedDatabase);
  }

  return (
    <div className="qmongo-view">
      <label className="qmongo-label" htmlFor="qmongo-view-connection">Connection</label>
      <select id="qmongo-view-connection" className="qmongo-input" value={connection?.connectionId ?? ""} onChange={(e) => onConnectionChange(e.target.value)}>
        {!connection && <option value="">Select connection…</option>}
        {enabled.map((c) => (
          <option key={c.connectionId} value={c.connectionId}>{connectionLabel(c)}</option>
        ))}
      </select>

      {connection && (
        <>
          <label className="qmongo-label" htmlFor="qmongo-view-database">Database</label>
          <div className="qmongo-row">
            <select id="qmongo-view-database" className="qmongo-input" value={selectedDatabase} onChange={(e) => onDatabaseChange(e.target.value)}>
              <option value="">{connection.defaultDatabase ? `${connection.defaultDatabase} (connection default)` : "None (use \"$db\" in commands)"}</option>
              {databaseOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button
              type="button"
              className="qmongo-button"
              title="Refresh databases"
              disabled={databases?.status === "loading"}
              onClick={() => void loadDatabases(context, current.fileId, connection.connectionId, true)}
            >
              {databases?.status === "loading" ? "…" : "↻"}
            </button>
          </div>
          {databases?.status === "error" && <div className="qmongo-error">Could not list databases: {databases.message}</div>}

          <div className="qmongo-label qmongo-tree-heading">Explorer</div>
          {databases?.status === "loaded" ? (
            <MongoExplorer context={context} connectionId={connection.connectionId} databases={databases.names} />
          ) : databases?.status === "error" ? null : (
            <div className="qmongo-muted">Loading databases…</div>
          )}
        </>
      )}
    </div>
  );
}

/** Read-only "connection | database" label in the query editor status bar, like JDBC's JdbcConnectionStatus. */
export function MongoStatusLabel({ context, file }: { context: PluginContext; file: FileEntity | undefined }): JSX.Element | null {
  const { connection, selectedDatabase } = useMongoFileState(context, file);
  if (!connection) {
    return <span className="qmongo-muted">MongoDB: no connection</span>;
  }
  const database = selectedDatabase || connection.defaultDatabase;
  return <span>{connectionLabel(connection)}{database ? ` | ${database}` : ""}</span>;
}
