package com.queryeer.plugin.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.ByteArraySerializer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.kafka.KafkaContainer;

import se.kuseman.payloadbuilder.core.JsonOutputWriter;
import se.kuseman.payloadbuilder.core.Payloadbuilder;
import se.kuseman.payloadbuilder.core.QueryResult;
import se.kuseman.payloadbuilder.core.catalog.CatalogRegistry;
import se.kuseman.payloadbuilder.core.execution.QuerySession;

/** The plugin's actions and its payloadbuilder catalog against a single-node Kafka (KRaft). */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class KafkaContainerTest
{
    /** The same image payloadbuilder's kafka catalog is tested against */
    private static final String IMAGE = "apache/kafka:3.7.0";

    private KafkaContainer kafka;
    private KafkaConnections connections;

    @BeforeAll
    void startKafka() throws Exception
    {
        assumeTrue(DockerClientFactory.instance()
                .isDockerAvailable(), "Docker is not available");
        kafka = new KafkaContainer(IMAGE);
        kafka.start();

        Properties properties = new Properties();
        properties.put("bootstrap.servers", kafka.getBootstrapServers());
        try (AdminClient admin = AdminClient.create(properties))
        {
            admin.createTopics(List.of(new NewTopic("orders", 2, (short) 1), new NewTopic("payments", 1, (short) 1)))
                    .all()
                    .get(30, TimeUnit.SECONDS);
        }
        properties.put("key.serializer", ByteArraySerializer.class);
        properties.put("value.serializer", ByteArraySerializer.class);
        try (KafkaProducer<byte[], byte[]> producer = new KafkaProducer<>(properties))
        {
            for (int i = 1; i <= 3; i++)
            {
                producer.send(new ProducerRecord<>("orders", ("o" + i).getBytes(StandardCharsets.UTF_8), ("{\"id\": " + i + "}").getBytes(StandardCharsets.UTF_8)))
                        .get(30, TimeUnit.SECONDS);
            }
        }

        connections = KafkaConnectionsTest.connections(Map.of("connectionId", "local", "bootstrapServers", kafka.getBootstrapServers()),
                Map.of("connectionId", "nowhere", "bootstrapServers", "localhost:1"));
    }

    @AfterAll
    void stopKafka()
    {
        if (kafka != null)
        {
            kafka.stop();
        }
    }

    @Test
    void listsTheTopicsOfAConnection()
    {
        assertEquals(Map.of("topics", List.of("orders", "payments")), KafkaBackendPlugin.listTopics(connections, Map.of("connectionId", "local")));
    }

    @Test
    void testsAConnectionThatIsNotSavedYet()
    {
        Map<String, Object> result = KafkaBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new", "bootstrapServers", kafka.getBootstrapServers())));

        assertEquals(true, result.get("ok"));
        assertEquals(1, result.get("brokers"));
        assertTrue(result.get("clusterId") instanceof String id
                && !id.isBlank(), result.toString());
    }

    @Test
    void aConnectionNobodyAnswersFailsWithAMessage()
    {
        Map<String, Object> result = KafkaBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "nowhere", "bootstrapServers", "localhost:1")));

        assertEquals(false, result.get("ok"));
        assertFalse(String.valueOf(result.get("message"))
                .isBlank());
    }

    @Test
    void payloadbuilderQueriesThroughThePluginsCatalogAndConnection()
    {
        // The plugin's kafka catalog with payloadbuilder's catalog code and this plugin's kafka-clients: catches a client upgrade that breaks the catalog
        PayloadbuilderKafkaCatalogProvider provider = new PayloadbuilderKafkaCatalogProvider(connections);
        CatalogRegistry registry = new CatalogRegistry();
        registry.registerCatalog("kafka", provider.createCatalog());
        QuerySession session = new QuerySession(registry);
        provider.injectProperties(session, "kafka", Map.of("connectionId", "local"));

        // count(*) over the schemaless topic doesn't plan in payloadbuilder (the asterisk is evaluated as a scalar), so the rows are counted here
        QueryResult result = Payloadbuilder.compile(session, "select x.topic, x.offset from kafka#topic.orders x")
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
        assertEquals(3, rows.split("\"topic\":\"orders\"", -1).length - 1, rows);
    }
}
