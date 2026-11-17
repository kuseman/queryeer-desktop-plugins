package com.queryeer.plugin.jdbc.mysql;

import static com.queryeer.backend.api.PayloadUtils.stringValue;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.queryeer.backend.queryengine.jdbc.JdbcConnection;
import com.queryeer.backend.queryengine.jdbc.JdbcDialect;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectMetadata;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryExecutor;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaResolver;
import com.queryeer.backend.queryengine.jdbc.setup.JdbcConnectionFieldDefinition;
import com.queryeer.backend.queryengine.jdbc.setup.JdbcConnectionFieldOption;
import com.queryeer.backend.queryengine.jdbc.setup.JdbcConnectionFieldType;
import com.queryeer.backend.queryengine.jdbc.setup.JdbcConnectionSetupDefinition;

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
     * MariaDB Connector/J's {@code sslMode} values. Without one, the driver's default applies, which since version 4 encrypts and verifies the server certificate. MariaDB 11.4 and later pass that check
     * with the certificate they generate themselves ("zero-configuration TLS": the driver checks its fingerprint against the password, so a password is needed). MySQL's self-signed certificate does not
     * pass, so MySQL without a proper certificate needs {@code trust}.
     */
    static final List<String> SSL_MODES = List.of("disable", "trust", "verify-ca", "verify-full");

    /** MariaDB Connector/J 3 and later accept only this scheme by default, so the URL never matches another installed driver. */
    private static final String URL_PREFIX = "jdbc:mariadb://";

    private final MySqlQueryExecutor queryExecutor = new MySqlQueryExecutor();
    private final Map<String, JdbcSchemaResolver> branchResolvers = new MySqlSchemaResolvers(this).resolvers();

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

    /** The default tree would list one database, {@code def}: see {@link MySqlSchemaResolvers}. */
    @Override
    public Map<String, JdbcSchemaResolver> branchResolvers()
    {
        return branchResolvers;
    }

    /** Queryeer renders the connection form from these fields; their ids are the properties {@link #buildUrl(Map)} reads. */
    @Override
    public Optional<JdbcConnectionSetupDefinition> connectionSetup()
    {
        List<JdbcConnectionFieldOption> sslModes = List.of(new JdbcConnectionFieldOption("disable", "Disable"),
                new JdbcConnectionFieldOption("trust", "Trust (encrypt, accept any certificate)"), new JdbcConnectionFieldOption("verify-ca", "Verify CA (check the certificate)"),
                new JdbcConnectionFieldOption("verify-full", "Verify Full (check the certificate and host name)"));
        return Optional.of(new JdbcConnectionSetupDefinition(List.of(
                new JdbcConnectionFieldDefinition(KEY_HOST, "Host", JdbcConnectionFieldType.TEXT, true, "Host name or IP address of the MySQL or MariaDB server", List.of(), null, null),
                new JdbcConnectionFieldDefinition(KEY_PORT, "Port", JdbcConnectionFieldType.NUMBER, false, null, List.of(), DEFAULT_PORT, null),
                new JdbcConnectionFieldDefinition(KEY_DATABASE, "Database", JdbcConnectionFieldType.TEXT, false, "Initial database (optional)", List.of(), null, null),
                new JdbcConnectionFieldDefinition(JdbcConnection.KEY_USERNAME, "Username", JdbcConnectionFieldType.TEXT, true, null, List.of(), null, null),
                new JdbcConnectionFieldDefinition(JdbcConnection.KEY_PASSWORD, "Password", JdbcConnectionFieldType.SECRET, false, "Stored in the security vault", List.of(), null, null),
                new JdbcConnectionFieldDefinition(KEY_SSL_MODE, "SSL Mode", JdbcConnectionFieldType.SELECT, false,
                        "Empty: the driver's default, which encrypts and verifies the server certificate. MariaDB 11.4 and later pass with their own generated certificate; MySQL's self-signed certificate needs Trust.",
                        sslModes, null, null))));
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
