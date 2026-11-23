import { useEffect, useMemo, useRef, useState } from "react";
import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type {
  PayloadbuilderCatalogContribution,
  PayloadbuilderCatalogPanelProps
} from "@queryeer/api/queryengine/PayloadbuilderCatalogExtension";
import { connectionLabel, parseConnections, type KafkaConnection } from "./connections.js";
import { ACTION_LIST_TOPICS, CONNECTIONS_SETTING_ID, KAFKA_CATALOG_ID, LIST_TOPICS_TIMEOUT_MS, PAYLOADBUILDER_PLUGIN_ID } from "./constants.js";
import type { PluginBackend } from "@queryeer/api/plugin/PluginBackend";

/**
 * Offers the `kafka` payloadbuilder catalog over this plugin's connections, when payloadbuilder is there. The backend
 * half (PayloadbuilderKafkaCatalog) does the same on the backend. Files store `{ connectionId, topic? }`. The topic
 * list comes from the plugin's own backend action, not from payloadbuilder.
 */
export function registerPayloadbuilderCatalog(context: PluginContext, backend: PluginBackend): Disposable | undefined {
  if (!context.isDependencyActive(PAYLOADBUILDER_PLUGIN_ID)) {
    return undefined;
  }
  return context.payloadbuilderCatalog.registerContribution(
    kafkaCatalogContribution(() => parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)), backend)
  );
}

export function kafkaCatalogContribution(connections: () => KafkaConnection[], backend: PluginBackend): PayloadbuilderCatalogContribution {
  // Topics are the cluster's, not the file's: kept per connection, so they survive the panel unmounting when another
  // file is shown, and every file on the same connection sees the last reload
  const topicCache = new Map<string, string[]>();
  return {
    catalogId: KAFKA_CATALOG_ID,
    title: "Kafka",
    defaultAlias: "kafka",
    allowMultiple: true,
    order: 15,
    filterPersistedProperties: (properties) => ({ connectionId: asText(properties.connectionId), topic: asText(properties.topic) }),
    resolveRuntimeProperties: (properties) => resolveRuntimeProperties(properties, connections()),
    renderPanel: (props) => (
      <KafkaCatalogPanel {...props} connections={connections().filter((connection) => connection.enabled)} backend={backend} topicCache={topicCache} />
    )
  };
}

/** What a run sends to the backend: the connection, while it exists and is enabled, and the topic if one is picked. */
export function resolveRuntimeProperties(properties: Record<string, unknown>, connections: KafkaConnection[]): Record<string, unknown> {
  const connectionId = asText(properties.connectionId);
  if (!connectionId || !connections.some((connection) => connection.enabled && connection.connectionId === connectionId)) {
    return {};
  }
  const topic = asText(properties.topic);
  return topic ? { connectionId, topic } : { connectionId };
}

function KafkaCatalogPanel({
  alias,
  properties,
  setProperty,
  connections,
  backend,
  topicCache
}: PayloadbuilderCatalogPanelProps & { connections: KafkaConnection[]; backend: PluginBackend; topicCache: Map<string, string[]> }): JSX.Element {
  const hasConfiguredConnectionProperty = Object.prototype.hasOwnProperty.call(properties, "connectionId");
  const configuredConnectionId = asText(properties.connectionId);
  const configuredConnection = connections.find((connection) => connection.connectionId === configuredConnectionId);
  const selectedConnection = configuredConnection ?? (!hasConfiguredConnectionProperty ? connections[0] : undefined);
  const selectedConnectionId = hasConfiguredConnectionProperty ? configuredConnectionId : (selectedConnection?.connectionId ?? "");
  const selectedTopic = asText(properties.topic);
  const [topics, setTopics] = useState<string[]>(() => topicCache.get(selectedConnectionId) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A reload that a later one or a connection change overtook doesn't apply its answer
  const generation = useRef(0);

  useEffect(() => {
    if (!hasConfiguredConnectionProperty && selectedConnectionId) {
      setProperty("connectionId", selectedConnectionId);
    }
  }, [hasConfiguredConnectionProperty, selectedConnectionId, setProperty]);

  useEffect(() => {
    generation.current += 1;
    setTopics(topicCache.get(selectedConnectionId) ?? []);
    setLoading(false);
    setError(undefined);
  }, [alias, selectedConnectionId, topicCache]);

  // The picked topic stays selectable before the list is loaded
  const selectableTopics = useMemo(() => [...new Set([selectedTopic, ...topics].filter(Boolean))], [selectedTopic, topics]);

  const loadTopics = async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await backend.invoke<{ topics?: unknown }>(ACTION_LIST_TOPICS, { connectionId: selectedConnectionId }, { timeoutMs: LIST_TOPICS_TIMEOUT_MS });
      if (current !== generation.current) {
        return;
      }
      const loaded = Array.isArray(result?.topics) ? result.topics.filter((topic): topic is string => typeof topic === "string") : [];
      topicCache.set(selectedConnectionId, loaded);
      setTopics(loaded);
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
      <label className="payloadbuilder-catalog-label" htmlFor={`com-queryeer-kafka-catalog-connection-${alias}`}>
        Connection
      </label>
      <select
        id={`com-queryeer-kafka-catalog-connection-${alias}`}
        className="payloadbuilder-catalog-select"
        value={selectedConnectionId}
        disabled={connections.length === 0 || loading}
        onChange={(event) => {
          setProperty("connectionId", event.currentTarget.value);
          setProperty("topic", "");
        }}
      >
        <option value="">{connections.length === 0 ? "No Kafka connections configured" : "Select connection"}</option>
        {configuredConnectionId && !configuredConnection && (
          // E.g. a file from before this plugin, whose connection was one of Queryeer's own Kafka connections
          <option value={configuredConnectionId}>{configuredConnectionId} (unavailable)</option>
        )}
        {connections.map((connection) => (
          <option key={connection.connectionId} value={connection.connectionId}>
            {connectionLabel(connection)}
          </option>
        ))}
      </select>

      <label className="payloadbuilder-catalog-label" htmlFor={`com-queryeer-kafka-catalog-topic-${alias}`}>
        Topic (optional)
      </label>
      <select
        id={`com-queryeer-kafka-catalog-topic-${alias}`}
        className="payloadbuilder-catalog-select"
        value={selectedTopic}
        disabled={loading}
        onChange={(event) => setProperty("topic", event.currentTarget.value)}
      >
        <option value="">{topics.length === 0 && !selectedTopic ? "Reload to list topics" : "No topic (name it in the query)"}</option>
        {selectableTopics.map((topic) => (
          <option key={topic} value={topic}>
            {topic}
          </option>
        ))}
      </select>

      <div className="payloadbuilder-settings-actions">
        <button type="button" className="payloadbuilder-catalog-button" disabled={loading || !configuredConnection} onClick={() => void loadTopics()}>
          {loading ? "Loading…" : "Reload topics"}
        </button>
      </div>

      {error && <div className="payloadbuilder-settings-error" role="alert">{error}</div>}
    </div>
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
