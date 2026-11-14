package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.bson.BsonDocument;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.api.Test;

/** Shell statements through {@link CommandParser}, which hands {@code db.} statements to {@link ShellParser}. */
class ShellParserTest
{
    private final CommandParser parser = new CommandParser();

    private ParsedCommand only(String text)
    {
        List<ParsedCommand> commands = parser.parse(text);
        assertEquals(1, commands.size(), "one command from: " + text);
        return commands.get(0);
    }

    /** Statement | expected command (relaxed Extended JSON; key order does not matter). */
    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', quoteCharacter = '`', textBlock = """
            db.orders.find()                                                        | { find: 'orders', filter: {} }
            db.orders.find({})                                                      | { find: 'orders', filter: {} }
            db.orders.find({ status: 'paid' }, { _id: 0, total: 1 })                | { find: 'orders', filter: { status: 'paid' }, projection: { _id: 0, total: 1 } }
            db.orders.find({}).sort({ total: -1 }).skip(10).limit(5)                | { find: 'orders', filter: {}, sort: { total: -1 }, skip: 10, limit: 5 }
            db.orders.find().projection({ a: 1 }).batchSize(2).hint({ a: 1 })      | { find: 'orders', filter: {}, projection: { a: 1 }, batchSize: 2, hint: { a: 1 } }
            db.orders.find({}, {}, { sort: { a: 1 }, limit: 3 })                    | { find: 'orders', filter: {}, projection: {}, sort: { a: 1 }, limit: 3 }
            db.orders.find().collation({ locale: 'sv' }).comment('x').maxTimeMS(9) | { find: 'orders', filter: {}, collation: { locale: 'sv' }, comment: 'x', maxTimeMS: 9 }
            db.orders.find().pretty()                                               | { find: 'orders', filter: {} }
            db.orders.find().toArray()                                              | { find: 'orders', filter: {} }
            db.orders.findOne({ _id: 1 })                                           | { find: 'orders', filter: { _id: 1 }, limit: 1 }
            db.orders.find({ a: 1 }).count()                                        | { count: 'orders', query: { a: 1 } }
            db.orders.find({ a: 1 }).skip(1).limit(2).size()                        | { count: 'orders', query: { a: 1 }, skip: 1, limit: 2 }
            db.orders.aggregate([{ $match: { a: 1 } }])                             | { aggregate: 'orders', pipeline: [{ $match: { a: 1 } }], cursor: {} }
            db.orders.aggregate([], { allowDiskUse: true, batchSize: 5 })           | { aggregate: 'orders', pipeline: [], allowDiskUse: true, cursor: { batchSize: 5 } }
            db.orders.aggregate({ $match: {} }, { $limit: 1 })                      | { aggregate: 'orders', pipeline: [{ $match: {} }, { $limit: 1 }], cursor: {} }
            db.orders.aggregate([]).batchSize(7)                                    | { aggregate: 'orders', pipeline: [], cursor: { batchSize: 7 } }
            db.orders.countDocuments({ a: 1 }, { limit: 5 })                        | { count: 'orders', query: { a: 1 }, limit: 5 }
            db.orders.countDocuments()                                              | { count: 'orders' }
            db.orders.count({ a: 1 })                                               | { count: 'orders', query: { a: 1 } }
            db.orders.estimatedDocumentCount()                                      | { count: 'orders' }
            db.orders.distinct('status')                                            | { distinct: 'orders', key: 'status', query: {} }
            db.orders.distinct("status", { total: { $gt: 5 } })                     | { distinct: 'orders', key: 'status', query: { total: { $gt: 5 } } }
            db.orders.getIndexes()                                                  | { listIndexes: 'orders', cursor: {} }
            db.orders.stats()                                                       | { collStats: 'orders' }
            db.orders.find().explain()                                              | { explain: { find: 'orders', filter: {} }, verbosity: 'queryPlanner' }
            db.orders.find({}).explain('executionStats')                            | { explain: { find: 'orders', filter: {} }, verbosity: 'executionStats' }
            db.orders.explain('allPlansExecution').aggregate([])                    | { explain: { aggregate: 'orders', pipeline: [], cursor: {} }, verbosity: 'allPlansExecution' }
            db.orders.find().explain(true)                                          | { explain: { find: 'orders', filter: {} }, verbosity: 'allPlansExecution' }
            db.reports.monthly.find()                                               | { find: 'reports.monthly', filter: {} }
            db.getCollection('reports.monthly').find()                              | { find: 'reports.monthly', filter: {} }
            db.getCollection('system.profile').find().sort({ ts: -1 })              | { find: 'system.profile', filter: {}, sort: { ts: -1 } }
            db.runCommand({ dbStats: 1 })                                           | { dbStats: 1 }
            db.stats()                                                              | { dbStats: 1 }
            db.getCollectionNames()                                                 | { listCollections: 1, nameOnly: true }
            db.getCollectionInfos({ type: 'view' })                                 | { listCollections: 1, filter: { type: 'view' } }
            db . orders . find ( { } ) . limit ( 1 ) ;                              | { find: 'orders', filter: {}, limit: 1 }
            """)
    void translatesStatementsToCommands(String statement, String expected)
    {
        assertEquals(BsonDocument.parse(expected), only(statement).command());
    }

    @Test
    void readsShellValuesThroughTheBsonReader()
    {
        BsonDocument filter = only("""
                db.orders.find({
                  _id: ObjectId("650000000000000000000001"),
                  at: { $gte: ISODate("2026-11-14T00:00:00Z"), $lt: new Date("2026-11-15") },
                  createdOn: new Date(1700000000000),
                  big: NumberLong("9007199254740993"),
                  price: NumberDecimal('12.50'),
                  name: /^al.*\\/x/i,
                  'quoted key': 'single "quoted"',
                  trailing: [1, 2, 3,],
                })
                """).command()
                .getDocument("filter");

        assertTrue(filter.get("_id")
                .isObjectId());
        assertTrue(filter.getDocument("at")
                .get("$gte")
                .isDateTime());
        assertEquals(1794700800000L, filter.getDocument("at")
                .get("$lt")
                .asDateTime()
                .getValue(), "new Date with an ISO string, as mongosh reads it");
        assertEquals(1700000000000L, filter.get("createdOn")
                .asDateTime()
                .getValue());
        assertEquals(9007199254740993L, filter.get("big")
                .asInt64()
                .getValue());
        assertTrue(filter.get("price")
                .isDecimal128());
        assertEquals("^al.*\\/x", filter.get("name")
                .asRegularExpression()
                .getPattern());
        assertEquals("single \"quoted\"", filter.getString("quoted key")
                .getValue());
        assertEquals(3, filter.getArray("trailing")
                .size());
    }

    @Test
    void takesTheDatabaseFromGetSiblingDbAndAdminCommand()
    {
        ParsedCommand sibling = only("db.getSiblingDB('reports').monthly.find()");
        assertEquals("reports", sibling.database());
        assertEquals(BsonDocument.parse("{ find: 'monthly', filter: {} }"), sibling.command());

        assertEquals("admin", only("db.adminCommand({ ping: 1 })").database());
        assertEquals("other", only("db.getSiblingDB(\"other\").runCommand({ ping: 1 })").database());
        assertNull(only("db.orders.find()").database());
    }

    @Test
    void mixesShellStatementsAndJsonDocumentsWithCommentsAndPositions()
    {
        List<ParsedCommand> commands = parser.parse("""
                // shell, then JSON, then shell, mixed on lines
                db.orders.find({ note: "a // not a comment, and a ) too" }) // trailing comment
                { "count": "orders" /* inside a document */, "query": { "a": 1 } }
                  db.orders.distinct('status'); db.orders.getIndexes()
                /* db.orders.drop() in a comment is not run */
                """);

        assertEquals(List.of("find", "count", "distinct", "listIndexes"), commands.stream()
                .map(ParsedCommand::name)
                .toList());
        assertEquals("a // not a comment, and a ) too", commands.get(0)
                .command()
                .getDocument("filter")
                .getString("note")
                .getValue());
        assertEquals(BsonDocument.parse("{ count: 'orders', query: { a: 1 } }"), commands.get(1)
                .command(), "a comment inside a JSON document is ignored, not read as a regular expression");
        assertEquals(2, commands.get(0)
                .line());
        assertEquals(1, commands.get(0)
                .column());
        assertEquals(4, commands.get(2)
                .line());
        assertEquals(3, commands.get(2)
                .column());
        assertEquals(4, commands.get(3)
                .line());
    }

    /**
     * The query bar's Templates menu offers each template as a JSON command and as a shell statement (frontend queries.ts: templateCommand and
     * shellTemplateText). Both must run the same command.
     */
    @Test
    void shellTemplatesMatchTheirJsonTwins()
    {
        String aggregate = """
                db.orders.aggregate([
                  { $match: {} },
                  { $group: { _id: "$field", count: { $sum: 1 } } },
                  { $sort: { count: -1 } },
                  { $limit: 50 }
                ])
                """;
        assertEquals(BsonDocument.parse("{ find: 'orders', filter: {}, projection: {}, sort: { _id: 1 }, skip: 0, limit: 50 }"),
                only("db.orders.find({}, {}).sort({ _id: 1 }).skip(0).limit(50)\n").command());
        assertEquals(BsonDocument.parse("""
                { aggregate: 'orders', pipeline: [{ $match: {} }, { $group: { _id: '$field', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 50 }],
                  cursor: {} }
                """), only(aggregate).command());
        assertEquals(BsonDocument.parse("{ count: 'orders', query: {} }"), only("db.orders.countDocuments({})\n").command());
        assertEquals(BsonDocument.parse("{ distinct: 'orders', key: 'field', query: {} }"), only("db.orders.distinct(\"field\", {})\n").command());
        assertEquals(BsonDocument.parse("{ count: 'variantsku-pricehistory', query: {} }"), only("db.getCollection(\"variantsku-pricehistory\").countDocuments({})\n")
                .command());
    }

    @Test
    void multiLineStatements()
    {
        ParsedCommand command = only("""
                db.orders
                  .find({ status: "paid" })
                  .sort({ total: -1 })
                  .limit(10)
                """);
        assertEquals(BsonDocument.parse("{ find: 'orders', filter: { status: 'paid' }, sort: { total: -1 }, limit: 10 }"), command.command());
    }

    /** Statement | start of the expected message | line | column. */
    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', quoteCharacter = '`', textBlock = """
            db.orders.insertOne({ a: 1 })                    | db.orders.insertOne() writes data and is not allowed           | 1 | 11
            db.orders.drop()                                 | db.orders.drop() writes data and is not allowed                | 1 | 11
            db.orders.findOneAndUpdate({}, {})               | db.orders.findOneAndUpdate() writes data                       | 1 | 11
            db.orders.mapReduce()                            | db.orders.mapReduce() is not supported. Supported: find,       | 1 | 11
            db.orders.find().forEach(printjson)              | Invalid arguments to forEach()                                 | 1 | 18
            db.orders.find().forEach(d => print(d))          | forEach() is given a function. Queries are not run as JavaScr  | 1 | 18
            db.orders.find().next()                          | .next() cannot follow find(). Queries are not run as JavaScr   | 1 | 18
            db.orders.aggregate([]).sort({ a: 1 })           | .sort() cannot follow aggregate()                              | 1 | 25
            db.orders.find().explain().explain()             | explain is given twice                                         | 1 | 28
            db.orders.find().explain('everything')           | explain() takes                                                | 1 | 18
            db.orders.find({ a: 1 )                          | find( is not closed                                            | 1 | 11
            db.orders.find({ a: })                           | Invalid arguments to find()                                    | 1 | 11
            db.orders.find('status')                         | find() expects the filter as a document (first argument)      | 1 | 11
            db.orders.distinct()                             | distinct() expects the field name as a string                 | 1 | 11
            db.orders                                        | Expected '.' at the end                                        | 1 | 9
            db.orders.find                                   | Expected '.' at the end                                        | 1 | 14
            db.orders.find() + 1                             | Unexpected '+' after the statement                             | 1 | 18
            db.find()                                        | Name a collection, e.g. db.orders.find()                       | 1 | 4
            db.dropDatabase()                                | db.dropDatabase() writes data and is not allowed               | 1 | 4
            db.serverStatus()                                | db.serverStatus() is not supported. Supported: getSiblingDB    | 1 | 4
            db.runCommand()                                  | db.runCommand() needs the command document, e.g. db.runComman  | 1 | 4
            db.runCommand('ping')                            | runCommand() expects the command document as a document        | 1 | 4
            db.getCollection(5).find()                       | getCollection() expects the collection name as a string        | 1 | 4
            db.orders.find({ name: /unclosed })              | Regular expression is not closed                               | 1 | 24
            """)
    void reportsUnsupportedOrInvalidStatementsWithPositions(String statement, String message, int line, int column)
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> parser.parse(statement));
        assertTrue(e.getMessage()
                .startsWith(message), e.getMessage());
        assertEquals(line, e.line(), e.getMessage());
        assertEquals(column, e.column(), e.getMessage());
    }

    @Test
    void writesStayRejectedThroughRunCommandByThePolicy()
    {
        ParsedCommand command = only("db.runCommand({ delete: 'orders', deletes: [] })");
        assertThrows(QueryValidationException.class, () -> new CommandPolicy().validate(command));
        ParsedCommand stage = only("db.orders.aggregate([{ $out: 'copy' }])");
        assertThrows(QueryValidationException.class, () -> new CommandPolicy().validate(stage));
    }

    @Test
    void textThatIsNeitherFormNamesBoth()
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> parser.parse("orders.find()"));
        assertTrue(e.getMessage()
                .startsWith("Expected a command document ({ \"find\": \"orders\" }) or a shell statement (db.orders.find())"), e.getMessage());
        // "dbx." is not "db."
        assertThrows(QueryValidationException.class, () -> parser.parse("dbx.orders.find()"));
    }
}
