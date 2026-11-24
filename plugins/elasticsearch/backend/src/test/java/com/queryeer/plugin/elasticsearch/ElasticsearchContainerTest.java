package com.queryeer.plugin.elasticsearch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.StringWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.elasticsearch.ElasticsearchContainer;

import se.kuseman.payloadbuilder.core.JsonOutputWriter;
import se.kuseman.payloadbuilder.core.Payloadbuilder;
import se.kuseman.payloadbuilder.core.QueryResult;
import se.kuseman.payloadbuilder.core.catalog.CatalogRegistry;
import se.kuseman.payloadbuilder.core.execution.QuerySession;

/**
 * The plugin's actions and its payloadbuilder catalog against a single-node Elasticsearch 8 with security on: HTTPS with a self-signed certificate, and basic authentication.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ElasticsearchContainerTest
{
    /** The same version payloadbuilder's es catalog is tested against */
    private static final String IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.7.1";
    private static final String PASSWORD = "changeme";

    private ElasticsearchContainer elasticsearch;
    private String endpoint;
    private ElasticsearchConnections connections;

    @BeforeAll
    void startElasticsearch() throws Exception
    {
        assumeTrue(DockerClientFactory.instance()
                .isDockerAvailable(), "Docker is not available");
        elasticsearch = new ElasticsearchContainer(IMAGE).withPassword(PASSWORD)
                .withEnv("ES_JAVA_OPTS", "-Xms256m -Xmx512m")
                // A developer machine with a full disk would otherwise make the indices read-only
                .withEnv("cluster.routing.allocation.disk.threshold_enabled", "false");
        elasticsearch.start();
        endpoint = "https://" + elasticsearch.getHttpHostAddress();

        try (HttpClient client = HttpClient.newBuilder()
                .sslContext(elasticsearch.createSslContextFromCa())
                .build())
        {
            send(client, "PUT", "/orders", "{\"aliases\": {\"current-orders\": {}}}");
            send(client, "PUT", "/archive", null);
            for (int i = 1; i <= 3; i++)
            {
                send(client, "PUT", "/orders/_doc/o" + i + "?refresh=true", "{\"id\": " + i + ", \"customer\": \"c" + i + "\"}");
            }
        }

        connections = ElasticsearchConnectionsTest.connections(connection("secured", true, "elastic", Map.of("secretRef", "es")),
                connection("untrusted", false, "elastic", Map.of("secretRef", "es")), connection("wrong", true, "elastic", Map.of("secretRef", "pw")));
    }

    @AfterAll
    void stopElasticsearch()
    {
        if (elasticsearch != null)
        {
            elasticsearch.stop();
        }
    }

    @Test
    void listsAliasesThenIndicesWithoutHiddenOnes()
    {
        @SuppressWarnings("unchecked")
        List<String> indices = (List<String>) ElasticsearchBackendPlugin.listIndices(connections, Map.of("connectionId", "secured"))
                .get("indices");

        assertEquals(List.of("current-orders", "archive", "orders"), indices);
    }

    @Test
    void testsAConnectionThatIsNotSavedYet()
    {
        Map<String, Object> result = ElasticsearchBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new", "endpoint", endpoint, "authType", "BASIC",
                "authUsername", "elastic", "authPassword", Map.of("secretRef", "es"), "trustCertificate", true)));

        assertEquals(true, result.get("ok"), result.toString());
        assertEquals("8.7.1", result.get("version"));
        assertTrue(result.get("clusterName") instanceof String name
                && !name.isBlank(), result.toString());
    }

    @Test
    void saysWhatIsWrongWithTheCertificateOrTheCredentials()
    {
        assertTrue(message("untrusted").contains("isn't trusted. Turn on \"Trust certificate\""), message("untrusted"));
        assertEquals("Elasticsearch rejected the username or password", message("wrong"));
        Map<String, Object> noAuth = ElasticsearchBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new", "endpoint", endpoint, "trustCertificate",
                true)));
        assertEquals("Elasticsearch needs a username and a password", noAuth.get("message"));
        Map<String, Object> nobody = ElasticsearchBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new", "endpoint", "http://localhost:1")));
        assertEquals(false, nobody.get("ok"));
        assertFalse(String.valueOf(nobody.get("message"))
                .isBlank());
    }

    @Test
    void payloadbuilderQueriesThroughThePluginsCatalogAndConnection()
    {
        // The plugin's elasticsearch catalog with payloadbuilder's catalog code: the trusted self-signed certificate and basic authentication reach it
        PayloadbuilderElasticsearchCatalogProvider provider = new PayloadbuilderElasticsearchCatalogProvider(connections);
        CatalogRegistry registry = new CatalogRegistry();
        registry.registerCatalog("es", provider.createCatalog());
        QuerySession session = new QuerySession(registry);
        provider.injectProperties(session, "es", Map.of("connectionId", "secured", "index", "current-orders"));

        QueryResult result = Payloadbuilder.compile(session, "select x.customer from es#_doc x")
                .execute(session);
        StringWriter json = new StringWriter();
        JsonOutputWriter writer = new JsonOutputWriter(json);
        while (result.hasMoreResults())
        {
            result.writeResult(writer);
        }
        writer.close();

        String rows = json.toString()
                .replaceAll("\\s", "");
        for (String customer : List.of("c1", "c2", "c3"))
        {
            assertTrue(rows.contains("{\"customer\":\"" + customer + "\"}"), rows);
        }
        assertEquals(3, rows.split("\"customer\"", -1).length - 1, rows);
    }

    private String message(String connectionId)
    {
        ElasticsearchConnectionSettings connection = connections.find(connectionId);
        Map<String, Object> raw = new HashMap<>(connection("x", connection.trustCertificate(), connection.authUsername(), connection.authPassword()));
        Map<String, Object> result = ElasticsearchBackendPlugin.testConnection(connections, Map.of("connection", raw));
        assertEquals(false, result.get("ok"), result.toString());
        return String.valueOf(result.get("message"));
    }

    private Map<String, Object> connection(String connectionId, boolean trustCertificate, String username, Object password)
    {
        return Map.of("connectionId", connectionId, "endpoint", endpoint, "authType", "BASIC", "authUsername", username, "authPassword", password, "trustCertificate", trustCertificate);
    }

    private void send(HttpClient client, String method, String path, String body) throws Exception
    {
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint + path))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body))
                .header("Content-Type", "application/json")
                .header("Authorization", "Basic " + Base64.getEncoder()
                        .encodeToString(("elastic:" + PASSWORD).getBytes(StandardCharsets.UTF_8)))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertTrue(response.statusCode() < 300, method + " " + path + ": " + response.statusCode() + " " + response.body());
    }
}
