import { useEffect } from "react";
import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type {
  PayloadbuilderCatalogContribution,
  PayloadbuilderCatalogPanelProps
} from "@queryeer/api/queryengine/PayloadbuilderCatalogExtension";
import { connectionLabel, parseConnections, type MongoConnection } from "./connections.js";
import { CONNECTIONS_SETTING_ID } from "./constants.js";

/** The frontend plugin of Queryeer's payloadbuilder engine; an optional dependency of this plugin. */
export const PAYLOADBUILDER_PLUGIN_ID = "core.queryengine.payloadbuilder";
/** The same id as Queryeer's built-in catalog, so files that use it keep working; this one replaces it. */
export const MONGODB_CATALOG_ID = "mongodb";

/**
 * Offers the `mongodb` payloadbuilder catalog over this plugin's connections, when payloadbuilder is there. The
 * backend half (PayloadbuilderMongoCatalog) does the same on the backend. Files store `{ connectionId }`.
 */
export function registerPayloadbuilderCatalog(context: PluginContext): Disposable | undefined {
  if (!context.isDependencyActive(PAYLOADBUILDER_PLUGIN_ID)) {
    return undefined;
  }
  return context.payloadbuilderCatalog.registerContribution(
    mongoCatalogContribution(() => parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)))
  );
}

export function mongoCatalogContribution(connections: () => MongoConnection[]): PayloadbuilderCatalogContribution {
  return {
    catalogId: MONGODB_CATALOG_ID,
    title: "MongoDB",
    defaultAlias: "mongo",
    allowMultiple: true,
    order: 17,
    filterPersistedProperties: (properties) => ({ connectionId: asText(properties.connectionId) }),
    resolveRuntimeProperties: (properties) => resolveRuntimeProperties(properties, connections()),
    renderPanel: (props) => <MongoCatalogPanel {...props} connections={connections().filter((connection) => connection.enabled)} />
  };
}

/** What a run sends to the backend: the connection, while it exists and is enabled. */
export function resolveRuntimeProperties(properties: Record<string, unknown>, connections: MongoConnection[]): Record<string, unknown> {
  const connectionId = asText(properties.connectionId);
  if (!connectionId) {
    return {};
  }
  return connections.some((connection) => connection.enabled && connection.connectionId === connectionId) ? { connectionId } : {};
}

function MongoCatalogPanel({
  alias,
  properties,
  setProperty,
  connections
}: PayloadbuilderCatalogPanelProps & { connections: MongoConnection[] }): JSX.Element {
  const hasConfiguredConnectionProperty = Object.prototype.hasOwnProperty.call(properties, "connectionId");
  const configuredConnectionId = asText(properties.connectionId);
  const configuredConnection = connections.find((connection) => connection.connectionId === configuredConnectionId);
  const selectedConnection = configuredConnection ?? (!hasConfiguredConnectionProperty ? connections[0] : undefined);
  const selectedConnectionId = hasConfiguredConnectionProperty ? configuredConnectionId : (selectedConnection?.connectionId ?? "");

  useEffect(() => {
    if (!hasConfiguredConnectionProperty && selectedConnectionId) {
      setProperty("connectionId", selectedConnectionId);
    }
  }, [hasConfiguredConnectionProperty, selectedConnectionId, setProperty]);

  return (
    <div className="payloadbuilder-catalog-fields">
      <label className="payloadbuilder-catalog-label" htmlFor={`com-queryeer-mongodb-catalog-connection-${alias}`}>
        Connection
      </label>
      <select
        id={`com-queryeer-mongodb-catalog-connection-${alias}`}
        className="payloadbuilder-catalog-select"
        value={selectedConnectionId}
        disabled={connections.length === 0}
        onChange={(event) => setProperty("connectionId", event.currentTarget.value)}
      >
        <option value="">{connections.length === 0 ? "No MongoDB connections configured" : "Select connection"}</option>
        {configuredConnectionId && !configuredConnection && (
          // E.g. a file from before this plugin, whose connection was one of Queryeer's own MongoDB connections
          <option value={configuredConnectionId}>{configuredConnectionId} (unavailable)</option>
        )}
        {connections.map((connection) => (
          <option key={connection.connectionId} value={connection.connectionId}>
            {connectionLabel(connection)}
          </option>
        ))}
      </select>
    </div>
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
