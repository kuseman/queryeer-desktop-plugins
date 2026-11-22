package com.queryeer.plugin.kafka;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * One Kafka connection as stored by the plugin's settings module. The frontend writes the same shape (connections.ts); keep the two in sync.
 *
 * @param securityProtocol {@code PLAINTEXT}, {@code SSL}, {@code SASL_PLAINTEXT} or {@code SASL_SSL}
 * @param saslMechanism with a SASL protocol: {@code PLAIN}, {@code SCRAM-SHA-256}, {@code SCRAM-SHA-512}, {@code OAUTHBEARER} or {@code GSSAPI}
 * @param password for PLAIN and SCRAM: plain string or a {@code { "secretRef": "..." }} object, resolved through {@code ConfigService.materializeSecrets}
 * @param saslJaasConfig for OAUTHBEARER and GSSAPI: the whole JAAS configuration, plain or a secret reference, as it may hold credentials
 */
record KafkaConnectionSettings(String connectionId, String title, String bootstrapServers, String securityProtocol, String saslMechanism, String username, Object password, Object saslJaasConfig,
        String schemaRegistryUrl, boolean enabled)
{
    static final String MODULE_ID = "com.queryeer.kafka.connections";
    static final String CONNECTIONS_SETTING_ID = MODULE_ID + ".list";

    static final String PLAINTEXT = "PLAINTEXT";
    static final Set<String> SECURITY_PROTOCOLS = Set.of(PLAINTEXT, "SSL", "SASL_PLAINTEXT", "SASL_SSL");
    static final Set<String> USERNAME_PASSWORD_MECHANISMS = Set.of("PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512");
    static final Set<String> JAAS_MECHANISMS = Set.of("OAUTHBEARER", "GSSAPI");

    /** Parses the raw settings value. Entries without an ID or bootstrap servers are skipped; the first entry wins for duplicate IDs. */
    static List<KafkaConnectionSettings> parseList(Object raw)
    {
        List<KafkaConnectionSettings> result = new ArrayList<>();
        if (!(raw instanceof List<?> list))
        {
            return result;
        }
        for (Object entry : list)
        {
            KafkaConnectionSettings connection = entry instanceof Map<?, ?> map ? parse(map)
                    : null;
            if (connection != null
                    && result.stream()
                            .noneMatch(c -> c.connectionId()
                                    .equals(connection.connectionId())))
            {
                result.add(connection);
            }
        }
        return result;
    }

    /** One entry, or null without an ID or bootstrap servers. An unknown security protocol counts as PLAINTEXT, as the settings editor shows it. */
    static KafkaConnectionSettings parse(Map<?, ?> map)
    {
        String connectionId = text(map.get("connectionId"));
        String bootstrapServers = text(map.get("bootstrapServers"));
        if (connectionId == null
                || bootstrapServers == null)
        {
            return null;
        }
        String protocol = upper(map.get("securityProtocol"));
        return new KafkaConnectionSettings(connectionId, text(map.get("title")), bootstrapServers, protocol != null
                && SECURITY_PROTOCOLS.contains(protocol) ? protocol
                : PLAINTEXT, upper(map.get("saslMechanism")), text(map.get("username")), map.get("password"), map.get("saslJaasConfig"), text(map.get("schemaRegistryUrl")),
                !Boolean.FALSE.equals(map.get("enabled")));
    }

    boolean sasl()
    {
        return securityProtocol.startsWith("SASL_");
    }

    String displayName()
    {
        return title == null ? connectionId
                : title;
    }

    private static String upper(Object value)
    {
        String text = text(value);
        return text == null ? null
                : text.toUpperCase(Locale.ROOT);
    }

    private static String text(Object value)
    {
        if (!(value instanceof String s))
        {
            return null;
        }
        String trimmed = s.trim();
        return trimmed.isEmpty() ? null
                : trimmed;
    }
}
