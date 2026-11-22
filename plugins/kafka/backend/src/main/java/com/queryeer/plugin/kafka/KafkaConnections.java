package com.queryeer.plugin.kafka;

import java.util.List;
import java.util.Properties;

import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.SettingsModule;

/** The plugin's Kafka connections from its settings, resolved for a client: secrets from the vault, SASL credentials as a JAAS configuration. */
final class KafkaConnections
{
    private final ConfigService config;

    KafkaConnections(ConfigService config)
    {
        this.config = config;
    }

    /** Every connection in the settings, enabled or not. */
    List<KafkaConnectionSettings> all()
    {
        SettingsModule module = config.getModule(KafkaConnectionSettings.MODULE_ID);
        Object raw = module == null
                || module.values() == null ? null
                        : module.values()
                                .get(KafkaConnectionSettings.CONNECTIONS_SETTING_ID);
        return KafkaConnectionSettings.parseList(raw);
    }

    /** The enabled connection with this id; an {@link IllegalArgumentException} saying why when there is none. */
    KafkaConnectionSettings find(String connectionId)
    {
        for (KafkaConnectionSettings connection : all())
        {
            if (connection.connectionId()
                    .equals(connectionId))
            {
                if (!connection.enabled())
                {
                    throw new IllegalArgumentException("Kafka connection \"" + connection.displayName() + "\" is disabled");
                }
                return connection;
            }
        }
        throw new IllegalArgumentException("Kafka connection \"" + connectionId + "\" was not found. It may have been removed in settings");
    }

    /** What a client needs to connect, with secrets resolved. */
    Resolved resolve(KafkaConnectionSettings connection)
    {
        String mechanism = null;
        String jaasConfig = null;
        if (connection.sasl())
        {
            mechanism = connection.saslMechanism();
            if (mechanism == null)
            {
                throw new IllegalArgumentException("Kafka connection \"" + connection.displayName() + "\" uses " + connection.securityProtocol() + " but has no SASL mechanism");
            }
            jaasConfig = jaasConfig(connection, mechanism);
        }
        return new Resolved(connection.bootstrapServers(), connection.securityProtocol(), mechanism, jaasConfig, connection.schemaRegistryUrl());
    }

    private String jaasConfig(KafkaConnectionSettings connection, String mechanism)
    {
        if (KafkaConnectionSettings.USERNAME_PASSWORD_MECHANISMS.contains(mechanism))
        {
            String password = secret(connection.password());
            if (connection.username() == null
                    || password == null)
            {
                throw new IllegalArgumentException("Kafka connection \"" + connection.displayName() + "\" uses SASL " + mechanism + " and needs a username and a password");
            }
            String module = "PLAIN".equals(mechanism) ? "org.apache.kafka.common.security.plain.PlainLoginModule"
                    : "org.apache.kafka.common.security.scram.ScramLoginModule";
            return module + " required username=\"" + escape(connection.username()) + "\" password=\"" + escape(password) + "\";";
        }
        String jaas = secret(connection.saslJaasConfig());
        if (jaas == null
                && !"GSSAPI".equals(mechanism))
        {
            // GSSAPI may be configured for the whole JVM (java.security.auth.login.config); the others need their own
            throw new IllegalArgumentException("Kafka connection \"" + connection.displayName() + "\" uses SASL " + mechanism + " and needs a JAAS configuration");
        }
        return jaas;
    }

    private String secret(Object value)
    {
        Object materialized = config.materializeSecrets(value);
        return materialized instanceof String text
                && !text.isBlank() ? text
                        : null;
    }

    /** A JAAS option value goes in double quotes: escape what would end it. */
    static String escape(String value)
    {
        return value.replace("\\", "\\\\")
                .replace("\"", "\\\"");
    }

    /** A connection resolved for a client: every secret materialized. */
    record Resolved(String bootstrapServers, String securityProtocol, String saslMechanism, String saslJaasConfig, String schemaRegistryUrl)
    {
        /** Client properties for the plugin's own admin client. */
        Properties clientProperties()
        {
            Properties properties = new Properties();
            properties.put("bootstrap.servers", bootstrapServers);
            properties.put("client.id", "queryeer");
            properties.put("security.protocol", securityProtocol);
            if (saslMechanism != null)
            {
                properties.put("sasl.mechanism", saslMechanism);
            }
            if (saslJaasConfig != null)
            {
                properties.put("sasl.jaas.config", saslJaasConfig);
            }
            return properties;
        }
    }
}
