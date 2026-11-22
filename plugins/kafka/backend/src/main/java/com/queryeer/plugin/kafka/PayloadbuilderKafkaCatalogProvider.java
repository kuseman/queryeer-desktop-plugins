package com.queryeer.plugin.kafka;

import static com.queryeer.backend.api.PayloadUtils.stringValue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderContributor;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogSqlEditorServices;

import se.kuseman.payloadbuilder.api.catalog.Catalog;
import se.kuseman.payloadbuilder.api.execution.IQuerySession;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.kafka.KafkaCatalog;

/**
 * The {@code kafka} payloadbuilder catalog over this plugin's connections. A file's catalog instance stores {@code { connectionId, topic? }}; before each run the connection is looked up in this
 * plugin's settings and handed to payloadbuilder's {@link KafkaCatalog} as bootstrap servers, security protocol and SASL settings. Table completion and hover come from the catalog's system tables.
 *
 * <p>
 * The plugin's own actions (topics, test connection) are not here: they are the plugin's backend actions ({@link KafkaBackendPlugin}), so they work without payloadbuilder.
 * </p>
 */
final class PayloadbuilderKafkaCatalogProvider implements PayloadbuilderCatalogProviderContributor
{
    static final String CATALOG_ID = "kafka";
    static final String KEY_CONNECTION_ID = "connectionId";

    private final KafkaConnections connections;
    private final KafkaCatalog catalog = new KafkaCatalog();

    PayloadbuilderKafkaCatalogProvider(KafkaConnections connections)
    {
        this.connections = connections;
    }

    @Override
    public String catalogId()
    {
        return CATALOG_ID;
    }

    @Override
    public Catalog createCatalog()
    {
        return catalog;
    }

    @Override
    public PayloadbuilderCatalogSqlEditorServices editorServices()
    {
        return PayloadbuilderCatalogSqlEditorServices.systemTables();
    }

    @Override
    public void injectProperties(IQuerySession session, String alias, Map<String, Object> properties)
    {
        clearCatalogProperties(session, alias);
        String connectionId = stringValue(properties, KEY_CONNECTION_ID);
        if (connectionId == null
                || connectionId.isBlank())
        {
            return;
        }
        KafkaConnections.Resolved connection;
        try
        {
            connection = connections.resolve(connections.find(connectionId));
        }
        catch (IllegalArgumentException e)
        {
            // Not found, disabled, or incomplete credentials: a problem with the file's catalog setup
            throw new IllegalArgumentException("Catalog '" + alias + "': " + e.getMessage(), e);
        }
        session.setCatalogProperty(alias, KafkaCatalog.BOOTSTRAP_SERVERS, connection.bootstrapServers());
        session.setCatalogProperty(alias, KafkaCatalog.SECURITY_PROTOCOL, connection.securityProtocol());
        if (connection.saslMechanism() != null)
        {
            session.setCatalogProperty(alias, KafkaCatalog.SASL_MECHANISM, connection.saslMechanism());
        }
        if (connection.saslJaasConfig() != null)
        {
            session.setCatalogProperty(alias, KafkaCatalog.SASL_JAAS_CONFIG, connection.saslJaasConfig());
        }
        if (connection.schemaRegistryUrl() != null)
        {
            session.setCatalogProperty(alias, KafkaCatalog.SCHEMA_REGISTRY_URL, connection.schemaRegistryUrl());
        }
        String topic = stringValue(properties, KafkaCatalog.TOPIC);
        if (topic != null
                && !topic.isBlank())
        {
            session.setCatalogProperty(alias, KafkaCatalog.TOPIC, topic);
        }
    }

    @Override
    public void clearProperties(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        clearCatalogProperties(session, alias);
    }

    /**
     * What a run changed that the file's catalog panel should show: a {@code connectionId} or {@code topic} the query set itself ({@code use kafka.topic = 'orders'}), or bootstrap servers it set
     * that are exactly one enabled connection's. Other bootstrap servers are left as an override for that run.
     */
    @Override
    public Map<String, Object> buildCatalogPatch(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        Map<String, Object> changed = new LinkedHashMap<>(PayloadbuilderCatalogProviderContributor.compareInputProperties(session, alias, inputProperties));
        if (changed.containsKey(KEY_CONNECTION_ID))
        {
            return changed;
        }
        ValueVector value = session.getCatalogProperty(alias, KafkaCatalog.BOOTSTRAP_SERVERS);
        String bootstrapServers = value == null
                || value.size() == 0
                || value.isNull(0) ? null
                        : value.valueAsString(0);
        String connectionId = stringValue(inputProperties, KEY_CONNECTION_ID);
        if (bootstrapServers == null
                || connectionId == null)
        {
            return changed;
        }
        List<KafkaConnectionSettings> matches = connections.all()
                .stream()
                .filter(KafkaConnectionSettings::enabled)
                .filter(connection -> bootstrapServers.equals(connection.bootstrapServers()))
                .toList();
        if (matches.size() == 1
                && !matches.get(0)
                        .connectionId()
                        .equals(connectionId))
        {
            changed.put(KEY_CONNECTION_ID, matches.get(0)
                    .connectionId());
        }
        return changed;
    }

    private static void clearCatalogProperties(IQuerySession session, String alias)
    {
        session.setCatalogProperty(alias, KEY_CONNECTION_ID, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.TOPIC, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.BOOTSTRAP_SERVERS, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.SCHEMA_REGISTRY_URL, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.SECURITY_PROTOCOL, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.SASL_MECHANISM, (Object) null);
        session.setCatalogProperty(alias, KafkaCatalog.SASL_JAAS_CONFIG, (Object) null);
    }
}
