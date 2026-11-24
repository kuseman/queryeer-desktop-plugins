import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { PluginBackend } from "@queryeer/api/plugin/PluginBackend";
import type {
  PayloadbuilderCatalogContribution,
  PayloadbuilderCatalogPanelProps
} from "@queryeer/api/queryengine/PayloadbuilderCatalogExtension";
import { connectionLabel, parseConnections, type ElasticsearchConnection } from "./connections.js";
import { ACTION_LIST_INDICES, CONNECTIONS_SETTING_ID, ELASTICSEARCH_CATALOG_ID, LIST_INDICES_TIMEOUT_MS, PAYLOADBUILDER_PLUGIN_ID } from "./constants.js";

/**
 * Offers the `elasticsearch` payloadbuilder catalog over this plugin's connections, when payloadbuilder is there. The
 * backend half (PayloadbuilderElasticsearchCatalog) does the same on the backend. Files store `{ connectionId, index? }`,
 * as with Queryeer's built-in catalog, so files that used it keep their connection once it's migrated. The index list
 * comes from the plugin's own backend action, not from payloadbuilder.
 */
export function registerPayloadbuilderCatalog(context: PluginContext, backend: PluginBackend): Disposable | undefined {
  if (!context.isDependencyActive(PAYLOADBUILDER_PLUGIN_ID)) {
    return undefined;
  }
  return context.payloadbuilderCatalog.registerContribution(
    elasticsearchCatalogContribution(() => parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)), backend)
  );
}

export function elasticsearchCatalogContribution(connections: () => ElasticsearchConnection[], backend: PluginBackend): PayloadbuilderCatalogContribution {
  // Indices are the cluster's, not the file's: kept per connection, so they survive the panel unmounting when another
  // file is shown, and every file on the same connection sees the last reload
  const indexCache = new Map<string, string[]>();
  return {
    catalogId: ELASTICSEARCH_CATALOG_ID,
    title: "Elasticsearch",
    defaultAlias: "es",
    allowMultiple: true,
    order: 10,
    filterPersistedProperties: (properties) => ({ connectionId: asText(properties.connectionId), index: asText(properties.index) }),
    resolveRuntimeProperties: (properties) => resolveRuntimeProperties(properties, connections()),
    renderPanel: (props) => (
      <ElasticsearchCatalogPanel {...props} connections={connections().filter((connection) => connection.enabled)} backend={backend} indexCache={indexCache} />
    )
  };
}

/** What a run sends to the backend: the connection, while it exists and is enabled, and the index if one is set. */
export function resolveRuntimeProperties(properties: Record<string, unknown>, connections: ElasticsearchConnection[]): Record<string, unknown> {
  const connectionId = asText(properties.connectionId);
  if (!connectionId || !connections.some((connection) => connection.enabled && connection.connectionId === connectionId)) {
    return {};
  }
  const index = asText(properties.index).trim();
  return index ? { connectionId, index } : { connectionId };
}

function ElasticsearchCatalogPanel({
  alias,
  properties,
  setProperty,
  connections,
  backend,
  indexCache
}: PayloadbuilderCatalogPanelProps & { connections: ElasticsearchConnection[]; backend: PluginBackend; indexCache: Map<string, string[]> }): JSX.Element {
  const hasConfiguredConnectionProperty = Object.prototype.hasOwnProperty.call(properties, "connectionId");
  const configuredConnectionId = asText(properties.connectionId);
  const configuredConnection = connections.find((connection) => connection.connectionId === configuredConnectionId);
  const selectedConnection = configuredConnection ?? (!hasConfiguredConnectionProperty ? connections[0] : undefined);
  const selectedConnectionId = hasConfiguredConnectionProperty ? configuredConnectionId : (selectedConnection?.connectionId ?? "");
  const index = asText(properties.index);
  const [indices, setIndices] = useState<string[]>(() => indexCache.get(selectedConnectionId) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A reload that a later one or a connection change overtook doesn't apply its answer
  const generation = useRef(0);
  const listId = `com-queryeer-elasticsearch-catalog-indices-${alias}`;

  useEffect(() => {
    if (!hasConfiguredConnectionProperty && selectedConnectionId) {
      setProperty("connectionId", selectedConnectionId);
    }
  }, [hasConfiguredConnectionProperty, selectedConnectionId, setProperty]);

  useEffect(() => {
    generation.current += 1;
    setIndices(indexCache.get(selectedConnectionId) ?? []);
    setLoading(false);
    setError(undefined);
  }, [alias, selectedConnectionId, indexCache]);

  const loadIndices = async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await backend.invoke<{ indices?: unknown }>(ACTION_LIST_INDICES, { connectionId: selectedConnectionId }, { timeoutMs: LIST_INDICES_TIMEOUT_MS });
      if (current !== generation.current) {
        return;
      }
      const loaded = Array.isArray(result?.indices) ? result.indices.filter((name): name is string => typeof name === "string") : [];
      indexCache.set(selectedConnectionId, loaded);
      setIndices(loaded);
    } catch (loadError) {
      if (current === generation.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="payloadbuilder-catalog-fields">
      <label className="payloadbuilder-catalog-label" htmlFor={`com-queryeer-elasticsearch-catalog-connection-${alias}`}>
        Connection
      </label>
      <select
        id={`com-queryeer-elasticsearch-catalog-connection-${alias}`}
        className="payloadbuilder-catalog-select"
        value={selectedConnectionId}
        disabled={connections.length === 0 || loading}
        onChange={(event) => setProperty("connectionId", event.currentTarget.value)}
      >
        <option value="">{connections.length === 0 ? "No Elasticsearch connections configured" : "Select connection"}</option>
        {configuredConnectionId && !configuredConnection && (
          // E.g. a connection that was removed or disabled, or one of Queryeer's own that wasn't migrated
          <option value={configuredConnectionId}>{configuredConnectionId} (unavailable)</option>
        )}
        {connections.map((connection) => (
          <option key={connection.connectionId} value={connection.connectionId}>
            {connectionLabel(connection)}
          </option>
        ))}
      </select>

      <label className="payloadbuilder-catalog-label" htmlFor={`com-queryeer-elasticsearch-catalog-index-${alias}`}>
        Index (optional)
      </label>
      <IndexCombobox
        id={`com-queryeer-elasticsearch-catalog-index-${alias}`}
        listId={listId}
        value={index}
        indices={indices}
        loading={loading}
        canLoad={Boolean(configuredConnection)}
        onLoad={() => void loadIndices()}
        onChange={(next) => setProperty("index", next)}
      />

      <div className="payloadbuilder-settings-actions">
        <button type="button" className="payloadbuilder-catalog-button" disabled={loading || !configuredConnection} onClick={() => void loadIndices()}>
          {loading ? "Loading…" : "Reload indices"}
        </button>
      </div>

      {error && <div className="payloadbuilder-settings-error" role="alert">{error}</div>}
    </div>
  );
}

/** At most this many suggestions are shown; the count above them says how many matched. */
const MAX_SUGGESTIONS = 200;

/**
 * The indices that match what's typed: everything when it's empty, a wildcard match (`*`, `?`) when it's a pattern, as
 * Elasticsearch reads it, else the names that contain it. Case-insensitive, so `Filebeat` still finds `filebeat-8`.
 */
export function matchIndices(indices: string[], text: string): string[] {
  const query = text.trim().toLowerCase();
  if (!query) {
    return indices;
  }
  if (isPattern(query)) {
    const regex = new RegExp(`^${query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return indices.filter((name) => regex.test(name.toLowerCase()));
  }
  return indices.filter((name) => name.toLowerCase().includes(query));
}

function isPattern(text: string): boolean {
  return /[*?]/.test(text);
}

/**
 * Free-text index with suggestions. Unlike a native datalist, it matches a pattern as a wildcard (so `filebeat-*` lists
 * the filebeat indices instead of nothing), says how many indices a pattern covers, and the toggle loads the list when it
 * isn't loaded yet.
 */
function IndexCombobox({
  id,
  listId,
  value,
  indices,
  loading,
  canLoad,
  onLoad,
  onChange
}: {
  id: string;
  listId: string;
  value: string;
  indices: string[];
  loading: boolean;
  canLoad: boolean;
  onLoad: () => void;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = matchIndices(indices, value);
  const shown = matches.slice(0, MAX_SUGGESTIONS);
  const pattern = isPattern(value.trim());
  const loaded = indices.length > 0;

  const choose = (name: string): void => {
    onChange(name);
    setOpen(false);
    setActive(-1);
  };

  const toggle = (): void => {
    if (!loaded && canLoad && !loading) {
      onLoad();
    }
    setOpen((current) => !current);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, -1));
    } else if (event.key === "Enter" && open && active >= 0 && active < shown.length) {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  let summary: string | undefined;
  if (loading && !loaded) {
    summary = "Loading indices…";
  } else if (!loaded) {
    summary = canLoad ? "Not loaded yet: use Reload indices" : "Select a connection to list indices";
  } else if (pattern) {
    summary = matches.length === 0 ? `${value.trim()} matches none of the ${indices.length} listed indices` : `${value.trim()} matches ${countLabel(matches.length)}`;
  } else if (matches.length === 0) {
    summary = `No index contains "${value.trim()}"`;
  } else if (matches.length > shown.length) {
    summary = `${matches.length} matching, first ${shown.length} shown`;
  }

  return (
    <div className="qes-combobox">
      <div className="qes-combobox-field">
        <input
          id={id}
          className="payloadbuilder-catalog-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={value}
          placeholder={loaded ? "Index, alias, data stream or pattern" : "orders, logs-*, or reload to list them"}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        <button
          type="button"
          className="qes-combobox-toggle"
          aria-label="Show indices"
          tabIndex={-1}
          disabled={!loaded && !canLoad}
          // Keeps the focus in the input, so its blur doesn't close the list first
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          ▾
        </button>
      </div>
      {pattern && loaded && !open && <div className="qes-combobox-hint">{summary}</div>}
      {open && (
        <div className="qes-combobox-popup">
          {summary && <div className="qes-combobox-summary">{summary}</div>}
          {shown.length > 0 && (
            <ul id={listId} role="listbox" className="qes-combobox-list">
              {shown.map((name, position) => (
                <li
                  key={name}
                  id={`${listId}-${position}`}
                  role="option"
                  aria-selected={position === active}
                  className={position === active ? "qes-combobox-option qes-combobox-option-active" : "qes-combobox-option"}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(position)}
                  onClick={() => choose(name)}
                >
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function countLabel(count: number): string {
  return count === 1 ? "1 index" : `${count} indices`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
