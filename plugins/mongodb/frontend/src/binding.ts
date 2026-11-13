import type { FileEntity } from "@queryeer/api/files/FileEntity";
import type { MongoConnection } from "./connections.js";

/** What the status-bar picker stores per file under DATABASE_STATE_KEY. Tied to a connection so a rebind clears it. */
export type SelectedDatabase = {
  connectionId: string;
  database: string;
};

export function readSelectedDatabase(raw: unknown): SelectedDatabase | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return typeof record.connectionId === "string" && typeof record.database === "string" && record.database
    ? { connectionId: record.connectionId, database: record.database }
    : undefined;
}

/**
 * The connection a file executes against: the bound connection when it still exists and is enabled,
 * otherwise the only enabled connection when there is exactly one, otherwise none.
 */
export function resolveConnection(file: FileEntity | undefined, connections: readonly MongoConnection[]): MongoConnection | undefined {
  const enabled = connections.filter((c) => c.enabled);
  const boundId = file?.engineBinding?.engineId === undefined || file.engineBinding.engineId === "mongodb"
    ? file?.engineBinding?.connectionId
    : undefined;
  if (boundId) {
    return enabled.find((c) => c.connectionId === boundId);
  }
  return enabled.length === 1 ? enabled[0] : undefined;
}

/**
 * The engine state sent with every execution and file-scoped invoke (see MongoQueryEngineProvider on the backend):
 * `connectionId` always when resolvable, `database` only when the user picked one for this connection.
 */
export function buildEngineState(
  file: FileEntity | undefined,
  connections: readonly MongoConnection[],
  selected: SelectedDatabase | undefined
): { connectionId?: string; database?: string } | undefined {
  const connection = resolveConnection(file, connections);
  if (!connection) {
    return undefined;
  }
  const state: { connectionId: string; database?: string } = { connectionId: connection.connectionId };
  if (selected && selected.connectionId === connection.connectionId) {
    state.database = selected.database;
  }
  return state;
}
