package com.queryeer.plugin.jdbc.mysql;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

import com.queryeer.backend.queryengine.jdbc.JdbcConnection;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryEventListener;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryRequest;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryResult;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcResultColumn;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaObject;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaResolver;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaTarget;

/**
 * Runs the dialect against a real server. Skipped when Docker is not available. Each supported server has a subclass that names its image (e.g. {@link MySql84ContainerTest}); every test here runs
 * against each of them, always with the dialect's one driver.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class BaseMySqlContainerTest
{
    private static final String PASSWORD = "queryeer-test";
    private static final int PORT = 3306;

    private final String image;
    private final String envPrefix;
    private final boolean verifiesGeneratedCertificate;
    private GenericContainer<?> server;
    private Map<String, Object> properties;

    private final MySqlDialect dialect = new MySqlDialect();

    /**
     * @param image the server image, with an exact version, e.g. {@code mysql:8.4.13}
     * @param envPrefix the image's environment variable prefix: {@code MYSQL} or {@code MARIADB}
     * @param verifiesGeneratedCertificate whether the driver can verify the certificate the server generates for itself (MariaDB 11.4 and later: zero-configuration TLS)
     */
    BaseMySqlContainerTest(String image, String envPrefix, boolean verifiesGeneratedCertificate)
    {
        this.image = image;
        this.envPrefix = envPrefix;
        this.verifiesGeneratedCertificate = verifiesGeneratedCertificate;
    }

    @SuppressWarnings("resource")
    @BeforeAll
    void startServer() throws Exception
    {
        assumeTrue(DockerClientFactory.instance()
                .isDockerAvailable(), "Docker is not available");
        StringBuffer log = new StringBuffer();
        // Both images start a temporary server on port 0 to initialise, then the real one on 3306. Not 33060: MySQL's X Plugin logs that port too
        server = new GenericContainer<>(DockerImageName.parse(image)).withExposedPorts(PORT)
                .withEnv(envPrefix + "_ROOT_PASSWORD", PASSWORD)
                .withEnv(envPrefix + "_DATABASE", "shop")
                .withLogConsumer(frame -> log.append(frame.getUtf8String()))
                .waitingFor(Wait.forLogMessage("(?s).*port: " + PORT + "(?!\\d).*", 1)
                        .withStartupTimeout(Duration.ofMinutes(3)));
        try
        {
            server.start();
        }
        catch (RuntimeException e)
        {
            throw new IllegalStateException(image + " did not start. Container log:\n" + log, e);
        }
        // Trust works with both servers' generated certificates; see verifiesTheServerCertificateByDefault for the default
        properties = Map.of("host", server.getHost(), "port", server.getMappedPort(PORT), "database", "shop", "sslMode", "trust", "username", "root", "password", PASSWORD);

        try (Connection connection = dialect.openSessionConnection(properties);
                Statement statement = connection.createStatement())
        {
            statement.execute("CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(20), total DECIMAL(10, 2))");
            statement.execute("INSERT INTO orders VALUES (1, 'open', 10.50), (2, 'closed', 20.00), (3, 'open', 30.25)");
            statement.execute("CREATE DATABASE other");
            // One object of each kind the database tree lists
            statement.execute("CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50))");
            statement.execute("ALTER TABLE orders ADD COLUMN customer_id INT, ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)");
            statement.execute("CREATE INDEX ix_orders_status ON orders (status)");
            statement.execute("CREATE VIEW open_orders AS SELECT id, total FROM orders WHERE status = 'open'");
            statement.execute("CREATE PROCEDURE close_order(IN order_id INT) UPDATE orders SET status = 'closed' WHERE id = order_id");
            statement.execute("CREATE TRIGGER orders_default_status BEFORE INSERT ON orders FOR EACH ROW SET NEW.status = COALESCE(NEW.status, 'open')");
        }
    }

    /**
     * With SSL mode empty, the driver encrypts and verifies the server certificate. MariaDB 11.4 and later pass with the certificate they generate (the driver checks its fingerprint against the
     * password); MySQL's self-signed certificate does not, so MySQL needs {@code trust}. The SSL Mode field's description says the same.
     */
    @Test
    void verifiesTheServerCertificateByDefault() throws Exception
    {
        Map<String, Object> defaultSslMode = new HashMap<>(properties);
        defaultSslMode.remove("sslMode");
        if (!verifiesGeneratedCertificate)
        {
            assertThrows(SQLException.class, () -> dialect.openSessionConnection(defaultSslMode)
                    .close());
            return;
        }
        try (Connection connection = dialect.openSessionConnection(defaultSslMode);
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery("SHOW SESSION STATUS LIKE 'Ssl_cipher'"))
        {
            assertTrue(rs.next());
            assertFalse(rs.getString(2)
                    .isBlank(), "the session is not encrypted");
        }
    }

    /** The JDBC engine's default tree would list one database, {@code def}, which the server then refuses to switch to. */
    @Test
    void listsDatabasesAndTheirObjects()
    {
        JdbcConnection connection = new JdbcConnection("c1", "test", dialect, properties);
        Map<String, JdbcSchemaResolver> resolvers = dialect.branchResolvers();

        List<String> databases = names(resolvers.get("connection")
                .resolveSchema(connection, Map.of())
                .get(0)
                .children());
        assertTrue(databases.containsAll(List.of("shop", "other")), databases::toString);
        assertFalse(databases.contains("def"), databases::toString);

        // The frontend sends the target as a map; the schema crawler as a JdbcSchemaTarget
        List<JdbcSchemaObject> folders = resolvers.get("database")
                .resolveSchema(connection, Map.of("target", Map.of("database", "shop")));
        assertEquals(List.of("Tables", "Views", "Procedures", "Triggers"), names(folders));
        assertEquals("shop", folders.get(0)
                .attributes()
                .get("catalog"));

        Map<String, Object> shop = Map.of("target", new JdbcSchemaTarget("shop", null));
        assertEquals(List.of("customers", "orders"), names(resolvers.get("tables_folder")
                .resolveSchema(connection, shop)));
        assertEquals(List.of("open_orders"), names(resolvers.get("views_folder")
                .resolveSchema(connection, shop)));
        List<JdbcSchemaObject> procedures = resolvers.get("procedures_folder")
                .resolveSchema(connection, shop);
        assertEquals(List.of("close_order"), names(procedures));
        assertEquals(List.of("order_id"), names(procedures.get(0)
                .children()));
        assertEquals(List.of("orders_default_status"), names(resolvers.get("triggers_folder")
                .resolveSchema(connection, shop)));
        // Without a database in the target, the connection's current one (shop) is used
        assertEquals(List.of("customers", "orders"), names(resolvers.get("tables_folder")
                .resolveSchema(connection, Map.of())));
        assertEquals(List.of(), names(resolvers.get("tables_folder")
                .resolveSchema(connection, Map.of("target", Map.of("database", "other")))));

        Map<String, Object> orders = Map.of("target", new JdbcSchemaTarget("shop", null, "orders"));
        List<JdbcSchemaObject> columns = resolvers.get("columns_folder")
                .resolveSchema(connection, orders);
        assertEquals(List.of("id", "status", "total", "customer_id"), names(columns));
        assertEquals(true, columns.get(0)
                .attributes()
                .get("primaryKey"));
        assertEquals("customers", columns.get(3)
                .attributes()
                .get("referencesTable"));
        List<JdbcSchemaObject> indexes = resolvers.get("indexes_folder")
                .resolveSchema(connection, orders);
        assertTrue(names(indexes).containsAll(List.of("PRIMARY", "ix_orders_status")), names(indexes)::toString);
        assertEquals(true, indexes.stream()
                .filter(index -> index.name()
                        .equals("PRIMARY"))
                .findFirst()
                .orElseThrow()
                .attributes()
                .get("unique"));
    }

    private static List<String> names(List<JdbcSchemaObject> objects)
    {
        return objects == null ? List.of()
                : objects.stream()
                        .map(JdbcSchemaObject::name)
                        .toList();
    }

    @AfterAll
    void stopServer()
    {
        if (server != null)
        {
            server.stop();
        }
    }

    @Test
    void runsAQuery()
    {
        Captured captured = execute("SELECT id, status, total FROM orders WHERE status = 'open' ORDER BY id", null);

        assertEquals(List.of("id", "status", "total"), captured.columns.stream()
                .map(JdbcResultColumn::name)
                .toList());
        assertEquals(2, captured.rows.size());
        assertEquals(List.of(1, "open"), captured.rows.get(0)
                .subList(0, 2));
        assertEquals("shop", captured.result.engineState()
                .get("database"));
    }

    @Test
    void switchesDatabase()
    {
        Captured captured = execute("SELECT DATABASE()", "other");

        assertEquals("other", captured.rows.get(0)
                .get(0));
        assertEquals("other", captured.result.engineState()
                .get("database"));
    }

    private Captured execute(String sql, String database)
    {
        Captured captured = new Captured();
        JdbcQueryRequest request = new JdbcQueryRequest("q1", "file1", sql, "c1", properties, null, database, dialect, null);
        captured.result = dialect.queryExecutor()
                .execute(request, captured);
        return captured;
    }

    private static final class Captured implements JdbcQueryEventListener
    {
        private final List<JdbcResultColumn> columns = new ArrayList<>();
        private final List<List<Object>> rows = new ArrayList<>();
        private JdbcQueryResult result;

        @Override
        public void onResultSetStart(List<JdbcResultColumn> resultColumns)
        {
            columns.addAll(resultColumns);
        }

        @Override
        public void onRows(List<List<Object>> chunk)
        {
            rows.addAll(chunk);
        }
    }
}
