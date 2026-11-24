package com.queryeer.plugin.elasticsearch;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * One Elasticsearch connection as stored by the plugin's settings module. The frontend writes the same shape (connections.ts); keep the two in sync. The fields of Queryeer's built-in connections
 * keep their names, so the frontend's migration copies them as they are.
 *
 * @param endpoint the cluster's URL, {@code https://host:9200}, without a trailing slash
 * @param authType {@code NONE} or {@code BASIC}
 * @param authPassword with {@code BASIC}: a {@code { "secretRef": "..." }} object, resolved through {@code ConfigService.materializeSecrets}
 * @param trustCertificate accept any server certificate and host name, e.g. a cluster with a self-signed certificate
 * @param connectTimeoutMs null for payloadbuilder's default
 * @param receiveTimeoutMs null for payloadbuilder's default
 */
record ElasticsearchConnectionSettings(String connectionId, String title, String endpoint, String authType, String authUsername, Object authPassword, boolean trustCertificate,
        Integer connectTimeoutMs, Integer receiveTimeoutMs, boolean enabled)
{
    static final String MODULE_ID = "com.queryeer.elasticsearch.connections";
    static final String CONNECTIONS_SETTING_ID = MODULE_ID + ".list";

    static final String AUTH_NONE = "NONE";
    static final String AUTH_BASIC = "BASIC";

    /** Parses the raw settings value. Entries without an ID or endpoint are skipped; the first entry wins for duplicate IDs. */
    static List<ElasticsearchConnectionSettings> parseList(Object raw)
    {
        List<ElasticsearchConnectionSettings> result = new ArrayList<>();
        if (!(raw instanceof List<?> list))
        {
            return result;
        }
        for (Object entry : list)
        {
            ElasticsearchConnectionSettings connection = entry instanceof Map<?, ?> map ? parse(map)
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

    /** One entry, or null without an ID or endpoint. An unknown auth type counts as {@code NONE}, as the settings editor shows it. */
    static ElasticsearchConnectionSettings parse(Map<?, ?> map)
    {
        String connectionId = text(map.get("connectionId"));
        String endpoint = text(map.get("endpoint"));
        if (connectionId == null
                || endpoint == null)
        {
            return null;
        }
        while (endpoint.endsWith("/"))
        {
            endpoint = endpoint.substring(0, endpoint.length() - 1);
        }
        String authType = text(map.get("authType"));
        return new ElasticsearchConnectionSettings(connectionId, text(map.get("title")), endpoint, authType != null
                && AUTH_BASIC.equals(authType.toUpperCase(Locale.ROOT)) ? AUTH_BASIC
                        : AUTH_NONE,
                text(map.get("authUsername")), map.get("authPassword"), Boolean.TRUE.equals(map.get("trustCertificate")), positive(map.get("connectTimeoutMs")),
                positive(map.get("receiveTimeoutMs")), !Boolean.FALSE.equals(map.get("enabled")));
    }

    boolean basicAuth()
    {
        return AUTH_BASIC.equals(authType);
    }

    String displayName()
    {
        return title == null ? connectionId
                : title;
    }

    private static Integer positive(Object value)
    {
        return value instanceof Number number
                && number.doubleValue() >= 1
                && number.doubleValue() <= Integer.MAX_VALUE ? number.intValue()
                        : null;
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
