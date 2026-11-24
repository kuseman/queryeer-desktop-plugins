package com.queryeer.plugin.elasticsearch;

import java.util.List;

import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.SettingsModule;

/** The plugin's Elasticsearch connections from its settings, resolved for a client: the password from the vault. */
final class ElasticsearchConnections
{
    private final ConfigService config;

    ElasticsearchConnections(ConfigService config)
    {
        this.config = config;
    }

    /** Every connection in the settings, enabled or not. */
    List<ElasticsearchConnectionSettings> all()
    {
        SettingsModule module = config.getModule(ElasticsearchConnectionSettings.MODULE_ID);
        Object raw = module == null
                || module.values() == null ? null
                        : module.values()
                                .get(ElasticsearchConnectionSettings.CONNECTIONS_SETTING_ID);
        return ElasticsearchConnectionSettings.parseList(raw);
    }

    /** The enabled connection with this id; an {@link IllegalArgumentException} saying why when there is none. */
    ElasticsearchConnectionSettings find(String connectionId)
    {
        for (ElasticsearchConnectionSettings connection : all())
        {
            if (connection.connectionId()
                    .equals(connectionId))
            {
                if (!connection.enabled())
                {
                    throw new IllegalArgumentException("Elasticsearch connection \"" + connection.displayName() + "\" is disabled");
                }
                return connection;
            }
        }
        throw new IllegalArgumentException("Elasticsearch connection \"" + connectionId + "\" was not found. It may have been removed in settings");
    }

    /** What a client needs to connect, with the password resolved. */
    Resolved resolve(ElasticsearchConnectionSettings connection)
    {
        String username = null;
        String password = null;
        if (connection.basicAuth())
        {
            username = connection.authUsername();
            password = secret(connection.authPassword());
            if (username == null
                    || password == null)
            {
                throw new IllegalArgumentException("Elasticsearch connection \"" + connection.displayName() + "\" uses basic authentication and needs a username and a password");
            }
        }
        return new Resolved(connection.endpoint(), connection.authType(), username, password, connection.trustCertificate(), connection.connectTimeoutMs(), connection.receiveTimeoutMs());
    }

    private String secret(Object value)
    {
        Object materialized = config.materializeSecrets(value);
        return materialized instanceof String text
                && !text.isBlank() ? text
                        : null;
    }

    /**
     * A connection resolved for a client: the password materialized.
     *
     * @param username with {@code BASIC} auth, else null
     * @param password with {@code BASIC} auth, else null
     */
    record Resolved(String endpoint, String authType, String username, String password, boolean trustCertificate, Integer connectTimeoutMs, Integer receiveTimeoutMs)
    {
        boolean basicAuth()
        {
            return username != null;
        }

        @Override
        public String toString()
        {
            // Never print the password
            return "Resolved[endpoint=" + endpoint + ", authType=" + authType + ", trustCertificate=" + trustCertificate + "]";
        }
    }
}
