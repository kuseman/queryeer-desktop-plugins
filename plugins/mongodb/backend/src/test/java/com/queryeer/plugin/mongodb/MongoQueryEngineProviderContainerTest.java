package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.bson.Document;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.CreateCollectionOptions;
import com.mongodb.client.model.TimeSeriesOptions;
import com.mongodb.client.model.ValidationAction;
import com.mongodb.client.model.ValidationOptions;
import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.FileSession;
import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.SecuritySessionClosedException;
import com.queryeer.backend.api.SettingsModule;
import com.queryeer.backend.contract.query.QueryExecuteOptions;

/** Runs the provider against a real MongoDB server. Skipped when Docker is not available. */
class MongoQueryEngineProviderContainerTest
{
    private static final String SLOW_STAGE_TEMPLATE = """
            { "$addFields": { "slow": { "$function": {
                "body": "function() { var s = Date.now(); while (Date.now() - s < %d) {} return 1; }",
                "args": [], "lang": "js" } } } }
            """;

    private static GenericContainer<?> mongo;
    private static MongoClient seedClient;
    private static String hosts;

    private MongoQueryEngineProvider provider;
    private FileConnections fileConnections;
    private MongoClientCache clientCache;

    @BeforeAll
    static void startMongo()
    {
        assumeTrue(DockerClientFactory.instance()
                .isDockerAvailable(), "Docker is not available");
        mongo = new GenericContainer<>(DockerImageName.parse("mongo:7.0")).withExposedPorts(27017);
        mongo.start();
        hosts = mongo.getHost() + ":" + mongo.getMappedPort(27017);
        seedClient = MongoClients.create("mongodb://" + hosts);

        seedClient.getDatabase("shop")
                .getCollection("orders")
                .insertMany(List.of(Document.parse("{ \"_id\": 1, \"status\": \"open\", \"total\": 10, \"customer\": { \"name\": \"A\" } }"), Document.parse(
                        "{ \"_id\": 2, \"status\": \"closed\", \"total\": 20, \"customer\": { \"name\": \"B\" } }"), Document.parse(
                                "{ \"_id\": 3, \"status\": \"open\", \"total\": 30, \"note\": \"late\" }"), Document.parse("{ \"_id\": 4, \"status\": \"open\", \"total\": 40 }"),
                        Document.parse("{ \"_id\": 5, \"status\": \"closed\", \"total\": 50, \"tags\": [\"x\"] }")));
        seedClient.getDatabase("other")
                .getCollection("things")
                .insertOne(Document.parse("{ \"_id\": \"t1\", \"kind\": \"other\" }"));
    }

    @AfterAll
    static void stopMongo()
    {
        if (seedClient != null)
        {
            seedClient.close();
        }
        if (mongo != null)
        {
            mongo.stop();
        }
    }

    @BeforeEach
    void createProvider()
    {
        List<Map<String, Object>> connections = new ArrayList<>();
        connections.add(Map.of("connectionId", "local", "hosts", hosts, "defaultDatabase", "shop"));
        connections.add(Map.of("connectionId", "nodefault", "hosts", hosts));
        connections.add(Map.of("connectionId", "locked", "hosts", hosts, "username", "user", "password", Map.of("secretRef", "locked")));
        connections.add(Map.of("connectionId", "disabled", "hosts", hosts, "enabled", false));
        ConfigService config = new FakeConfig(new SettingsModule(MongoConnectionSettings.MODULE_ID, 1, "now", Map.of(MongoConnectionSettings.CONNECTIONS_SETTING_ID, connections)));

        LoggerService logger = new LoggerService()
        {
            @Override
            public void info(String message)
            {
            }

            @Override
            public void warn(String message)
            {
            }

            @Override
            public void error(String message, Throwable error)
            {
            }
        };
        fileConnections = new FileConnections();
        clientCache = new MongoClientCache(config, logger);
        provider = new MongoQueryEngineProvider(clientCache, fileConnections, LargeValueStore.inlineOnly(), logger);
    }

    @Test
    void findStreamsAllBatchesAndCollectsLateKeysInExtraColumn()
    {
        RecordingPublisher publisher = execute("{ \"find\": \"orders\", \"sort\": { \"_id\": 1 }, \"batchSize\": 2 }", local());

        assertEquals(List.of("completed"), publisher.terminalEvents);
        RecordingPublisher.ResultSet result = publisher.resultSet(0);
        assertEquals(List.of("_id", "status", "total", "customer", "$extra"), result.columns());
        assertEquals(List.of("int", "string", "int", "object", "object"), result.types());
        assertEquals(5, result.rows()
                .size());
        assertEquals(5L, publisher.completedRowCount);
        assertEquals(Arrays.asList(1, "open", 10, "{\"name\": \"A\"}", null), new ArrayList<>(result.rows()
                .get(0)));
        assertEquals("{\"note\": \"late\"}", result.rows()
                .get(2)
                .get(4));
        assertNull(result.rows()
                .get(2)
                .get(3));
    }

    @Test
    void singleBatchHasNoExtraColumn()
    {
        RecordingPublisher publisher = execute("{ \"find\": \"orders\", \"filter\": { \"_id\": { \"$lte\": 2 } } }", local());

        assertEquals(List.of("_id", "status", "total", "customer"), publisher.resultSet(0)
                .columns());
        assertEquals(2, publisher.totalRows());
    }

    @Test
    void severalCommandsProduceSeveralResultSets()
    {
        RecordingPublisher publisher = execute("""
                { "count": "orders" }
                { "distinct": "orders", "key": "status" }
                { "aggregate": "orders", "pipeline": [ { "$group": { "_id": "$status", "sum": { "$sum": "$total" } } }, { "$sort": { "_id": 1 } } ], "cursor": {} }
                """, local());

        assertEquals(List.of("completed"), publisher.terminalEvents);
        assertEquals(3, publisher.resultSets.size());

        RecordingPublisher.ResultSet count = publisher.resultSet(0);
        assertEquals(5, count.rows()
                .get(0)
                .get(count.columns()
                        .indexOf("n")));
        assertEquals(List.of("n"), count.columns());

        RecordingPublisher.ResultSet distinct = publisher.resultSet(1);
        assertEquals(List.of("value"), distinct.columns());
        assertEquals(List.of(List.of("closed"), List.of("open")), distinct.rows()
                .stream()
                .map(ArrayList::new)
                .sorted((a, b) -> a.get(0)
                        .toString()
                        .compareTo(b.get(0)
                                .toString()))
                .toList());

        RecordingPublisher.ResultSet grouped = publisher.resultSet(2);
        assertEquals(List.of(List.of("closed", 70), List.of("open", 80)), grouped.rows()
                .stream()
                .map(ArrayList::new)
                .toList());
    }

    @Test
    void dbKeyOverridesSelectedDatabase()
    {
        Map<String, Object> state = new HashMap<>(local());
        state.put("database", "shop");

        RecordingPublisher publisher = execute("{ \"find\": \"things\", \"$db\": \"other\" }", state);

        assertEquals(List.of("completed"), publisher.terminalEvents);
        assertEquals("t1", publisher.resultSet(0)
                .rows()
                .get(0)
                .get(0));
    }

    @Test
    void selectedDatabaseOverridesConnectionDefault()
    {
        Map<String, Object> state = new HashMap<>(local());
        state.put("database", "other");

        RecordingPublisher publisher = execute("{ \"count\": \"things\" }", state);

        RecordingPublisher.ResultSet count = publisher.resultSet(0);
        assertEquals(1, count.rows()
                .get(0)
                .get(count.columns()
                        .indexOf("n")));
    }

    @Test
    void listDatabasesReturnsOneRowPerDatabase()
    {
        RecordingPublisher publisher = execute("{ \"listDatabases\": 1, \"nameOnly\": true }", local());

        List<Object> names = publisher.resultSet(0)
                .rows()
                .stream()
                .map(row -> row.get(0))
                .toList();
        assertTrue(names.containsAll(List.of("shop", "other")));
    }

    @Test
    void disallowedCommandIsRejectedBeforeReachingTheServer()
    {
        RecordingPublisher publisher = execute("{ \"count\": \"orders\" }\n{ \"delete\": \"orders\", \"deletes\": [ { \"q\": {}, \"limit\": 0 } ] }", local());

        assertEquals(List.of("failed:VALIDATION"), publisher.terminalEvents);
        assertEquals(2, publisher.errorDetails.get("line"));
        assertTrue(publisher.resultSets.isEmpty(), "nothing may run when any command is rejected");
        assertEquals(5, seedClient.getDatabase("shop")
                .getCollection("orders")
                .countDocuments());
    }

    @Test
    void parseErrorIsValidationWithPosition()
    {
        RecordingPublisher publisher = execute("\n  { \"find\": orders }", local());

        assertEquals(List.of("failed:VALIDATION"), publisher.terminalEvents);
        assertEquals(2, publisher.errorDetails.get("line"));
        assertEquals(3, publisher.errorDetails.get("column"));
    }

    @Test
    void serverErrorIsReportedWithServerMessage()
    {
        RecordingPublisher publisher = execute("{ \"find\": \"orders\", \"filter\": { \"$foo\": 1 } }", local());

        assertEquals(List.of("failed:INTERNAL"), publisher.terminalEvents);
        assertTrue(publisher.errorMessage.contains("$foo"), publisher.errorMessage);
    }

    @Test
    void timeoutIsReportedAsTimeout()
    {
        String text = "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$match\": { \"_id\": 1 } }, " + SLOW_STAGE_TEMPLATE.formatted(5000) + " ], \"cursor\": {} }";
        long start = System.nanoTime();

        RecordingPublisher publisher = new RecordingPublisher();
        provider.execute("qx-timeout", "file-1", text, local(), new QueryExecuteOptions(null, 500, null, null, null), publisher);

        assertEquals(List.of("failed:TIMEOUT"), publisher.terminalEvents);
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 4000, "timeout must not wait for the server operation to finish");
    }

    @Test
    void multiBatchCursorCompletesWhenTimeoutIsSet()
    {
        // Regression: the driver timeout must not be applied to getMore (the server rejects maxTimeMS there)
        RecordingPublisher publisher = new RecordingPublisher();
        provider.execute("qx-timeout-batches", "file-1", "{ \"find\": \"orders\", \"batchSize\": 2 }", local(), new QueryExecuteOptions(null, 15000, null, null, null),
                publisher);

        assertEquals(List.of("completed"), publisher.terminalEvents, String.valueOf(publisher.errorMessage));
        assertEquals(5, publisher.totalRows());
    }

    @Test
    void timeoutAppliesAcrossBatches()
    {
        String text = "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$sort\": { \"_id\": 1 } }, " + SLOW_STAGE_TEMPLATE.formatted(400) + " ], \"cursor\": { \"batchSize\": 1 } }";
        long start = System.nanoTime();

        RecordingPublisher publisher = new RecordingPublisher();
        provider.execute("qx-timeout-across", "file-1", text, local(), new QueryExecuteOptions(null, 1000, null, null, null), publisher);

        assertEquals(List.of("failed:TIMEOUT"), publisher.terminalEvents, String.valueOf(publisher.errorMessage));
        assertTrue(publisher.totalRows() < 5);
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2500);
    }

    @Test
    void cancelDuringStreamingStopsAndReportsCancelled()
    {
        AtomicBoolean cancelled = new AtomicBoolean();
        RecordingPublisher publisher = new RecordingPublisher();
        publisher.onRows(rows ->
        {
            if (cancelled.compareAndSet(false, true))
            {
                provider.cancel("qx-cancel");
            }
        });

        provider.execute("qx-cancel", "file-1", "{ \"find\": \"orders\", \"sort\": { \"_id\": 1 }, \"batchSize\": 1 }", local(), null, publisher);

        assertEquals(List.of("failed:CANCELLED"), publisher.terminalEvents);
        assertTrue(publisher.totalRows() < 5);
    }

    @Test
    void cancelKillsSlowServerOperation() throws Exception
    {
        String text = "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$match\": { \"_id\": 1 } }, " + SLOW_STAGE_TEMPLATE.formatted(15000) + " ], \"cursor\": {} }";
        RecordingPublisher publisher = new RecordingPublisher();
        Thread executing = Thread.ofPlatform()
                .start(() -> provider.execute("qx-slow", "file-1", text, local(), null, publisher));

        waitForServerOperation("qx-slow");
        long start = System.nanoTime();
        provider.cancel("qx-slow");

        assertTrue(publisher.awaitTerminal(1, TimeUnit.SECONDS));
        assertEquals(List.of("failed:CANCELLED"), publisher.terminalEvents);
        executing.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(executing.isAlive(), "the executing thread must end once the server operation is killed");
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - start) < 10, "killOp should stop the 15s operation early");
        assertFalse(serverOperationRunning("qx-slow"));
    }

    @Test
    void missingConnectionIsValidation()
    {
        RecordingPublisher publisher = execute("{ \"ping\": 1 }", Map.of());

        assertEquals(List.of("failed:VALIDATION"), publisher.terminalEvents);
        assertTrue(publisher.errorMessage.contains("No MongoDB connection"));
    }

    @Test
    void boundFileSessionIsUsedWhenStateHasNoConnection()
    {
        fileConnections.onOpen(new FileSession("file-1", URI.create("file:///q.mongo"), "application/vnd.queryeer.mongodb", "mongodb", "local", 1), "");

        RecordingPublisher publisher = execute("{ \"count\": \"orders\" }", Map.of());

        assertEquals(List.of("completed"), publisher.terminalEvents);
    }

    @Test
    void missingDatabaseIsValidation()
    {
        RecordingPublisher publisher = execute("{ \"find\": \"orders\" }", Map.of("connectionId", "nodefault"));

        assertEquals(List.of("failed:VALIDATION"), publisher.terminalEvents);
        assertTrue(publisher.errorMessage.contains("No database selected"));
    }

    @Test
    void disabledConnectionIsValidation()
    {
        RecordingPublisher publisher = execute("{ \"ping\": 1 }", Map.of("connectionId", "disabled"));

        assertEquals(List.of("failed:VALIDATION"), publisher.terminalEvents);
    }

    @Test
    void lockedVaultPropagatesForHostUnlockFlow()
    {
        assertThrows(SecuritySessionClosedException.class, () -> provider.execute("qx-locked", "file-1", "{ \"ping\": 1 }", Map.of("connectionId", "locked"), null,
                new RecordingPublisher()));
    }

    @Test
    void invokeListsDatabasesAndPings()
    {
        @SuppressWarnings("unchecked")
        List<String> databases = (List<String>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_DATABASES, Map.of("connectionId", "local"));
        assertTrue(databases.containsAll(List.of("shop", "other")));

        @SuppressWarnings("unchecked")
        Map<String, Object> ping = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_PING, Map.of("engineState", local()));
        assertEquals(true, ping.get("ok"));
        assertTrue(ping.get("version")
                .toString()
                .startsWith("7."));
    }

    @Test
    void invokeListsCollectionsWithCountsAndIndexes()
    {
        seedClient.getDatabase("shop")
                .getCollection("orders")
                .createIndex(Document.parse("{ \"status\": 1, \"total\": -1 }"));
        seedClient.getDatabase("shop")
                .createView("openOrders", "orders", List.of(Document.parse("{ \"$match\": { \"status\": \"open\" } }")));
        seedClient.getDatabase("shop")
                .createCollection("metrics", new CreateCollectionOptions().timeSeriesOptions(new TimeSeriesOptions("ts").metaField("sensor")));
        seedClient.getDatabase("shop")
                .createCollection("customers", new CreateCollectionOptions().validationOptions(new ValidationOptions()
                        .validator(Document.parse("{ \"$jsonSchema\": { \"required\": [\"email\"] } }"))
                        .validationAction(ValidationAction.WARN)));
        try
        {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> collections = (List<Map<String, Object>>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_COLLECTIONS, Map.of("connectionId",
                    "local", "database", "shop"));
            Map<String, Object> orders = collections.stream()
                    .filter(c -> "orders".equals(c.get("name")))
                    .findFirst()
                    .orElseThrow();
            assertEquals("collection", orders.get("type"));
            assertEquals(5L, orders.get("count"));
            Map<String, Object> view = collections.stream()
                    .filter(c -> "openOrders".equals(c.get("name")))
                    .findFirst()
                    .orElseThrow();
            assertEquals("view", view.get("type"));
            assertNull(view.get("count"));
            assertEquals("orders", view.get("viewOn"));
            assertEquals("[{\"$match\": {\"status\": \"open\"}}]", view.get("pipeline"));
            Map<String, Object> metrics = collections.stream()
                    .filter(c -> "metrics".equals(c.get("name")))
                    .findFirst()
                    .orElseThrow();
            assertEquals("timeseries", metrics.get("type"));
            assertEquals("ts", metrics.get("timeField"));
            assertEquals("sensor", metrics.get("metaField"));
            assertNull(orders.get("validator"));
            Map<String, Object> customers = collections.stream()
                    .filter(c -> "customers".equals(c.get("name")))
                    .findFirst()
                    .orElseThrow();
            assertEquals("{\"$jsonSchema\": {\"required\": [\"email\"]}}", customers.get("validator"));
            assertEquals("strict", customers.get("validationLevel"));
            assertEquals("warn", customers.get("validationAction"));

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> indexes = (List<Map<String, Object>>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_INDEXES, Map.of("connectionId", "local",
                    "database", "shop", "collection", "orders"));
            assertEquals(List.of("_id_", "status_1_total_-1"), indexes.stream()
                    .map(i -> i.get("name"))
                    .toList());
            assertEquals("{\"status\": 1, \"total\": -1}", indexes.get(1)
                    .get("key"));

            assertThrows(IllegalArgumentException.class, () -> provider.invoke("file-1", MongoQueryEngineProvider.ACTION_COLLECTIONS, Map.of("connectionId", "local")));
        }
        finally
        {
            seedClient.getDatabase("shop")
                    .getCollection("openOrders")
                    .drop();
            seedClient.getDatabase("shop")
                    .getCollection("metrics")
                    .drop();
            seedClient.getDatabase("shop")
                    .getCollection("customers")
                    .drop();
            seedClient.getDatabase("shop")
                    .getCollection("orders")
                    .dropIndex("status_1_total_-1");
        }
    }

    @Test
    void invokeSamplesFieldsWithTypesAndFrequency()
    {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_FIELDS, Map.of("connectionId", "local",
                "database", "shop", "collection", "orders"));

        assertEquals("_id", fields.get(0)
                .get("name"), "_id comes first");
        Map<String, Map<String, Object>> byName = new HashMap<>();
        fields.forEach(f -> byName.put((String) f.get("name"), f));
        assertEquals(List.of("_id", "status", "total", "customer", "customer.name", "note", "tags"), fields.stream()
                .map(f -> f.get("name"))
                .toList(), "_id, then most common, then by name; embedded fields follow their parent");
        assertEquals("customer", byName.get("customer.name")
                .get("parent"));
        assertEquals(2L, byName.get("customer.name")
                .get("count"));
        assertEquals(5L, byName.get("status")
                .get("count"));
        assertEquals(5L, byName.get("status")
                .get("sampled"));
        assertEquals(List.of("string"), byName.get("status")
                .get("types"));
        assertEquals(1L, byName.get("note")
                .get("count"));
        assertEquals(List.of("object"), byName.get("customer")
                .get("types"));
        assertEquals(List.of("array"), byName.get("tags")
                .get("types"));
    }

    @Test
    void invokeSamplesFieldsOneLevelDown()
    {
        MongoCollection<Document> events = seedClient.getDatabase("shop")
                .getCollection("kafka_events");
        events.insertMany(List.of(Document.parse("{ \"payload\": { \"orderId\": 1, \"status\": \"new\", \"meta\": { \"deep\": 1 }, \"a.b\": 1, \"$odd\": 1 } }"),
                Document.parse("{ \"payload\": { \"orderId\": 2, \"lines\": [] } }"), Document.parse("{ \"payload\": \"not a document\" }"),
                Document.parse("{ \"items\": [ { \"sku\": \"x\" } ] }")));
        try
        {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> fields = (List<Map<String, Object>>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_FIELDS, Map.of("connectionId",
                    "local", "database", "shop", "collection", "kafka_events"));

            assertEquals(List.of("_id", "payload", "payload.orderId", "payload.lines", "payload.meta", "payload.status", "items"), fields.stream()
                    .map(f -> f.get("name"))
                    .toList(), "one level down only, no keys dot notation cannot address, nothing inside arrays");
            Map<String, Object> orderId = fields.get(2);
            assertEquals(List.of("int"), orderId.get("types"));
            assertEquals(2L, orderId.get("count"));
            assertEquals(4L, orderId.get("sampled"));
            assertEquals(List.of("object", "string"), fields.get(1)
                    .get("types"));
        }
        finally
        {
            events.drop();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void invokeListsDistinctValuesForSuggestions()
    {
        Map<String, Object> status = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local", "database",
                "shop", "collection", "orders", "field", "status"));
        assertEquals(true, status.get("complete"));
        assertEquals(List.of(Map.of("type", "string", "text", "closed"), Map.of("type", "string", "text", "open")), status.get("values"));
        assertNull(status.get("sampled"), "small collections are read in full");

        Map<String, Object> sampled = MongoQueryEngineProvider.distinctValues(seedClient, "shop", "orders", "status", 2);
        assertEquals(MongoQueryEngineProvider.VALUE_SUGGESTION_SAMPLE_SIZE, sampled.get("sampled"), "larger collections are sampled");
        assertEquals(status.get("values"), sampled.get("values"));

        Map<String, Object> totals = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local", "database",
                "shop", "collection", "orders", "field", "total"));
        assertEquals(List.of("10", "20", "30", "40", "50"), ((List<Map<String, Object>>) totals.get("values")).stream()
                .map(v -> v.get("text"))
                .toList(), "numbers in numeric order");

        Map<String, Object> tags = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local", "database",
                "shop", "collection", "orders", "field", "tags"));
        assertEquals(List.of(Map.of("type", "string", "text", "x")), tags.get("values"), "array elements one by one");

        Map<String, Object> nested = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local", "database",
                "shop", "collection", "orders", "field", "customer.name"));
        assertEquals(List.of(Map.of("type", "string", "text", "A"), Map.of("type", "string", "text", "B")), nested.get("values"));

        Map<String, Object> documents = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local", "database",
                "shop", "collection", "orders", "field", "customer"));
        assertEquals(List.of(), documents.get("values"), "embedded documents cannot be typed into a filter");

        MongoCollection<Document> many = seedClient.getDatabase("shop")
                .getCollection("many_values");
        List<Document> documentsWithManyValues = new java.util.ArrayList<>();
        for (int i = 0; i <= MongoQueryEngineProvider.VALUE_SUGGESTION_LIMIT; i++)
        {
            documentsWithManyValues.add(new Document("n", i));
        }
        many.insertMany(documentsWithManyValues);
        try
        {
            Map<String, Object> tooMany = (Map<String, Object>) provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local",
                    "database", "shop", "collection", "many_values", "field", "n"));
            assertEquals(false, tooMany.get("complete"));
            assertEquals(List.of(), tooMany.get("values"));
        }
        finally
        {
            many.drop();
        }
        assertThrows(IllegalArgumentException.class, () -> provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALUES, Map.of("connectionId", "local",
                "database", "shop", "collection", "orders", "field", "$where")));
    }

    @Test
    void testConnectionReportsVersionOrReason()
    {
        @SuppressWarnings("unchecked")
        Map<String, Object> ok = (Map<String, Object>) provider.invoke(null, MongoQueryEngineProvider.ACTION_TEST_CONNECTION, Map.of("connection", Map.of("connectionId", "unsaved",
                "hosts", hosts)));
        assertEquals(true, ok.get("ok"), String.valueOf(ok));
        assertTrue(ok.get("version")
                .toString()
                .startsWith("7."));

        @SuppressWarnings("unchecked")
        Map<String, Object> noHosts = (Map<String, Object>) provider.invoke(null, MongoQueryEngineProvider.ACTION_TEST_CONNECTION, Map.of("connection", Map.of("connectionId",
                "unsaved")));
        assertEquals(false, noHosts.get("ok"));

        @SuppressWarnings("unchecked")
        Map<String, Object> badOptions = (Map<String, Object>) provider.invoke(null, MongoQueryEngineProvider.ACTION_TEST_CONNECTION, Map.of("connection", Map.of("connectionId",
                "unsaved", "hosts", hosts, "options", "notAnOption=%%")));
        assertEquals(false, badOptions.get("ok"));
        assertTrue(badOptions.get("message") != null);

        assertThrows(SecuritySessionClosedException.class, () -> provider.invoke(null, MongoQueryEngineProvider.ACTION_TEST_CONNECTION, Map.of("connection", Map.of(
                "connectionId", "unsaved", "hosts", hosts, "username", "u", "password", Map.of("secretRef", "locked")))));
    }

    @Test
    void clientIsReusedUntilSettingsChange()
    {
        MongoClient first = clientCache.get("local")
                .client();
        MongoClient second = clientCache.get("local")
                .client();

        assertTrue(first == second);
    }

    private RecordingPublisher execute(String text, Map<String, Object> engineState)
    {
        RecordingPublisher publisher = new RecordingPublisher();
        provider.execute("qx-" + System.nanoTime(), "file-1", text, engineState, null, publisher);
        return publisher;
    }

    private static Map<String, Object> local()
    {
        return Map.of("connectionId", "local");
    }

    private static void waitForServerOperation(String comment) throws InterruptedException
    {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < until)
        {
            if (serverOperationRunning(comment))
            {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("server operation " + comment + " never started");
    }

    private static boolean serverOperationRunning(String comment)
    {
        List<Document> pipeline = List.of(Document.parse("{ \"$currentOp\": {} }"), new Document("$match", new Document("command.comment", comment)));
        return seedClient.getDatabase("admin")
                .aggregate(pipeline)
                .first() != null;
    }

    private static final class FakeConfig implements ConfigService
    {
        private final SettingsModule module;

        FakeConfig(SettingsModule module)
        {
            this.module = module;
        }

        @Override
        public String get(String key)
        {
            return null;
        }

        @Override
        public SettingsModule getModule(String moduleId)
        {
            return MongoConnectionSettings.MODULE_ID.equals(moduleId) ? module
                    : null;
        }

        @Override
        public Object materializeSecrets(Object payload)
        {
            if (payload instanceof Map<?, ?> map
                    && "locked".equals(map.get("secretRef")))
            {
                throw new SecuritySessionClosedException("Vault is locked");
            }
            return payload;
        }
    }
}
