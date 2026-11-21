import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { readSelectedDatabase, resolveConnection } from "./binding.js";
import { parseConnections } from "./connections.js";
import { ACTION_VALIDATE, CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, ENGINE_ID } from "./constants.js";
import type { MongoEditorData, Problem } from "./mongoEditorFeatures.js";
import { collectionsOf, fieldsOf, subscribeExplorer, type Loadable } from "./MongoExplorer.js";

/** How long completion waits for collections or fields that are still loading; after that it offers what it has. */
const LOAD_WAIT_MS = 3000;

/**
 * The editor features' data: the file's connection and database as the query bar resolves them, and collections and fields from
 * the explorer's caches, so all three show the same and refresh together.
 */
export function createMongoEditorData(context: PluginContext): MongoEditorData {
  return {
    scope(fileId) {
      if (!fileId) {
        return undefined;
      }
      const connection = resolveConnection(context.files.getFile(fileId), parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)));
      if (!connection) {
        return undefined;
      }
      const selected = readSelectedDatabase(context.files.getEditorState(fileId, DATABASE_STATE_KEY));
      const database = (selected?.connectionId === connection.connectionId ? selected.database : "") || connection.defaultDatabase || undefined;
      return { connectionId: connection.connectionId, database };
    },

    async collections(connectionId, database) {
      const loaded = await settled(() => collectionsOf(context, connectionId, database));
      return loaded.status === "loaded" ? loaded.items.map((collection) => collection.name) : undefined;
    },

    async fields(connectionId, database, collection) {
      const loaded = await settled(() => fieldsOf(context, connectionId, database, collection));
      return loaded.status === "loaded" ? loaded.items : undefined;
    },

    async validate(text) {
      // Silent: a check while typing must never open the vault's unlock dialog (it needs no connection anyway)
      const result = await context.queryEngines.invoke<unknown>({ engineId: ENGINE_ID, action: ACTION_VALIDATE, payload: { text } }, { silent: true });
      return Array.isArray(result) ? result.filter(isProblem) : [];
    }
  };
}

/** The value once it isn't loading any more, or "loading" after a while. Starts the load when it isn't cached. */
export function settled<T>(read: () => Loadable<T>, waitMs: number = LOAD_WAIT_MS): Promise<Loadable<T>> {
  const first = read();
  if (first.status !== "loading") {
    return Promise.resolve(first);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Loadable<T>) => {
      if (!done) {
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      }
    };
    const unsubscribe = subscribeExplorer(() => {
      const value = read();
      if (value.status !== "loading") {
        finish(value);
      }
    });
    const timer = setTimeout(() => finish({ status: "loading" }), waitMs);
  });
}

function isProblem(value: unknown): value is Problem {
  const problem = value as Partial<Problem> | null;
  return typeof problem?.message === "string" && typeof problem.line === "number" && typeof problem.column === "number";
}
