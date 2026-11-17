package com.queryeer.plugin.jdbc.mysql;

import static com.queryeer.backend.api.PayloadUtils.stringValue;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import com.queryeer.backend.queryengine.jdbc.JdbcDialect;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectMetadata;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryExecutor;

/**
 * One dialect for MySQL and MariaDB servers. It uses MariaDB Connector/J (LGPL), which supports both; MySQL Connector/J does not support MariaDB. The driver is never bundled: core's driver service
 * downloads it into {@code libShared}.
 *
 * <p>
 * Connection properties: {@code host} (required), {@code port} (default 3306), {@code database}, {@code sslMode} ({@link #SSL_MODES}), {@code username}, {@code password}.
 * </p>
 */
final class MySqlDialect implements JdbcDialect
{
    static final String DIALECT_ID = "mysql";
    static final String DRIVER_CLASS_NAME = "org.mariadb.jdbc.Driver";
    static final int DEFAULT_PORT = 3306;

    static final String KEY_HOST = "host";
    static final String KEY_PORT = "port";
    static final String KEY_DATABASE = "database";
    static final String KEY_SSL_MODE = "sslMode";

    /**
     * MariaDB Connector/J's {@code sslMode} values. Without one, the driver's default applies, which verifies the server certificate since version 4: a server with a self-signed certificate then needs
     * {@code trust}.
     */
    static final List<String> SSL_MODES = List.of("disable", "trust", "verify-ca", "verify-full");

    /** MariaDB Connector/J 3 and later accept only this scheme by default, so the URL never matches another installed driver. */
    private static final String URL_PREFIX = "jdbc:mariadb://";

    private final MySqlQueryExecutor queryExecutor = new MySqlQueryExecutor();

    @Override
    public JdbcDialectMetadata metadata()
    {
        return new JdbcDialectMetadata(DIALECT_ID, "MySQL / MariaDB", DEFAULT_PORT, URL_PREFIX + "<host>:<port>/<database>", DRIVER_CLASS_NAME);
    }

    @Override
    public JdbcQueryExecutor queryExecutor()
    {
        return queryExecutor;
    }

    @Override
    public String buildUrl(Map<String, Object> properties)
    {
        String host = stringValue(properties, KEY_HOST);
        if (host == null)
        {
            throw new IllegalArgumentException("host is required for MySQL and MariaDB connections");
        }
        StringBuilder url = new StringBuilder(URL_PREFIX).append(host)
                .append(':')
                .append(port(properties.get(KEY_PORT)))
                .append('/');
        String database = stringValue(properties, KEY_DATABASE);
        if (database != null)
        {
            url.append(encode(database));
        }
        String sslMode = stringValue(properties, KEY_SSL_MODE);
        if (sslMode != null)
        {
            if (!SSL_MODES.contains(sslMode))
            {
                throw new IllegalArgumentException("sslMode must be one of " + SSL_MODES + ": " + sslMode);
            }
            url.append("?sslMode=")
                    .append(sslMode);
        }
        return url.toString();
    }

    private static String encode(String value)
    {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    private static int port(Object value)
    {
        if (value instanceof Number number)
        {
            return number.intValue();
        }
        if (value instanceof String text
                && !text.isBlank())
        {
            try
            {
                return Integer.parseInt(text.strip());
            }
            catch (NumberFormatException e)
            {
                throw new IllegalArgumentException("port must be a number: " + text, e);
            }
        }
        return DEFAULT_PORT;
    }
}
