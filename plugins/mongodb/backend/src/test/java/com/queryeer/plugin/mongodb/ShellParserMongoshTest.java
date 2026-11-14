package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonDouble;
import org.bson.BsonValue;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.Container.ExecResult;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Checks the shell parser against the real thing: each statement runs in mongosh (shipped in the mongo image) with the profiler on, and the
 * command mongosh sent, as the server recorded it, must equal the command {@link ShellParser} produces for the same text.
 */
class ShellParserMongoshTest
{
    private static final String DATABASE = "shellcheck";
    /** Fields drivers add to every command, which say nothing about the query. */
    private static final Set<String> SESSION_FIELDS = Set.of("lsid", "$clusterTime", "$db", "$readPreference", "apiVersion", "apiStrict", "apiDeprecationErrors",
            "txnNumber", "$client");

    /** Statements whose command intentionally differs from mongosh's, with the reason. */
    private static final Map<String, String> INTENTIONAL_DIFFERENCES = Map.of("db.orders.countDocuments({ status: 'paid' })",
            "mongosh sends an aggregate ($match + $group) that returns no row for no matches; the count command returns { n: 0 }");

    private static final List<String> STATEMENTS = List.of(
            "db.orders.find()",
            "db.orders.find({ status: 'paid' }, { _id: 0, total: 1 })",
            "db.orders.find({}).sort({ total: -1 }).skip(1).limit(2)",
            "db.orders.find({ total: { $gte: 10 } }).projection({ status: 1 }).batchSize(5)",
            "db.orders.find({}, {}, { sort: { total: 1 }, limit: 3 })",
            "db.orders.find({ status: /^pa/i })",
            "db.orders.find({ at: { $lt: ISODate('2030-01-01T00:00:00Z') } })",
            "db.orders.find({ at: { $lt: new Date('2030-01-01T00:00:00Z') } })",
            "db.orders.find({ _id: { $in: [1, 2, NumberLong(3)] } })",
            "db.orders.find().hint({ _id: 1 })",
            "db.orders.find().collation({ locale: 'sv' })",
            "db.orders.findOne({ status: 'paid' })",
            "db.orders.find({ status: 'paid' }).count()",
            "db.orders.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$status', n: { $sum: 1 } } }])",
            "db.orders.aggregate([{ $sort: { total: -1 } }], { allowDiskUse: true })",
            "db.orders.countDocuments({ status: 'paid' })",
            "db.orders.estimatedDocumentCount()",
            "db.orders.distinct('status')",
            "db.orders.distinct('status', { total: { $gt: 5 } })",
            "db.orders.getIndexes()",
            "db.orders.find({ status: 'paid' }).explain('executionStats')",
            "db.orders.explain('queryPlanner').aggregate([{ $match: {} }])",
            "db.getCollection('orders').find({ total: 10 })",
            "db.runCommand({ count: 'orders', query: { status: 'new' } })");

    private static GenericContainer<?> mongo;

    @BeforeAll
    static void startMongo()
    {
        assumeTrue(DockerClientFactory.instance()
                .isDockerAvailable(), "Docker is not available");
        mongo = new GenericContainer<>(DockerImageName.parse("mongo:7.0")).withExposedPorts(27017);
        mongo.start();
    }

    @AfterAll
    static void stopMongo()
    {
        if (mongo != null)
        {
            mongo.stop();
        }
    }

    @Test
    void sendsWhatMongoshSends() throws Exception
    {
        List<List<BsonDocument>> sent = runInMongosh();
        CommandParser parser = new CommandParser();
        List<String> mismatches = new ArrayList<>();
        for (int i = 0; i < STATEMENTS.size(); i++)
        {
            String statement = STATEMENTS.get(i);
            List<BsonDocument> theirs = sent.get(i);
            assertEquals(1, theirs.size(), "commands mongosh sent for " + statement + ": " + theirs);
            BsonDocument ours = parser.parse(statement)
                    .get(0)
                    .command();
            boolean same = normalize(ours).equals(normalize(theirs.get(0)));
            if (INTENTIONAL_DIFFERENCES.containsKey(statement))
            {
                assertTrue(!same, "now equal to mongosh, so remove it from INTENTIONAL_DIFFERENCES: " + statement);
            }
            else if (!same)
            {
                mismatches.add(statement + "\n    ours:    " + ours.toJson() + "\n    mongosh: " + theirs.get(0)
                        .toJson());
            }
        }
        assertEquals(List.of(), mismatches, () -> "Commands that differ from mongosh's:\n" + String.join("\n", mismatches));
    }

    /** Runs every statement in one mongosh session and returns, per statement, the commands the server profiled for it. */
    private static List<List<BsonDocument>> runInMongosh() throws Exception
    {
        StringBuilder script = new StringBuilder();
        script.append("db = db.getSiblingDB('" + DATABASE + "');\n")
                .append("db.dropDatabase();\n")
                .append("db.orders.insertMany([{ _id: 1, status: 'paid', total: 10, at: new Date() }, { _id: 2, status: 'new', total: 20, at: new Date() }]);\n")
                .append("db.markers.insertOne({ _id: 0 });\n")
                .append("db.setProfilingLevel(2);\n");
        for (int i = 0; i < STATEMENTS.size(); i++)
        {
            // A marker query before each statement splits the profile into one group per statement
            // Cursors only send their command when read, which the REPL does by printing and a script has to do itself
            script.append("db.markers.findOne({ _id: " + i + " });\n")
                    .append("var result" + i + " = " + STATEMENTS.get(i) + ";\n")
                    .append("if (result" + i + " && typeof result" + i + ".toArray === 'function') { result" + i + ".toArray(); }\n");
        }
        script.append("db.markers.findOne({ _id: " + STATEMENTS.size() + " });\n")
                .append("db.setProfilingLevel(0);\n")
                .append("db.system.profile.find({ ns: { $ne: '" + DATABASE + ".system.profile' } })"
                        + ".forEach(p => print(EJSON.stringify(p.command, { relaxed: false })));\n");
        ExecResult result = mongo.execInContainer("mongosh", "--quiet", "--norc", "--eval", script.toString());
        assertEquals(0, result.getExitCode(), result.getStderr());

        List<List<BsonDocument>> groups = new ArrayList<>();
        List<BsonDocument> current = null;
        for (String line : result.getStdout()
                .split("\\R"))
        {
            if (!line.startsWith("{"))
            {
                continue;
            }
            BsonDocument command = BsonDocument.parse(line);
            if ("markers".equals(command.get("find") instanceof BsonValue v
                    && v.isString() ? v.asString()
                            .getValue()
                            : null))
            {
                current = new ArrayList<>();
                groups.add(current);
                continue;
            }
            if (current != null
                    && !command.containsKey("getMore")
                    && !command.containsKey("killCursors"))
            {
                current.add(command);
            }
        }
        // The last marker only closes the last statement's group
        assertEquals(STATEMENTS.size() + 1, groups.size(), result.getStdout());
        return groups.subList(0, STATEMENTS.size());
    }

    /** Key order, number types and session fields do not change what a command does. */
    private static BsonValue normalize(BsonValue value)
    {
        if (value.isDocument())
        {
            Map<String, BsonValue> sorted = new TreeMap<>();
            value.asDocument()
                    .forEach((key, item) ->
                    {
                        if (!SESSION_FIELDS.contains(key))
                        {
                            sorted.put(key, normalize(item));
                        }
                    });
            BsonDocument document = new BsonDocument();
            sorted.forEach(document::put);
            return document;
        }
        if (value.isArray())
        {
            BsonArray array = new BsonArray();
            value.asArray()
                    .forEach(item -> array.add(normalize(item)));
            return array;
        }
        if (value.isNumber())
        {
            return new BsonDouble(value.asNumber()
                    .doubleValue());
        }
        return value;
    }
}
