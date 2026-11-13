package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * One connection as stored by the plugin's settings module.
 *
 * @param password plain string or a {@code { "secretRef": "..." }} object; resolved through {@code ConfigService.materializeSecrets}
 */
record MongoConnectionSettings(String connectionId, String title, String hosts, boolean srv, String username, Object password, String authDatabase, boolean tls,
        boolean tlsAllowInvalidCertificates, String defaultDatabase, String options, boolean enabled)
{
    static final String MODULE_ID = "com.queryeer.mongodb";
    static final String CONNECTIONS_SETTING_ID = MODULE_ID + ".connections";
    static final String DEFAULT_AUTH_DATABASE = "admin";

    /** Parses the raw settings value. Entries without an ID or hosts are skipped; the first entry wins for duplicate IDs. */
    static List<MongoConnectionSettings> parseList(Object raw)
    {
        List<MongoConnectionSettings> result = new ArrayList<>();
        if (!(raw instanceof List<?> list))
        {
            return result;
        }
        for (Object entry : list)
        {
            if (!(entry instanceof Map<?, ?> map))
            {
                continue;
            }
            String connectionId = text(map.get("connectionId"));
            String hosts = text(map.get("hosts"));
            if (connectionId == null
                    || hosts == null
                    || result.stream()
                            .anyMatch(c -> c.connectionId()
                                    .equals(connectionId)))
            {
                continue;
            }
            result.add(new MongoConnectionSettings(connectionId, text(map.get("title")), hosts, bool(map.get("srv"), false), text(map.get("username")), map.get("password"),
                    text(map.get("authDatabase")), bool(map.get("tls"), false), bool(map.get("tlsAllowInvalidCertificates"), false), text(map.get("defaultDatabase")),
                    text(map.get("options")), bool(map.get("enabled"), true)));
        }
        return result;
    }

    /** Builds the connection string without credentials. Credentials are applied separately so the password never appears in a URI. */
    String connectionString()
    {
        StringBuilder sb = new StringBuilder(srv ? "mongodb+srv://"
                : "mongodb://");
        sb.append(hosts.replace(" ", ""));
        sb.append('/');
        if (options != null)
        {
            String trimmed = options.startsWith("?") ? options.substring(1)
                    : options;
            if (!trimmed.isBlank())
            {
                sb.append('?')
                        .append(trimmed);
            }
        }
        return sb.toString();
    }

    String effectiveAuthDatabase()
    {
        return authDatabase == null ? DEFAULT_AUTH_DATABASE
                : authDatabase;
    }

    String displayName()
    {
        return title == null ? connectionId
                : title;
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

    private static boolean bool(Object value, boolean defaultValue)
    {
        return value instanceof Boolean b ? b
                : defaultValue;
    }
}
