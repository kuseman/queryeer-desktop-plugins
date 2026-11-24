package com.queryeer.plugin.elasticsearch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.SettingsModule;

class ElasticsearchConnectionsTest
{
    @Test
    void parsesTheSettingsSkippingIncompleteAndDuplicateEntries()
    {
        List<ElasticsearchConnectionSettings> connections = ElasticsearchConnectionSettings.parseList(List.of(
                Map.of("connectionId", "local", "endpoint", " http://localhost:9200/ ", "title", "Local"), Map.of("connectionId", "local", "endpoint", "http://other:9200"),
                Map.of("connectionId", "noendpoint"), "not a map", Map.of("connectionId", "prod", "endpoint", "https://es:9200", "authType", "basic", "authUsername", "app", "trustCertificate",
                        true, "connectTimeoutMs", 2000, "receiveTimeoutMs", 60000.0, "enabled", false)));

        assertEquals(2, connections.size());
        ElasticsearchConnectionSettings local = connections.get(0);
        assertEquals("http://localhost:9200", local.endpoint());
        assertEquals("NONE", local.authType());
        assertEquals("Local", local.displayName());
        assertFalse(local.trustCertificate());
        assertNull(local.connectTimeoutMs());
        assertTrue(local.enabled());
        ElasticsearchConnectionSettings prod = connections.get(1);
        assertEquals("BASIC", prod.authType());
        assertTrue(prod.trustCertificate());
        assertEquals(2000, prod.connectTimeoutMs());
        assertEquals(60000, prod.receiveTimeoutMs());
        assertFalse(prod.enabled());
        assertEquals(List.of(), ElasticsearchConnectionSettings.parseList("[]"));
    }

    @Test
    void ignoresTimeoutsThatAreNotPositiveNumbers()
    {
        ElasticsearchConnectionSettings connection = ElasticsearchConnectionSettings.parse(Map.of("connectionId", "c", "endpoint", "http://es:9200", "connectTimeoutMs", 0, "receiveTimeoutMs",
                "5000"));

        assertNull(connection.connectTimeoutMs());
        assertNull(connection.receiveTimeoutMs());
        assertEquals("NONE", ElasticsearchConnectionSettings.parse(Map.of("connectionId", "c", "endpoint", "http://es:9200", "authType", "KERBEROS"))
                .authType());
    }

    @Test
    void findSaysWhyAConnectionCantBeUsed()
    {
        ElasticsearchConnections connections = connections(Map.of("connectionId", "off", "endpoint", "http://es:9200", "title", "Old cluster", "enabled", false));

        assertEquals("Elasticsearch connection \"Old cluster\" is disabled", assertThrows(IllegalArgumentException.class, () -> connections.find("off")).getMessage());
        assertEquals("Elasticsearch connection \"gone\" was not found. It may have been removed in settings",
                assertThrows(IllegalArgumentException.class, () -> connections.find("gone")).getMessage());
    }

    @Test
    void resolvesBasicAuthFromTheVault()
    {
        ElasticsearchConnections connections = connections(Map.of("connectionId", "prod", "endpoint", "https://es:9200", "authType", "BASIC", "authUsername", "app", "authPassword",
                Map.of("secretRef", "pw"), "trustCertificate", true, "connectTimeoutMs", 1500));

        ElasticsearchConnections.Resolved resolved = connections.resolve(connections.find("prod"));

        assertEquals("https://es:9200", resolved.endpoint());
        assertEquals("app", resolved.username());
        assertEquals("secret", resolved.password());
        assertTrue(resolved.trustCertificate());
        assertEquals(1500, resolved.connectTimeoutMs());
        assertFalse(resolved.toString()
                .contains("secret"));
    }

    @Test
    void basicAuthNeedsAUsernameAndAPassword()
    {
        ElasticsearchConnections connections = connections(Map.of("connectionId", "nouser", "endpoint", "https://es:9200", "authType", "BASIC", "authPassword", Map.of("secretRef", "pw")),
                Map.of("connectionId", "gone", "endpoint", "https://es:9200", "authType", "BASIC", "authUsername", "app", "authPassword", Map.of("secretRef", "missing")));

        String expected = " uses basic authentication and needs a username and a password";
        assertEquals("Elasticsearch connection \"nouser\"" + expected, assertThrows(IllegalArgumentException.class, () -> connections.resolve(connections.find("nouser"))).getMessage());
        // A vault entry that no longer exists
        assertEquals("Elasticsearch connection \"gone\"" + expected, assertThrows(IllegalArgumentException.class, () -> connections.resolve(connections.find("gone"))).getMessage());
    }

    @Test
    void noAuthHasNoCredentials()
    {
        ElasticsearchConnections connections = connections(Map.of("connectionId", "local", "endpoint", "http://localhost:9200", "authUsername", "leftover"));

        ElasticsearchConnections.Resolved resolved = connections.resolve(connections.find("local"));

        assertFalse(resolved.basicAuth());
        assertNull(resolved.username());
    }

    /** Connections in the plugin's settings module; the vault holds {@code pw} and {@code es}. */
    @SafeVarargs
    static ElasticsearchConnections connections(Map<String, Object>... connections)
    {
        return new ElasticsearchConnections(config(connections));
    }

    @SafeVarargs
    static ConfigService config(Map<String, Object>... connections)
    {
        // es: the password of ElasticsearchContainerTest's cluster
        Map<String, String> vault = new HashMap<>(Map.of("pw", "secret", "es", "changeme"));
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
                return ElasticsearchConnectionSettings.MODULE_ID.equals(moduleId)
                        ? new SettingsModule(moduleId, 1, "now", Map.of(ElasticsearchConnectionSettings.CONNECTIONS_SETTING_ID, List.of(connections)))
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
