package com.queryeer.plugin.mongodb;

import static com.queryeer.backend.api.PayloadUtils.stringValue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderContributor;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogSqlEditorServices;

import se.kuseman.payloadbuilder.api.catalog.Catalog;
import se.kuseman.payloadbuilder.api.execution.IQuerySession;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.mongodb.MongoCatalog;

/**
 * The {@code mongodb} payloadbuilder catalog over this plugin's connections. A file's catalog instance stores {@code { connectionId }}; before each run the connection is looked up in this
 * plugin's settings and handed to payloadbuilder's {@link MongoCatalog} as a connection string with credentials.
 *
 * <p>
 * Payloadbuilder's catalog builds its own client from these properties; a TLS connection that allows invalid certificates also sets {@link MongoCatalog#TLS_ALLOW_INVALID_CERTIFICATES_KEY}
 * (payloadbuilder 1.16). Table and column completion, hover and symbols come from the catalog's system tables ({@link PayloadbuilderCatalogSqlEditorServices#systemTables()},
 * Queryeer 0.22), as for Queryeer's built-in catalogs.
 * </p>
 */
final class PayloadbuilderMongoCatalogProvider implements PayloadbuilderCatalogProviderContributor
{
    static final String CATALOG_ID = "mongodb";
    static final String KEY_CONNECTION_ID = "connectionId";

    private final MongoClientCache clients;
    private final MongoCatalog catalog = new MongoCatalog();

    PayloadbuilderMongoCatalogProvider(MongoClientCache clients)
    {
        this.clients = clients;
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
        MongoConnectionSettings connection;
        String password;
        try
        {
            connection = clients.findSettings(connectionId);
            password = clients.resolvePassword(connection);
        }
        catch (QueryValidationException e)
        {
            // Not found, disabled, or no password: a problem with the file's catalog setup, not an internal error
            throw new IllegalArgumentException("Catalog '" + alias + "': " + e.getMessage(), e);
        }
        session.setCatalogProperty(alias, MongoCatalog.CONNECTIONSTRING_KEY, catalogConnectionString(connection));
        if (connection.tls()
                && connection.tlsAllowInvalidCertificates())
        {
            // As the plugin's own client: trust any certificate and host name, only on a TLS connection
            session.setCatalogProperty(alias, MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY, true);
        }
        if (connection.username() != null)
        {
            session.setCatalogProperty(alias, MongoCatalog.AUTH_USERNAME_KEY, connection.username());
            session.setCatalogProperty(alias, MongoCatalog.AUTH_PASSWORD_KEY, password);
            session.setCatalogProperty(alias, MongoCatalog.AUTH_DATABASE_KEY, connection.effectiveAuthDatabase());
        }
    }

    @Override
    public void clearProperties(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        clearCatalogProperties(session, alias);
    }

    /**
     * What a run changed that the file's catalog panel should show: a {@code connectionId} the query set itself ({@code use mongo.connectionId = 'other'}), or a connection string it set that is
     * exactly one enabled connection's. Any other connection string is left as an override for that run; the next run connects with the picked connection again.
     */
    @Override
    public Map<String, Object> buildCatalogPatch(IQuerySession session, String alias, Map<String, Object> inputProperties)
    {
        Map<String, Object> changed = new LinkedHashMap<>(PayloadbuilderCatalogProviderContributor.compareInputProperties(session, alias, inputProperties));
        if (changed.containsKey(KEY_CONNECTION_ID))
        {
            return changed;
        }
        ValueVector value = session.getCatalogProperty(alias, MongoCatalog.CONNECTIONSTRING_KEY);
        String connectionString = value == null
                || value.size() == 0
                || value.isNull(0) ? null
                        : value.valueAsString(0);
        String connectionId = stringValue(inputProperties, KEY_CONNECTION_ID);
        if (connectionString == null
                || connectionId == null)
        {
            return changed;
        }
        List<MongoConnectionSettings> matches = clients.allSettings()
                .stream()
                .filter(MongoConnectionSettings::enabled)
                .filter(connection -> connectionString.equals(catalogConnectionString(connection)))
                .toList();
        if (matches.size() == 1
                && matches.stream()
                        .noneMatch(connection -> connection.connectionId()
                                .equals(connectionId)))
        {
            changed.put(KEY_CONNECTION_ID, matches.get(0)
                    .connectionId());
        }
        return changed;
    }

    /** The connection string payloadbuilder's catalog connects with: hosts and options as the plugin's own client uses them, plus TLS, which the plugin's client sets in code. */
    static String catalogConnectionString(MongoConnectionSettings connection)
    {
        String connectionString = connection.connectionString();
        if (!connection.tls())
        {
            return connectionString;
        }
        return connectionString + (connectionString.contains("?") ? "&"
                : "?") + "tls=true";
    }

    private static void clearCatalogProperties(IQuerySession session, String alias)
    {
        session.setCatalogProperty(alias, KEY_CONNECTION_ID, (Object) null);
        session.setCatalogProperty(alias, MongoCatalog.CONNECTIONSTRING_KEY, (Object) null);
        session.setCatalogProperty(alias, MongoCatalog.AUTH_USERNAME_KEY, (Object) null);
        session.setCatalogProperty(alias, MongoCatalog.AUTH_PASSWORD_KEY, (Object) null);
        session.setCatalogProperty(alias, MongoCatalog.AUTH_DATABASE_KEY, (Object) null);
        session.setCatalogProperty(alias, MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY, (Object) null);
    }
}
