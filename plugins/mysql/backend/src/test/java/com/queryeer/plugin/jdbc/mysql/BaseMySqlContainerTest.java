package com.queryeer.plugin.jdbc.mysql;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.sql.Connection;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
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

import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryEventListener;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryRequest;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcQueryResult;
import com.queryeer.backend.queryengine.jdbc.execute.JdbcResultColumn;

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
    private GenericContainer<?> server;
    private Map<String, Object> properties;

    private final MySqlDialect dialect = new MySqlDialect();

    /**
     * @param image the server image, with an exact version, e.g. {@code mysql:8.4.13}
     * @param envPrefix the image's environment variable prefix: {@code MYSQL} or {@code MARIADB}
     */
    BaseMySqlContainerTest(String image, String envPrefix)
    {
        this.image = image;
        this.envPrefix = envPrefix;
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
        // The images generate a self-signed certificate, which the driver refuses to verify
        properties = Map.of("host", server.getHost(), "port", server.getMappedPort(PORT), "database", "shop", "sslMode", "trust", "username", "root", "password", PASSWORD);

        try (Connection connection = dialect.openSessionConnection(properties);
                Statement statement = connection.createStatement())
        {
            statement.execute("CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(20), total DECIMAL(10, 2))");
            statement.execute("INSERT INTO orders VALUES (1, 'open', 10.50), (2, 'closed', 20.00), (3, 'open', 30.25)");
            statement.execute("CREATE DATABASE other");
        }
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
