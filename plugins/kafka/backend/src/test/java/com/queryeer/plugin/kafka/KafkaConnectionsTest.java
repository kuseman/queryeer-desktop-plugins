package com.queryeer.plugin.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.SettingsModule;

class KafkaConnectionsTest
{
    @Test
    void parsesTheSettingsSkippingIncompleteAndDuplicateEntries()
    {
        List<KafkaConnectionSettings> connections = KafkaConnectionSettings.parseList(List.of(Map.of("connectionId", "local", "bootstrapServers", " localhost:9092 ", "title", "Local"),
                Map.of("connectionId", "local", "bootstrapServers", "other:9092"), Map.of("connectionId", "nobootstrap"), "not a map",
                Map.of("connectionId", "prod", "bootstrapServers", "b1:9093,b2:9093", "securityProtocol", "sasl_ssl", "saslMechanism", "scram-sha-512", "enabled", false)));

        assertEquals(2, connections.size());
        KafkaConnectionSettings local = connections.get(0);
        assertEquals("localhost:9092", local.bootstrapServers());
        assertEquals("PLAINTEXT", local.securityProtocol());
        assertEquals("Local", local.displayName());
        assertTrue(local.enabled());
        KafkaConnectionSettings prod = connections.get(1);
        assertEquals("SASL_SSL", prod.securityProtocol());
        assertEquals("SCRAM-SHA-512", prod.saslMechanism());
        assertFalse(prod.enabled());
        assertEquals(List.of(), KafkaConnectionSettings.parseList("[]"));
    }

    @Test
    void anUnknownSecurityProtocolIsPlaintext()
    {
        assertEquals("PLAINTEXT", KafkaConnectionSettings.parse(Map.of("connectionId", "c", "bootstrapServers", "b:9092", "securityProtocol", "SOMETHING"))
                .securityProtocol());
    }

    @Test
    void findSaysWhyAConnectionCantBeUsed()
    {
        KafkaConnections connections = connections(Map.of("connectionId", "off", "bootstrapServers", "b:9092", "title", "Old cluster", "enabled", false));

        assertEquals("Kafka connection \"Old cluster\" is disabled", assertThrows(IllegalArgumentException.class, () -> connections.find("off")).getMessage());
        assertEquals("Kafka connection \"gone\" was not found. It may have been removed in settings", assertThrows(IllegalArgumentException.class, () -> connections.find("gone")).getMessage());
    }

    @Test
    void resolvesPlaintextWithoutSasl()
    {
        KafkaConnections connections = connections(Map.of("connectionId", "local", "bootstrapServers", "localhost:9092", "schemaRegistryUrl", "http://localhost:8081"));

        KafkaConnections.Resolved resolved = connections.resolve(connections.find("local"));

        assertEquals(new KafkaConnections.Resolved("localhost:9092", "PLAINTEXT", null, null, "http://localhost:8081"), resolved);
        Properties properties = resolved.clientProperties();
        assertEquals("localhost:9092", properties.get("bootstrap.servers"));
        assertEquals("PLAINTEXT", properties.get("security.protocol"));
        assertFalse(properties.containsKey("sasl.mechanism"));
        assertFalse(properties.containsKey("sasl.jaas.config"));
    }

    @Test
    void buildsTheJaasConfigForPlainAndScramFromTheVaultPassword()
    {
        KafkaConnections connections = connections(
                Map.of("connectionId", "plain", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "PLAIN", "username", "app", "password",
                        Map.of("secretRef", "pw")),
                Map.of("connectionId", "scram", "bootstrapServers", "b:9093", "securityProtocol", "SASL_PLAINTEXT", "saslMechanism", "SCRAM-SHA-256", "username", "a\"b", "password",
                        Map.of("secretRef", "pw")));

        assertEquals("org.apache.kafka.common.security.plain.PlainLoginModule required username=\"app\" password=\"p\\\"w\\\\d\";", connections.resolve(connections.find("plain"))
                .saslJaasConfig());
        KafkaConnections.Resolved scram = connections.resolve(connections.find("scram"));
        assertEquals("org.apache.kafka.common.security.scram.ScramLoginModule required username=\"a\\\"b\" password=\"p\\\"w\\\\d\";", scram.saslJaasConfig());
        assertEquals("SCRAM-SHA-256", scram.clientProperties()
                .get("sasl.mechanism"));
    }

    @Test
    void saysWhatSaslSettingsAreMissing()
    {
        KafkaConnections connections = connections(Map.of("connectionId", "nomech", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL"),
                Map.of("connectionId", "nopw", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "PLAIN", "username", "app"),
                Map.of("connectionId", "oauth", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "OAUTHBEARER"),
                Map.of("connectionId", "kerberos", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "GSSAPI"));

        assertEquals("Kafka connection \"nomech\" uses SASL_SSL but has no SASL mechanism", resolveError(connections, "nomech"));
        assertEquals("Kafka connection \"nopw\" uses SASL PLAIN and needs a username and a password", resolveError(connections, "nopw"));
        assertEquals("Kafka connection \"oauth\" uses SASL OAUTHBEARER and needs a JAAS configuration", resolveError(connections, "oauth"));
        // GSSAPI may be set up for the whole JVM
        assertNull(connections.resolve(connections.find("kerberos"))
                .saslJaasConfig());
    }

    @Test
    void takesTheJaasConfigFromTheVaultForOauthbearer()
    {
        KafkaConnections connections = connections(Map.of("connectionId", "oauth", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "OAUTHBEARER", "saslJaasConfig",
                Map.of("secretRef", "jaas")));

        assertEquals("org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;", connections.resolve(connections.find("oauth"))
                .saslJaasConfig());
    }

    private static String resolveError(KafkaConnections connections, String connectionId)
    {
        return assertThrows(IllegalArgumentException.class, () -> connections.resolve(connections.find(connectionId))).getMessage();
    }

    /** Connections in the plugin's settings module; the vault holds {@code pw} and {@code jaas}. */
    @SafeVarargs
    static KafkaConnections connections(Map<String, Object>... connections)
    {
        return new KafkaConnections(config(connections));
    }

    @SafeVarargs
    static ConfigService config(Map<String, Object>... connections)
    {
        Map<String, String> vault = new HashMap<>(Map.of("pw", "p\"w\\d", "jaas", "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;"));
        return new ConfigService()
        {
            @Override
            public String get(String key)
            {
                return null;
            }

            @Override
            public SettingsModule getModule(String moduleId)
            {
                return KafkaConnectionSettings.MODULE_ID.equals(moduleId) ? new SettingsModule(moduleId, 1, "now", Map.of(KafkaConnectionSettings.CONNECTIONS_SETTING_ID, List.of(connections)))
                        : null;
            }

            @Override
            public Object materializeSecrets(Object value)
            {
                return value instanceof Map<?, ?> ref
                        && ref.get("secretRef") instanceof String id ? vault.get(id)
                                : value;
            }
        };
    }
}
