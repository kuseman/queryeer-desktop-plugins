package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import org.bson.BsonArray;
import org.bson.BsonBoolean;
import org.bson.BsonDocument;
import org.bson.BsonValue;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;
import org.bson.BsonInt32;
import org.bson.BsonString;

import com.mongodb.MongoCommandException;
import com.mongodb.MongoException;
import com.mongodb.MongoExecutionTimeoutException;
import com.mongodb.MongoOperationTimeoutException;
import com.mongodb.MongoSecurityException;
import com.mongodb.MongoTimeoutException;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoDatabase;
import com.queryeer.backend.api.ErrorMessages;
import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.QueryEngineProvider;
import com.queryeer.backend.api.QueryPublisher;
import com.queryeer.backend.api.SecuritySessionClosedException;
import com.queryeer.backend.contract.query.QueryExecuteOptions;

/** The {@code mongodb} query engine. Thread-safe: executions run on host threads, and {@code invoke}/{@code cancel} may arrive concurrently. */
final class MongoQueryEngineProvider implements QueryEngineProvider
{
    static final String ACTION_DATABASES = "mongodb.databases";
    static final String ACTION_PING = "mongodb.ping";
    static final String ACTION_TEST_CONNECTION = "mongodb.testConnection";
    static final String ACTION_COLLECTIONS = "mongodb.collections";
    static final String ACTION_INDEXES = "mongodb.indexes";
    static final String ACTION_FIELDS = "mongodb.fields";
    static final String ACTION_VALUES = "mongodb.values";
    static final String ACTION_DOCUMENTS = "mongodb.documents";
    /** At most this many documents per "Copy document". */
    static final int DOCUMENTS_LIMIT = 1_000;
    static final long DOCUMENTS_MAX_TIME_MS = 10_000;
    /** A field with more distinct values than this gets no suggestions. */
    static final int VALUE_SUGGESTION_LIMIT = 50;
    static final long VALUE_SUGGESTION_MAX_TIME_MS = 2_000;
    /** Collections larger than this get suggestions from a random sample: a full scan rarely finishes within the time limit. */
    static final long VALUE_SUGGESTION_EXACT_MAX_DOCUMENTS = 100_000;
    static final int VALUE_SUGGESTION_SAMPLE_SIZE = 1_000;
    static final int FIELD_SAMPLE_SIZE = 1000;
    static final long FIELD_SAMPLE_MAX_TIME_MS = 10_000;
    /** At most this many fields one level down per embedded document, so map-like documents (IDs or dates as keys) do not flood the lists. */
    static final int FIELD_SAMPLE_MAX_CHILDREN = 200;
    /** Upper bound on distinct (parent, key) groups the sample returns, keeping the $facet output well under 16 MB. */
    static final int FIELD_SAMPLE_MAX_NESTED = 5_000;
    static final String STATE_CONNECTION_ID = "connectionId";
    static final String STATE_DATABASE = "database";

    private final MongoClientCache clients;
    private final FileConnections fileConnections;
    private final LargeValueStore largeValues;
    private final LoggerService logger;
    private final CommandParser parser = new CommandParser();
    private final CommandPolicy policy = new CommandPolicy();
    private final CommandRunner runner;
    private final Map<String, Execution> executions = new ConcurrentHashMap<>();
    /** Fires {@code TIMEOUT} at the host's deadline, including while a getMore is running (which cannot carry maxTimeMS). */
    private final ScheduledExecutorService watchdogs = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform()
            .daemon()
            .name("mongodb-timeout-watchdog")
            .factory());

    MongoQueryEngineProvider(MongoClientCache clients, FileConnections fileConnections, LargeValueStore largeValues, LoggerService logger)
    {
        this.clients = clients;
        this.fileConnections = fileConnections;
        this.largeValues = largeValues;
        this.logger = logger;
        this.runner = new CommandRunner(logger);
    }

    @Override
    public String engineId()
    {
        return MongoBackendPlugin.ENGINE_ID;
    }

    @Override
    public void execute(String queryExecutionId, String fileId, String text, Object engineState, QueryPublisher publisher)
    {
        execute(queryExecutionId, fileId, text, engineState, null, publisher);
    }

    @Override
    public void execute(String queryExecutionId, String fileId, String text, Object engineState, QueryExecuteOptions options, QueryPublisher hostPublisher)
    {
        long start = System.currentTimeMillis();
        Execution execution = new Execution(queryExecutionId, new GuardedPublisher(hostPublisher));
        GuardedPublisher publisher = execution.publisher();
        executions.put(queryExecutionId, execution);
        Integer timeoutMs = options == null ? null
                : options.timeoutMs();
        ScheduledFuture<?> watchdog = timeoutMs == null
                || timeoutMs <= 0 ? null
                        : watchdogs.schedule(() -> execution.stop("TIMEOUT", "Query timed out after " + timeoutMs + " ms", logger), timeoutMs, TimeUnit.MILLISECONDS);
        try
        {
            List<ParsedCommand> commands = parser.parse(text);
            commands.forEach(policy::validate);

            Map<?, ?> state = engineState instanceof Map<?, ?> map ? map
                    : Map.of();
            MongoClientCache.Handle handle = clients.get(resolveConnectionId(fileId, state));
            execution.useClient(handle.client());

            CommandRunner.Deadline deadline = CommandRunner.Deadline.in(timeoutMs);
            ValueMapper values = new ValueMapper(largeValues, queryExecutionId);
            long rowCount = 0;
            for (ParsedCommand command : commands)
            {
                if (execution.isCancelled())
                {
                    return;
                }
                String database = resolveDatabase(command, state, handle.settings());
                rowCount += runner.run(execution, handle.client(), database, command, new ResultSetWriter(publisher, values), deadline);
            }
            if (!execution.isCancelled())
            {
                publisher.completed(System.currentTimeMillis() - start, rowCount);
            }
        }
        catch (QueryValidationException e)
        {
            publisher.failed("VALIDATION", e.getMessage(), e.details());
        }
        catch (SecuritySessionClosedException e)
        {
            // The host maps this to SECURITY_SESSION_CLOSED and starts its vault-unlock flow
            throw e;
        }
        catch (MongoOperationTimeoutException | MongoExecutionTimeoutException e)
        {
            publisher.failed("TIMEOUT", "Query timed out: " + e.getMessage());
        }
        catch (MongoTimeoutException e)
        {
            publisher.failed("INTERNAL", "Could not reach the MongoDB server: " + e.getMessage(), ErrorMessages.buildErrorDetails(e));
        }
        catch (MongoSecurityException e)
        {
            publisher.failed("INTERNAL", "MongoDB authentication failed: " + e.getMessage(), ErrorMessages.buildErrorDetails(e));
        }
        catch (MongoCommandException e)
        {
            publisher.failed("INTERNAL", commandErrorMessage(e), ErrorMessages.buildErrorDetails(e));
        }
        catch (RuntimeException e)
        {
            if (!execution.isCancelled())
            {
                publisher.failed("INTERNAL", ErrorMessages.buildFailureMessage(e), ErrorMessages.buildErrorDetails(e));
            }
        }
        finally
        {
            if (watchdog != null)
            {
                watchdog.cancel(false);
            }
            executions.remove(queryExecutionId);
        }
    }

    @Override
    public void cancel(String queryExecutionId)
    {
        Execution execution = executions.get(queryExecutionId);
        if (execution != null)
        {
            execution.stop("CANCELLED", "Query was cancelled", logger);
        }
    }

    @Override
    public Object invoke(String fileId, String action, Object payload)
    {
        Map<?, ?> map = payload instanceof Map<?, ?> m ? m
                : Map.of();

        if (ACTION_TEST_CONNECTION.equals(action))
        {
            return testConnection(map.get("connection"));
        }

        Map<?, ?> state = map.get("engineState") instanceof Map<?, ?> s ? s
                : Map.of();
        Object explicitConnection = map.get(STATE_CONNECTION_ID);
        String connectionId = explicitConnection instanceof String id
                && !id.isBlank() ? id
                        : resolveConnectionId(fileId, state);
        MongoClient client = clients.get(connectionId)
                .client();

        return switch (action)
        {
            case ACTION_DATABASES -> client.listDatabaseNames()
                    .into(new ArrayList<>());
            case ACTION_COLLECTIONS -> listCollections(client, requiredText(map, "database"));
            case ACTION_INDEXES -> listIndexes(client, requiredText(map, "database"), requiredText(map, "collection"));
            case ACTION_FIELDS -> sampleFields(client, requiredText(map, "database"), requiredText(map, "collection"));
            case ACTION_DOCUMENTS -> documentsById(client, requiredText(map, "database"), requiredText(map, "collection"), requiredText(map, "ids"));
            case ACTION_VALUES -> distinctValues(client, requiredText(map, "database"), requiredText(map, "collection"), requiredText(map, "field"),
                    VALUE_SUGGESTION_EXACT_MAX_DOCUMENTS);
            case ACTION_PING ->
            {
                BsonDocument buildInfo = client.getDatabase("admin")
                        .runCommand(new BsonDocument("buildInfo", new BsonInt32(1)), BsonDocument.class);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("ok", true);
                result.put("version", buildInfo.getString("version")
                        .getValue());
                yield result;
            }
            default -> throw new IllegalArgumentException("Unknown MongoDB action: " + action);
        };
    }

    /**
     * Tests a connection definition from the settings editor (possibly unsaved). Returns {@code { ok: true, version }} or {@code { ok: false, message }}, never throws for
     * connection problems, so the editor can show the reason inline. A locked vault still propagates so the host can prompt for unlock.
     */
    private Map<String, Object> testConnection(Object connection)
    {
        Map<String, Object> result = new LinkedHashMap<>();
        List<MongoConnectionSettings> parsed = MongoConnectionSettings.parseList(connection == null ? null
                : List.of(connection));
        if (parsed.isEmpty())
        {
            result.put("ok", false);
            result.put("message", "Hosts are required");
            return result;
        }
        try
        {
            result.put("version", clients.testConnection(parsed.get(0)));
            result.put("ok", true);
        }
        catch (SecuritySessionClosedException e)
        {
            throw e;
        }
        catch (QueryValidationException | MongoException | IllegalArgumentException e)
        {
            result.put("ok", false);
            result.put("message", e instanceof MongoCommandException command ? commandErrorMessage(command)
                    : e.getMessage());
        }
        return result;
    }

    /**
     * Collections and views of a database for the explorer tree, sorted by name: {@code { name, type, count }}. {@code count} is the metadata-based estimate (cheap on
     * large collections), and {@code null} for views or when the estimate is not available.
     */
    private List<Map<String, Object>> listCollections(MongoClient client, String database)
    {
        MongoDatabase db = client.getDatabase(database);
        List<Map<String, Object>> result = new ArrayList<>();
        for (BsonDocument info : db.listCollections(BsonDocument.class))
        {
            String name = info.getString("name")
                    .getValue();
            String type = info.getString("type", new BsonString("collection"))
                    .getValue();
            Long count = null;
            if ("collection".equals(type)
                    || "timeseries".equals(type))
            {
                try
                {
                    count = db.getCollection(name)
                            .estimatedDocumentCount();
                }
                catch (MongoException e)
                {
                    // Count is a convenience; a collection the user cannot count is still listed
                }
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", name);
            entry.put("type", type);
            entry.put("count", count);

            // Details for tooltips: what a view is defined on, and how a time-series collection is keyed
            BsonDocument options = info.getDocument("options", new BsonDocument());
            if ("view".equals(type))
            {
                entry.put("viewOn", options.getString("viewOn", new BsonString(""))
                        .getValue());
                entry.put("pipeline", ValueMapper.json(options.getArray("pipeline", new BsonArray())));
            }
            BsonDocument timeseries = options.getDocument("timeseries", null);
            if (timeseries != null)
            {
                entry.put("timeField", timeseries.getString("timeField", new BsonString(""))
                        .getValue());
                if (timeseries.containsKey("metaField"))
                {
                    entry.put("metaField", timeseries.getString("metaField")
                            .getValue());
                }
                if (timeseries.containsKey("granularity"))
                {
                    entry.put("granularity", timeseries.getString("granularity")
                            .getValue());
                }
            }
            // Document validation rules ($jsonSchema or query operators), with how strictly they are enforced
            BsonDocument validator = options.getDocument("validator", null);
            if (validator != null
                    && !validator.isEmpty())
            {
                entry.put("validator", ValueMapper.json(validator));
                entry.put("validationLevel", options.getString("validationLevel", new BsonString("strict"))
                        .getValue());
                entry.put("validationAction", options.getString("validationAction", new BsonString("error"))
                        .getValue());
            }
            result.add(entry);
        }
        result.sort(Comparator.comparing(entry -> ((String) entry.get("name")).toLowerCase(Locale.ROOT)));
        return result;
    }

    /** Indexes of a collection for the explorer tree: {@code { name, key, unique }} with {@code key} as relaxed Extended JSON. */
    private static List<Map<String, Object>> listIndexes(MongoClient client, String database, String collection)
    {
        List<Map<String, Object>> result = new ArrayList<>();
        for (BsonDocument index : client.getDatabase(database)
                .getCollection(collection)
                .listIndexes(BsonDocument.class))
        {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", index.getString("name", new BsonString(""))
                    .getValue());
            entry.put("key", ValueMapper.json(index.getDocument("key", new BsonDocument())));
            entry.put("unique", index.getBoolean("unique", BsonBoolean.FALSE)
                    .getValue());
            result.add(entry);
        }
        return result;
    }

    /**
     * Fields of a collection or view, inferred from a random sample (MongoDB has no declared schema):
     * {@code { name, types, count, sampled }} for top-level fields, _id first and then most common. Each field that holds an embedded
     * document is followed by its own fields one level down ({@code payload.orderId}), with {@code parent} set and at most
     * {@value #FIELD_SAMPLE_MAX_CHILDREN} per parent. Keys that dot notation cannot address (containing '.' or starting with '$') are left out
     * one level down. The server stops the sampling after {@value #FIELD_SAMPLE_MAX_TIME_MS} ms.
     */
    private static List<Map<String, Object>> sampleFields(MongoClient client, String database, String collection)
    {
        List<BsonDocument> pipeline = List.of(BsonDocument.parse("{ \"$sample\": { \"size\": " + FIELD_SAMPLE_SIZE + " } }"), BsonDocument.parse("""
                { "$facet": {
                    "sampled": [ { "$count": "n" } ],
                    "fields": [
                        { "$project": { "kv": { "$objectToArray": "$$ROOT" } } },
                        { "$unwind": "$kv" },
                        { "$group": { "_id": "$kv.k", "count": { "$sum": 1 }, "types": { "$addToSet": { "$type": "$kv.v" } } } }
                    ],
                    "nested": [
                        { "$project": { "kv": { "$objectToArray": "$$ROOT" } } },
                        { "$unwind": "$kv" },
                        { "$match": { "$expr": { "$eq": [ { "$type": "$kv.v" }, "object" ] } } },
                        { "$project": { "parent": "$kv.k", "sub": { "$objectToArray": "$kv.v" } } },
                        { "$unwind": "$sub" },
                        { "$group": { "_id": { "parent": "$parent", "key": "$sub.k" }, "count": { "$sum": 1 }, "types": { "$addToSet": { "$type": "$sub.v" } } } },
                        { "$sort": { "count": -1 } },
                        { "$limit": %d }
                    ]
                } }
                """.formatted(FIELD_SAMPLE_MAX_NESTED)));
        BsonDocument facet = client.getDatabase(database)
                .getCollection(collection, BsonDocument.class)
                .aggregate(pipeline)
                .maxTime(FIELD_SAMPLE_MAX_TIME_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
                .first();

        List<Map<String, Object>> result = new ArrayList<>();
        if (facet == null)
        {
            return result;
        }
        BsonArray sampledArray = facet.getArray("sampled", new BsonArray());
        long sampled = sampledArray.isEmpty() ? 0
                : sampledArray.get(0)
                        .asDocument()
                        .get("n")
                        .asNumber()
                        .longValue();
        List<Map<String, Object>> topLevel = new ArrayList<>();
        for (BsonValue value : facet.getArray("fields", new BsonArray()))
        {
            BsonDocument field = value.asDocument();
            topLevel.add(sampledField(field.getString("_id")
                    .getValue(), null, field, sampled));
        }
        Map<String, List<Map<String, Object>>> children = new LinkedHashMap<>();
        for (BsonValue value : facet.getArray("nested", new BsonArray()))
        {
            BsonDocument field = value.asDocument();
            BsonDocument id = field.getDocument("_id");
            String parent = id.getString("parent")
                    .getValue();
            String key = id.getString("key")
                    .getValue();
            if (key.isEmpty()
                    || key.contains(".")
                    || key.startsWith("$"))
            {
                continue;
            }
            children.computeIfAbsent(parent, k -> new ArrayList<>())
                    .add(sampledField(parent + "." + key, parent, field, sampled));
        }
        // _id first, then most common, then by name
        topLevel.sort(Comparator.<Map<String, Object>, Boolean> comparing(entry -> !"_id".equals(entry.get("name")))
                .thenComparing(FIELD_ORDER));
        for (Map<String, Object> entry : topLevel)
        {
            result.add(entry);
            List<Map<String, Object>> nested = children.getOrDefault(entry.get("name"), List.of());
            result.addAll(nested.stream()
                    .sorted(FIELD_ORDER)
                    .limit(FIELD_SAMPLE_MAX_CHILDREN)
                    .toList());
        }
        return result;
    }

    /** Most common first, then by name. */
    private static final Comparator<Map<String, Object>> FIELD_ORDER = Comparator.<Map<String, Object>, Long> comparing(entry -> -((Long) entry.get("count")))
            .thenComparing(entry -> ((String) entry.get("name")).toLowerCase(Locale.ROOT));

    private static Map<String, Object> sampledField(String name, String parent, BsonDocument group, long sampled)
    {
        List<String> types = new ArrayList<>();
        for (BsonValue type : group.getArray("types", new BsonArray()))
        {
            types.add(type.asString()
                    .getValue());
        }
        types.sort(Comparator.naturalOrder());
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("name", name);
        if (parent != null)
        {
            entry.put("parent", parent);
        }
        entry.put("types", types);
        entry.put("count", group.get("count")
                .asNumber()
                .longValue());
        entry.put("sampled", sampled);
        return entry;
    }

    /**
     * Value suggestions for the query bar's filter: the distinct values of a field (array elements counted one by one, like {@code distinct}) as
     * {@code { values: [{ type, text }], complete, sampled? }}. Collections over {@code exactMaxDocuments} documents are read through a random
     * sample of {@value #VALUE_SUGGESTION_SAMPLE_SIZE} documents, given as {@code sampled}, so rare values may be missing; views and
     * time-series collections are always read in full, since sampling them still runs their whole pipeline. {@code complete} is false, and
     * the list empty, when there are more than {@value #VALUE_SUGGESTION_LIMIT} values or the server gives up after
     * {@value #VALUE_SUGGESTION_MAX_TIME_MS} ms. Only values the filter can type in are listed (text, numbers, dates, ObjectIds, booleans),
     * sorted by type and then by value.
     */
    static Map<String, Object> distinctValues(MongoClient client, String database, String collection, String field, long exactMaxDocuments)
    {
        if (field.startsWith("$"))
        {
            throw new IllegalArgumentException("Not a field path: " + field);
        }
        MongoDatabase db = client.getDatabase(database);
        BsonDocument info = db.listCollections(BsonDocument.class)
                .filter(new BsonDocument("name", new BsonString(collection)))
                .first();
        boolean plainCollection = info != null
                && "collection".equals(info.getString("type", new BsonString("collection"))
                        .getValue());
        boolean sample = plainCollection
                && db.getCollection(collection)
                        .estimatedDocumentCount() > exactMaxDocuments;
        BsonString path = new BsonString("$" + field);
        List<BsonDocument> pipeline = new ArrayList<>();
        if (sample)
        {
            pipeline.add(new BsonDocument("$sample", new BsonDocument("size", new BsonInt32(VALUE_SUGGESTION_SAMPLE_SIZE))));
        }
        pipeline.add(new BsonDocument("$unwind", path));
        pipeline.add(new BsonDocument("$group", new BsonDocument("_id", path)));
        pipeline.add(new BsonDocument("$limit", new BsonInt32(VALUE_SUGGESTION_LIMIT + 1)));
        Map<String, Object> result = new LinkedHashMap<>();
        if (sample)
        {
            result.put("sampled", VALUE_SUGGESTION_SAMPLE_SIZE);
        }
        List<BsonDocument> groups;
        try
        {
            groups = client.getDatabase(database)
                    .getCollection(collection, BsonDocument.class)
                    .aggregate(pipeline)
                    .maxTime(VALUE_SUGGESTION_MAX_TIME_MS, TimeUnit.MILLISECONDS)
                    .into(new ArrayList<>());
        }
        catch (MongoExecutionTimeoutException e)
        {
            result.put("values", List.of());
            result.put("complete", false);
            return result;
        }
        boolean complete = groups.size() <= VALUE_SUGGESTION_LIMIT;
        List<Map<String, Object>> values = new ArrayList<>();
        if (complete)
        {
            for (BsonDocument group : groups)
            {
                Map<String, Object> value = suggestion(group.get("_id"));
                if (value != null)
                {
                    values.add(value);
                }
            }
            values.sort(Comparator.<Map<String, Object>, String> comparing(v -> (String) v.get("type"))
                    .thenComparing(MongoQueryEngineProvider::compareSuggestionText));
        }
        result.put("values", values);
        result.put("complete", complete);
        return result;
    }

    /**
     * Whole documents by {@code _id}, for the grid's "Copy document": {@code ids} is an Extended JSON array of {@code _id} values. Returns relaxed
     * Extended JSON text per document, indented, in the order of {@code ids}; ids that match nothing are left out.
     */
    static List<String> documentsById(MongoClient client, String database, String collection, String ids)
    {
        BsonArray idArray = BsonDocument.parse("{ \"ids\": " + ids + " }")
                .getArray("ids");
        if (idArray.size() > DOCUMENTS_LIMIT)
        {
            throw new IllegalArgumentException("At most " + DOCUMENTS_LIMIT + " documents can be copied at once");
        }
        Map<Object, BsonDocument> byId = new java.util.HashMap<>();
        client.getDatabase(database)
                .getCollection(collection, BsonDocument.class)
                .find(new BsonDocument("_id", new BsonDocument("$in", idArray)))
                .maxTime(DOCUMENTS_MAX_TIME_MS, TimeUnit.MILLISECONDS)
                .forEach(document -> byId.put(idKey(document.get("_id")), document));
        JsonWriterSettings indented = JsonWriterSettings.builder()
                .outputMode(JsonMode.RELAXED)
                .indent(true)
                .build();
        List<String> result = new ArrayList<>();
        for (BsonValue id : idArray)
        {
            BsonDocument document = byId.remove(idKey(id));
            if (document != null)
            {
                result.add(document.toJson(indented));
            }
        }
        return result;
    }

    /** Numbers match across int, long, double and decimal, as they do in the {@code $in} query. */
    private static Object idKey(BsonValue id)
    {
        if (id.isNumber()
                || id.isDecimal128())
        {
            java.math.BigDecimal number = id.isDecimal128() ? id.asDecimal128()
                    .getValue()
                    .bigDecimalValue()
                    : new java.math.BigDecimal(id.isDouble() ? Double.toString(id.asDouble()
                            .getValue())
                            : Long.toString(id.asNumber()
                                    .longValue()));
            return "number:" + number.stripTrailingZeros()
                    .toPlainString();
        }
        return id;
    }

    /** {@code { type, text }} with {@code type} a {@code $type} name, or null for values the filter cannot type in. */
    private static Map<String, Object> suggestion(BsonValue value)
    {
        String type;
        String text;
        switch (value.getBsonType())
        {
            case STRING ->
            {
                type = "string";
                text = value.asString()
                        .getValue();
            }
            case INT32 ->
            {
                type = "int";
                text = Integer.toString(value.asInt32()
                        .getValue());
            }
            case INT64 ->
            {
                type = "long";
                text = Long.toString(value.asInt64()
                        .getValue());
            }
            case DOUBLE ->
            {
                type = "double";
                double d = value.asDouble()
                        .getValue();
                if (!Double.isFinite(d))
                {
                    return null;
                }
                text = d == Math.rint(d)
                        && Math.abs(d) < 1e15 ? Long.toString((long) d)
                                : Double.toString(d);
            }
            case DECIMAL128 ->
            {
                type = "decimal";
                text = value.asDecimal128()
                        .getValue()
                        .toString();
            }
            case DATE_TIME ->
            {
                type = "date";
                text = java.time.Instant.ofEpochMilli(value.asDateTime()
                        .getValue())
                        .toString();
            }
            case OBJECT_ID ->
            {
                type = "objectId";
                text = value.asObjectId()
                        .getValue()
                        .toHexString();
            }
            case BOOLEAN ->
            {
                type = "bool";
                text = Boolean.toString(value.asBoolean()
                        .getValue());
            }
            default ->
            {
                return null;
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", type);
        result.put("text", text);
        return result;
    }

    /** Numbers in numeric order, everything else by text. */
    private static int compareSuggestionText(Map<String, Object> a, Map<String, Object> b)
    {
        String x = (String) a.get("text");
        String y = (String) b.get("text");
        if (switch ((String) a.get("type"))
        {
            case "int", "long", "double", "decimal" -> true;
            default -> false;
        })
        {
            return new java.math.BigDecimal(x).compareTo(new java.math.BigDecimal(y));
        }
        return x.compareTo(y);
    }

    private static String requiredText(Map<?, ?> payload, String key)
    {
        if (payload.get(key) instanceof String value
                && !value.isBlank())
        {
            return value;
        }
        throw new IllegalArgumentException("\"" + key + "\" is required");
    }

    /** Cancels everything still running and stops the timeout watchdog. Used when the plugin is deactivated. */
    void shutdown()
    {
        List.copyOf(executions.keySet())
                .forEach(this::cancel);
        watchdogs.shutdownNow();
    }

    private String resolveConnectionId(String fileId, Map<?, ?> state)
    {
        if (state.get(STATE_CONNECTION_ID) instanceof String id
                && !id.isBlank())
        {
            return id;
        }
        String bound = fileConnections.connectionId(fileId);
        if (bound != null)
        {
            return bound;
        }
        throw new QueryValidationException("No MongoDB connection is selected for this file");
    }

    /** {@code $db} in the command, then the file's selected database, then the connection's default database. */
    private static String resolveDatabase(ParsedCommand command, Map<?, ?> state, MongoConnectionSettings settings)
    {
        if (command.database() != null)
        {
            return command.database();
        }
        String name = command.name();
        if ("listDatabases".equals(name))
        {
            return "admin";
        }
        if (state.get(STATE_DATABASE) instanceof String database
                && !database.isBlank())
        {
            return database;
        }
        if (settings.defaultDatabase() != null)
        {
            return settings.defaultDatabase();
        }
        if ("ping".equals(name)
                || "buildInfo".equals(name))
        {
            return "admin";
        }
        throw new QueryValidationException("No database selected. Choose a database for this file, set a default database on the connection, or add \"$db\" to the command",
                command.line(), command.column());
    }

    private static String commandErrorMessage(MongoException e)
    {
        if (e instanceof MongoCommandException command)
        {
            return command.getErrorMessage() + " (" + command.getErrorCodeName() + ", code " + command.getErrorCode() + ")";
        }
        return e.getMessage();
    }
}
