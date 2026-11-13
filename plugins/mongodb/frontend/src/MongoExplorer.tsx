import { useCallback, useEffect, useState } from "react";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  badgeFor,
  describeEntry,
  groupCollections,
  validationBadge,
  type CollectionEntry,
  type CollectionGroups,
  type CollectionInfo
} from "./collectionGroups.js";
import { ACTION_COLLECTIONS, ACTION_FIELDS, ACTION_INDEXES, ENGINE_ID, QUERY_BAR_STATE_KEY } from "./constants.js";
import { commandFor, initialState, textFor, type StoredBar } from "./queryBarModel.js";
import {
  COLLECTION_ACTIONS,
  collectionCommand,
  commandText,
  databaseStatsCommand,
  distinctCommand,
  distinctTitle,
  queryTitle,
  slowQueriesCommand,
  tabTitle,
  validatorCommand,
  type CollectionAction
} from "./queries.js";
import { isReuseClick, reuseModifierLabel, runGeneratedQuery } from "./queryFiles.js";

export type IndexInfo = { name: string; key: string; unique: boolean };
export type FieldInfo = { name: string; types: string[]; count: number; sampled: number };

export type Loadable<T> = { status: "loading" } | { status: "loaded"; items: T[] } | { status: "error"; message: string };
type ClickEvent = { ctrlKey: boolean; metaKey: boolean };

/** Explorer caches, shared by every MongoDB view instance. Keys include the connection, so switching connections never shows stale data. */
const collectionCache = new Map<string, Loadable<CollectionInfo>>();
const fieldCache = new Map<string, Loadable<FieldInfo>>();
const indexCache = new Map<string, Loadable<IndexInfo>>();
/**
 * Expanded tree nodes per connection. This store outlives the view, which unmounts whenever a non-MongoDB tab is active,
 * so the tree looks the same when you come back. Like JDBC's navigation store, it is kept in memory and not across restarts.
 */
const expandedByConnection = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Forgets cached collections, fields and indexes, e.g. after connection settings changed. */
export function clearExplorerCache(): void {
  collectionCache.clear();
  fieldCache.clear();
  indexCache.clear();
  notify();
}

const key = (...parts: string[]): string => parts.join("\u0000");

/**
 * A database's collections from the explorer's cache, loading them (silently) when not cached yet.
 * Shared with the query bar so both show the same data and refresh together.
 */
export function collectionsOf(context: PluginContext, connectionId: string, database: string): Loadable<CollectionInfo> {
  const cacheKey = key(connectionId, database);
  return cachedOrLoad(collectionCache, cacheKey, () => load(collectionCache, cacheKey, context, ACTION_COLLECTIONS, { connectionId, database }, false));
}

/** A collection's sampled fields from the explorer's cache, loading them (silently) when not cached yet. */
export function fieldsOf(context: PluginContext, connectionId: string, database: string, collection: string): Loadable<FieldInfo> {
  const cacheKey = key(connectionId, database, collection);
  return cachedOrLoad(fieldCache, cacheKey, () => load(fieldCache, cacheKey, context, ACTION_FIELDS, { connectionId, database, collection }, false));
}

const pendingLoads = new Set<string>();

/** The cached value, or "loading" with the load started after the current render (loading notifies listeners, which re-render). */
function cachedOrLoad<T>(cache: Map<string, Loadable<T>>, cacheKey: string, start: () => Promise<void>): Loadable<T> {
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (!pendingLoads.has(cacheKey)) {
    pendingLoads.add(cacheKey);
    queueMicrotask(() => {
      pendingLoads.delete(cacheKey);
      if (!cache.has(cacheKey)) {
        void start();
      }
    });
  }
  return { status: "loading" };
}

/** Samples a collection's fields again, e.g. from the query bar's ↻. */
export function refreshFields(context: PluginContext, connectionId: string, database: string, collection: string): void {
  void load(fieldCache, key(connectionId, database, collection), context, ACTION_FIELDS, { connectionId, database, collection }, true);
}

/** Calls `listener` whenever explorer data changes; returns the unsubscribe function. */
export function subscribeExplorer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const FOLDERS: ReadonlyArray<{ id: keyof CollectionGroups; label: string; title: string }> = [
  { id: "collections", label: "Collections", title: "Collections, time-series collections and GridFS buckets" },
  { id: "views", label: "Views", title: "Read-only views defined by an aggregation pipeline" },
  { id: "system", label: "System", title: "system.* collections, e.g. system.profile (the slow-query log when profiling is on)" }
];

async function load<T>(
  cache: Map<string, Loadable<T>>,
  cacheKey: string,
  context: PluginContext,
  action: string,
  payload: Record<string, unknown>,
  interactive: boolean
): Promise<void> {
  cache.set(cacheKey, { status: "loading" });
  notify();
  try {
    const result = await context.queryEngines.invoke<unknown>({ engineId: ENGINE_ID, action, payload }, { silent: !interactive });
    cache.set(cacheKey, { status: "loaded", items: Array.isArray(result) ? (result as T[]) : [] });
  } catch (error) {
    cache.set(cacheKey, { status: "error", message: error instanceof Error ? error.message : String(error) });
  }
  notify();
}

/** Compact count: 950, 12.3k, 4.1M. */
export function formatCount(count: number | null): string {
  if (count === null) {
    return "";
  }
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  }
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

/** "87%" when a field is missing from some sampled documents, "" when it is in all of them. */
export function formatPresence(field: Pick<FieldInfo, "count" | "sampled">): string {
  if (field.sampled <= 0 || field.count >= field.sampled) {
    return "";
  }
  const percent = (field.count / field.sampled) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/**
 * database → Collections / Views / System → collection → Fields / Indexes, loaded lazily per level, like JDBC's tree.
 * Collection and field actions open a new .mongo tab with the generated command and run it; Ctrl/⌘+click reuses the current tab.
 */
export function MongoExplorer({ context, connectionId, databases }: {
  context: PluginContext;
  connectionId: string;
  databases: string[];
}): JSX.Element {
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((v) => v + 1), []);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, [rerender]);

  useEffect(() => {
    setMenuFor(undefined);
  }, [connectionId]);

  let expanded = expandedByConnection.get(connectionId);
  if (!expanded) {
    expanded = new Set();
    expandedByConnection.set(connectionId, expanded);
  }
  const expandedNodes = expanded;

  const loadCollections = (database: string, interactive: boolean): void => {
    void load(collectionCache, key(connectionId, database), context, ACTION_COLLECTIONS, { connectionId, database }, interactive);
  };
  const loadFields = (database: string, collection: string, interactive: boolean): void => {
    void load(fieldCache, key(connectionId, database, collection), context, ACTION_FIELDS, { connectionId, database, collection }, interactive);
  };
  const loadIndexes = (database: string, collection: string, interactive: boolean): void => {
    void load(indexCache, key(connectionId, database, collection), context, ACTION_INDEXES, { connectionId, database, collection }, interactive);
  };

  /** Loads the data behind an expanded node when it is not cached (first expand, or caches cleared since). */
  const ensureLoaded = (nodeKey: string): void => {
    const [kind, database, collection] = nodeKey.split("\u0000");
    if (kind === "db" && !collectionCache.has(key(connectionId, database))) {
      loadCollections(database, false);
    } else if (kind === "fields" && !fieldCache.has(key(connectionId, database, collection))) {
      loadFields(database, collection, false);
    } else if (kind === "indexes" && !indexCache.has(key(connectionId, database, collection))) {
      loadIndexes(database, collection, false);
    }
  };

  // Expanded nodes outlive the caches (cleared when connection settings change): reload what is open but not cached
  useEffect(() => {
    expandedNodes.forEach(ensureLoaded);
  });

  const toggle = (nodeKey: string): void => {
    if (expandedNodes.has(nodeKey)) {
      expandedNodes.delete(nodeKey);
    } else {
      expandedNodes.add(nodeKey);
      ensureLoaded(nodeKey);
      // Opening a database the first time also opens its Collections folder, the usual next step
      const [kind, database] = nodeKey.split("\u0000");
      const collectionsFolder = key("folder", database, "collections");
      if (kind === "db" && !expandedNodes.has(key("seen", database))) {
        expandedNodes.add(key("seen", database));
        expandedNodes.add(collectionsFolder);
      }
    }
    rerender();
  };

  const runQuery = (database: string, title: string, command: Record<string, unknown>, event: ClickEvent, editorState?: Record<string, unknown>): void => {
    setMenuFor(undefined);
    void runGeneratedQuery(context, {
      title,
      text: commandText(command),
      connectionId,
      database,
      execute: true,
      reuseActiveTab: isReuseClick(event),
      editorState
    });
  };
  const runCollectionAction = (database: string, collection: string, action: CollectionAction, event: ClickEvent): void => {
    if (action === "browse") {
      // Browse is the query bar's starting point: record it so the bar owns the new tab from the start
      const state = initialState(collection);
      const stored: StoredBar = { state, written: textFor(state) };
      runQuery(database, queryTitle(collection, action), commandFor(state), event, { [QUERY_BAR_STATE_KEY]: stored });
      return;
    }
    runQuery(database, queryTitle(collection, action), collectionCommand(action, collection), event);
  };
  const runSlowQueries = (database: string, event: ClickEvent): void =>
    runQuery(database, tabTitle(database, "Slowest queries"), slowQueriesCommand(), event);
  const slowQueriesTitle = "The 50 slowest operations recorded by the profiler (system.profile only holds recent ones)";

  const reuseHint = `${reuseModifierLabel()}+click: run in the current MongoDB tab instead`;

  if (databases.length === 0) {
    return <div className="qmongo-muted qmongo-tree-empty">No databases listed. Use ↻ above to refresh.</div>;
  }

  const toggleButton = (nodeKey: string, open: boolean, label: string): JSX.Element => (
    <button type="button" className="qmongo-tree-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${label}`} onClick={() => toggle(nodeKey)}>
      {open ? "▾" : "▸"}
    </button>
  );

  const renderFields = (database: string, collection: string): JSX.Element => {
    const fieldsKey = key("fields", database, collection);
    const open = expandedNodes.has(fieldsKey);
    const fields = fieldCache.get(key(connectionId, database, collection));
    return (
      <div role="treeitem" aria-expanded={open}>
        <div className="qmongo-tree-row">
          {toggleButton(fieldsKey, open, "fields")}
          <span className="qmongo-tree-label qmongo-tree-folder" title="Inferred from a random sample of up to 1,000 documents">Fields</span>
          {open && <button type="button" className="qmongo-tree-action" title="Sample again" onClick={() => loadFields(database, collection, true)}>↻</button>}
        </div>
        {open && (
          <div className="qmongo-tree-children" role="group">
            {renderStatus(fields, "No fields in the sample")}
            {fields?.status === "loaded" && fields.items.map((field) => {
              const fieldKey = key("field", database, collection, field.name);
              const presence = formatPresence(field);
              return (
                <div key={field.name}>
                  <div className="qmongo-tree-row qmongo-tree-leaf-row"
                    title={`${field.name}: ${field.types.join(" | ")}${presence ? ` (in ${presence} of ${field.sampled} sampled documents)` : ""}`}>
                    <span className="qmongo-tree-label">{field.name}</span>
                    <span className="qmongo-tree-type">{field.types.join(" | ")}</span>
                    {presence && <span className="qmongo-tree-count">{presence}</span>}
                    <button type="button" className="qmongo-tree-action" title="Actions" aria-expanded={menuFor === fieldKey}
                      onClick={() => setMenuFor(menuFor === fieldKey ? undefined : fieldKey)}>⋯</button>
                  </div>
                  {menuFor === fieldKey && (
                    <div className="qmongo-tree-menu" role="menu">
                      <button type="button" role="menuitem" className="qmongo-tree-menu-item" title={`Distinct values of ${field.name}\n${reuseHint}`}
                        onClick={(e) => runQuery(database, distinctTitle(collection, field.name), distinctCommand(collection, field.name), e)}>
                        Distinct values
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderIndexes = (database: string, collection: string): JSX.Element => {
    const indexesKey = key("indexes", database, collection);
    const open = expandedNodes.has(indexesKey);
    const indexes = indexCache.get(key(connectionId, database, collection));
    return (
      <div role="treeitem" aria-expanded={open}>
        <div className="qmongo-tree-row">
          {toggleButton(indexesKey, open, "indexes")}
          <span className="qmongo-tree-label qmongo-tree-folder">Indexes</span>
          {open && <button type="button" className="qmongo-tree-action" title="Refresh indexes" onClick={() => loadIndexes(database, collection, true)}>↻</button>}
        </div>
        {open && (
          <div className="qmongo-tree-children" role="group">
            {renderStatus(indexes, "No indexes")}
            {indexes?.status === "loaded" && indexes.items.map((index) => (
              <div key={index.name} className="qmongo-tree-row qmongo-tree-leaf-row" title={index.key}>
                <span className="qmongo-tree-label">{index.name}</span>
                {index.unique && <span className="qmongo-tree-badge">unique</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderValidator = (database: string, collection: string, info: CollectionInfo): JSX.Element => {
    const badge = validationBadge(info);
    const enforcement = `Level ${info.validationLevel ?? "strict"}, action ${info.validationAction ?? "error"}`;
    return (
      <div className="qmongo-tree-row qmongo-tree-leaf-row">
        <button type="button" className="qmongo-tree-label qmongo-tree-link qmongo-tree-folder"
          title={`${enforcement}\n${formatJsonForTooltip(info.validator ?? "")}\n\nShow the collection definition in a new tab\n${reuseHint}`}
          onClick={(e) => runQuery(database, tabTitle(collection, "Validator"), validatorCommand(collection), e)}>
          Validator
          {badge && <span className="qmongo-tree-badge">{badge}</span>}
        </button>
      </div>
    );
  };

  const renderCollection = (database: string, entry: CollectionEntry): JSX.Element => {
    const { name, label, info } = entry;
    const isView = info.type === "view";
    const badge = badgeFor(entry);
    const description = describeEntry(entry);
    const collKey = key("coll", database, name);
    const collOpen = expandedNodes.has(collKey);
    return (
      <div key={name} role="treeitem" aria-expanded={collOpen}>
        <div className="qmongo-tree-row">
          {toggleButton(collKey, collOpen, label)}
          <button type="button" className="qmongo-tree-label qmongo-tree-link"
            title={`${description ? `${description}\n` : ""}Browse ${name} in a new tab\n${reuseHint}`}
            onClick={(e) => runCollectionAction(database, name, "browse", e)}>
            {label}
            {badge && <span className="qmongo-tree-badge">{badge}</span>}
          </button>
          <span className="qmongo-tree-count" title={info.count === null ? undefined : `${info.count.toLocaleString()} documents (estimate)`}>
            {formatCount(info.count)}
          </span>
          <button type="button" className="qmongo-tree-action" title="Actions" aria-expanded={menuFor === collKey}
            onClick={() => setMenuFor(menuFor === collKey ? undefined : collKey)}>⋯</button>
        </div>

        {menuFor === collKey && (
          <div className="qmongo-tree-menu" role="menu">
            {COLLECTION_ACTIONS.filter((a) => !(isView && a.id === "indexes")).map((action) => (
              <button key={action.id} type="button" role="menuitem" className="qmongo-tree-menu-item" title={`${action.title}\n${reuseHint}`}
                onClick={(e) => runCollectionAction(database, name, action.id, e)}>
                {action.label}
              </button>
            ))}
            {name === "system.profile" && (
              <button type="button" role="menuitem" className="qmongo-tree-menu-item" title={`${slowQueriesTitle}\n${reuseHint}`}
                onClick={(e) => runSlowQueries(database, e)}>
                Slowest queries
              </button>
            )}
          </div>
        )}

        {collOpen && (
          <div className="qmongo-tree-children" role="group">
            {renderFields(database, name)}
            {!isView && renderIndexes(database, name)}
            {info.validator && renderValidator(database, name, info)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="qmongo-tree" role="tree" aria-label="MongoDB databases">
      {databases.map((database) => {
        const dbKey = key("db", database);
        const dbOpen = expandedNodes.has(dbKey);
        const collections = collectionCache.get(key(connectionId, database));
        const groups = collections?.status === "loaded" ? groupCollections(collections.items) : undefined;
        return (
          <div key={database} role="treeitem" aria-expanded={dbOpen}>
            <div className="qmongo-tree-row">
              {toggleButton(dbKey, dbOpen, database)}
              <span className="qmongo-tree-label qmongo-tree-db" title={database}>{database}</span>
              {dbOpen && <button type="button" className="qmongo-tree-action" title="Refresh collections" onClick={() => loadCollections(database, true)}>↻</button>}
              <button type="button" className="qmongo-tree-action" title="Actions" aria-expanded={menuFor === dbKey}
                onClick={() => setMenuFor(menuFor === dbKey ? undefined : dbKey)}>⋯</button>
            </div>

            {menuFor === dbKey && (
              <div className="qmongo-tree-menu" role="menu">
                <button type="button" role="menuitem" className="qmongo-tree-menu-item"
                  title={`Data, storage and index sizes (bytes), object and collection counts\n${reuseHint}`}
                  onClick={(e) => runQuery(database, tabTitle(database, "Stats"), databaseStatsCommand(), e)}>
                  Stats
                </button>
                {groups?.system.some((entry) => entry.name === "system.profile") && (
                  <button type="button" role="menuitem" className="qmongo-tree-menu-item" title={`${slowQueriesTitle}\n${reuseHint}`}
                    onClick={(e) => runSlowQueries(database, e)}>
                    Slowest queries
                  </button>
                )}
              </div>
            )}

            {dbOpen && (
              <div className="qmongo-tree-children" role="group">
                {collections?.status !== "loaded" && renderStatus(collections, "")}
                {groups && FOLDERS.filter((folder) => folder.id === "collections" || groups[folder.id].length > 0).map((folder) => {
                  const folderKey = key("folder", database, folder.id);
                  const open = expandedNodes.has(folderKey);
                  const entries = groups[folder.id];
                  return (
                    <div key={folder.id} role="treeitem" aria-expanded={open}>
                      <div className="qmongo-tree-row">
                        {toggleButton(folderKey, open, folder.label)}
                        <span className="qmongo-tree-label qmongo-tree-folder" title={folder.title}>{folder.label}</span>
                        <span className="qmongo-tree-count">{entries.length}</span>
                      </div>
                      {open && (
                        <div className="qmongo-tree-children" role="group">
                          {entries.length === 0 && <div className="qmongo-muted qmongo-tree-leaf">None</div>}
                          {entries.map((entry) => renderCollection(database, entry))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TOOLTIP_JSON_LIMIT = 1500;

/** Indented JSON for a tooltip, cut off when long. Falls back to the text as-is if it is not strict JSON. */
export function formatJsonForTooltip(json: string): string {
  let text = json;
  try {
    text = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // Extended JSON the browser cannot parse: show it unformatted
  }
  return text.length > TOOLTIP_JSON_LIMIT ? `${text.slice(0, TOOLTIP_JSON_LIMIT)}…` : text;
}

function renderStatus<T>(state: Loadable<T> | undefined, emptyText: string): JSX.Element | null {
  if (!state || state.status === "loading") {
    return <div className="qmongo-muted qmongo-tree-leaf">Loading…</div>;
  }
  if (state.status === "error") {
    return <div className="qmongo-error qmongo-tree-leaf" title={state.message}>Could not load: {state.message}</div>;
  }
  return state.items.length === 0 && emptyText ? <div className="qmongo-muted qmongo-tree-leaf">{emptyText}</div> : null;
}
