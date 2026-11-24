import { useEffect, useRef, useState } from "react";
import type { FileMediator } from "@queryeer/api/files/FileMediator";
import type { SettingsRegistry } from "@queryeer/api/settings/SettingsExtension";
import { DIALECT_ID } from "./constants.js";

/**
 * The JDBC engine's connections setting (DEVELOPMENT-PLUGIN.md, "JDBC connections"): an array of
 * `{ connectionId, title?, dialectId, properties?, enabled, ... }`. It moves to `@queryeer/jdbc-api` with the JDBC split.
 */
export const JDBC_CONNECTIONS_SETTING_ID = "core.queryengine.jdbc.connections";

export type SqliteWelcomeEditorProps = {
  /** The opened database file's tab, closed once a query file is open. */
  fileId: string;
  filePath: string;
  settings: Pick<SettingsRegistry, "getValue" | "setValue">;
  fileMediator: Pick<FileMediator, "createUntitledFile" | "bindEngine" | "closeFile">;
};

/** The id of an enabled SQLite connection to this file, if there is one. */
export function findSqliteConnection(rawConnections: unknown, filePath: string): string | undefined {
  if (!Array.isArray(rawConnections)) {
    return undefined;
  }
  const match = rawConnections.find((item): item is { connectionId: string } => {
    const connection = item as { connectionId?: unknown; dialectId?: unknown; enabled?: unknown; properties?: { filePath?: unknown } } | null;
    return typeof connection?.connectionId === "string"
      && connection.dialectId === DIALECT_ID
      && connection.enabled !== false
      && connection.properties?.filePath === filePath;
  });
  return match?.connectionId;
}

/** The file's name without its folder and extension, e.g. "shop" for "C:\data\shop.db". */
export function databaseName(filePath: string): string {
  return filePath.replace(/^.*[/\\]/, "").replace(/\.[^.]*$/, "") || filePath;
}

/**
 * Shown when a SQLite database file is opened. With a connection to the file it opens a query file bound to it right
 * away; otherwise it offers to create one. Either way the database file's own tab closes.
 */
export function SqliteWelcomeEditor({ fileId, filePath, settings, fileMediator }: SqliteWelcomeEditorProps): JSX.Element {
  const existing = findSqliteConnection(settings.getValue(JDBC_CONNECTIONS_SETTING_ID), filePath);
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const openQueryFile = async (connectionId: string): Promise<void> => {
    if (opening.current) {
      return;
    }
    opening.current = true;
    setBusy(true);
    try {
      const file = await fileMediator.createUntitledFile({ mimeType: "application/sql", extension: "sql", title: databaseName(filePath) });
      await fileMediator.bindEngine(file.fileId, "jdbc", connectionId);
      await fileMediator.closeFile(fileId);
    } catch (cause) {
      opening.current = false;
      setBusy(false);
      setError(`The query file could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  useEffect(() => {
    if (existing) {
      void openQueryFile(existing);
    }
    // Once per opened file: the editor is keyed by file id
  }, []);

  const createConnection = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const current = settings.getValue<unknown>(JDBC_CONNECTIONS_SETTING_ID);
    const connectionId = crypto.randomUUID();
    const result = await settings.setValue(JDBC_CONNECTIONS_SETTING_ID, [
      ...(Array.isArray(current) ? current : []),
      { connectionId, title: `${databaseName(filePath)} (SQLite)`, dialectId: DIALECT_ID, properties: { filePath }, enabled: true }
    ]);
    if (!result.ok) {
      setBusy(false);
      setError(`The connection could not be saved: ${result.message}`);
      return;
    }
    await openQueryFile(connectionId);
  };

  return (
    <section className="qsqlite-welcome">
      <h2>SQLite Database</h2>
      <p className="qsqlite-path">{filePath}</p>
      {existing && !error ? (
        <p>Opening a query file for its connection…</p>
      ) : (
        <>
          <p>This file is a SQLite database. Create a database connection to run queries against it.</p>
          <div className="qsqlite-actions">
            <button type="button" className="qsqlite-button qsqlite-primary" disabled={busy} onClick={() => void createConnection()}>
              Create Database Connection
            </button>
            <button type="button" className="qsqlite-button" disabled={busy} onClick={() => void fileMediator.closeFile(fileId)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p className="qsqlite-error" role="alert">{error}</p>}
    </section>
  );
}
