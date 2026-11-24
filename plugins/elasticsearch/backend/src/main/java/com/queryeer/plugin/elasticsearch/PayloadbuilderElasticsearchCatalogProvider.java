package com.queryeer.plugin.elasticsearch;

import static com.queryeer.backend.api.PayloadUtils.stringValue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderContributor;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogSqlEditorServices;

import se.kuseman.payloadbuilder.api.catalog.Catalog;
import se.kuseman.payloadbuilder.api.execution.IQuerySession;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.es.ESCatalog;

/**
 * The {@code elasticsearch} payloadbuilder catalog over this plugin's connections. A file's catalog instance stores {@code { connectionId, index? }}, as with Queryeer's built-in catalog; before each
 * run the connection is looked up in this plugin's settings and handed to payloadbuilder's {@link ESCatalog} as endpoint, credentials, certificate trust and timeouts. Table completion and hover come
 * from the catalog's system tables.
 *
 * <p>
 * The plugin's own actions (indices, test connection) are not here: they are the plugin's backend actions ({@link ElasticsearchBackendPlugin}), so they work without payloadbuilder.
 * </p>
 */
final class PayloadbuilderElasticsearchCatalogProvider implements PayloadbuilderCatalogProviderContributor
{
    static final String CATALOG_ID = "elasticsearch";
    static final String KEY_CONNECTION_ID = "connectionId";

    private final ElasticsearchConnections connections;
    private final ESCatalog catalog = new ESCatalog();

    PayloadbuilderElasticsearchCatalogProvider(ElasticsearchConnections connections)
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
        ElasticsearchConnections.Resolved connection;
        try
        {
            connection = connections.resolve(connections.find(connectionId));
        }
        catch (IllegalArgumentException e)
        {
            // Not found, disabled, or incomplete credentials: a problem with the file's catalog setup
            throw new IllegalArgumentException("Catalog '" + alias + "': " + e.getMessage(), e);
        }
        session.setCatalogProperty(alias, ESCatalog.ENDPOINT_KEY, connection.endpoint());
        session.setCatalogProperty(alias, ESCatalog.AUTH_TYPE_KEY, connection.authType());
        if (connection.basicAuth())
        {
            session.setCatalogProperty(alias, ESCatalog.AUTH_USERNAME_KEY, connection.username());
            // As an Object: the catalog reads the password with valueAsObject and takes a String or char[], not the UTF8String the String overload stores
            session.setCatalogProperty(alias, ESCatalog.AUTH_PASSWORD_KEY, (Object) connection.password());
        }
        // The catalog reads these as Boolean and Integer: unset, it uses its own defaults
        if (connection.trustCertificate())
        {
            session.setCatalogProperty(alias, ESCatalog.TRUSTCERTIFICATE_KEY, true);
        }
        if (connection.connectTimeoutMs() != null)
        {
            session.setCatalogProperty(alias, ESCatalog.CONNECT_TIMEOUT_KEY, connection.connectTimeoutMs()
                    .intValue());
        }
        if (connection.receiveTimeoutMs() != null)
        {
            session.setCatalogProperty(alias, ESCatalog.RECEIVE_TIMEOUT_KEY, connection.receiveTimeoutMs()
                    .intValue());
        }
        String index = stringValue(properties, ESCatalog.INDEX_KEY);
        if (index != null
                && !index.isBlank())
        {
            session.setCatalogProperty(alias, ESCatalog.INDEX_KEY, index);
        }
    }

    @Override
    public void clearProperties(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        clearCatalogProperties(session, alias);
    }

    /**
     * What a run changed that the file's catalog panel should show: a {@code connectionId} or {@code index} the query set itself ({@code use es.index = 'orders'}), or an endpoint it set that is
     * exactly one enabled connection's. Another endpoint is left as an override for that run.
     */
    @Override
    public Map<String, Object> buildCatalogPatch(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        Map<String, Object> changed = new LinkedHashMap<>(PayloadbuilderCatalogProviderContributor.compareInputProperties(session, alias, inputProperties));
        if (changed.containsKey(KEY_CONNECTION_ID))
        {
            return changed;
        }
        ValueVector value = session.getCatalogProperty(alias, ESCatalog.ENDPOINT_KEY);
        String endpoint = value == null
                || value.size() == 0
                || value.isNull(0) ? null
                        : trimSlash(value.valueAsString(0));
        String connectionId = stringValue(inputProperties, KEY_CONNECTION_ID);
        if (endpoint == null
                || connectionId == null)
        {
            return changed;
        }
        List<ElasticsearchConnectionSettings> matches = connections.all()
                .stream()
                .filter(ElasticsearchConnectionSettings::enabled)
                .filter(connection -> endpoint.equals(connection.endpoint()))
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

    private static String trimSlash(String endpoint)
    {
        String result = endpoint.trim();
        while (result.endsWith("/"))
        {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static void clearCatalogProperties(IQuerySession session, String alias)
    {
        session.setCatalogProperty(alias, KEY_CONNECTION_ID, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.INDEX_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.ENDPOINT_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.AUTH_TYPE_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.AUTH_USERNAME_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.AUTH_PASSWORD_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.TRUSTCERTIFICATE_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.CONNECT_TIMEOUT_KEY, (Object) null);
        session.setCatalogProperty(alias, ESCatalog.RECEIVE_TIMEOUT_KEY, (Object) null);
    }
}
