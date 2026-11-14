package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import org.bson.BsonArray;
import org.bson.BsonBoolean;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.BsonInvalidOperationException;
import org.bson.BsonString;
import org.bson.BsonValue;
import org.bson.json.JsonParseException;

import com.queryeer.plugin.mongodb.SourceScanner.LineIndex;

/**
 * Translates mongosh-style statements into the command documents the drivers send, so they run exactly like the JSON form:
 *
 * <pre>
 * db.orders.find({ status: "paid" }, { _id: 0 }).sort({ total: -1 }).limit(20)   → { find: "orders", filter, projection, sort, limit }
 * db.orders.aggregate([...])                                                      → { aggregate: "orders", pipeline, cursor: {} }
 * db.orders.countDocuments({...})                                                 → { count: "orders", query }
 * db.getSiblingDB("shop").orders.find()                                           → the find, with $db "shop"
 * db.runCommand({ ... })                                                          → the document as it is
 * </pre>
 *
 * <p>
 * This is a fixed grammar, not a JavaScript interpreter: no variables, functions or loops. Arguments are parsed by the BSON reader, which
 * accepts unquoted keys, single quotes, trailing commas and shell helpers ({@code ObjectId}, {@code ISODate}, {@code NumberLong},
 * {@code /regex/i}, ...). Writes are rejected here with a clear message; the {@link CommandPolicy} still validates every command.
 * </p>
 */
final class ShellParser
{
    /** One statement: its command and the index just after it (after an optional ';'). */
    record Statement(ParsedCommand command, int end)
    {
    }

    /** One {@code .name(args)} call. */
    private record Call(String name, BsonArray args, int line, int column)
    {
    }

    static final List<String> COLLECTION_METHODS = List.of("find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "count", "distinct", "getIndexes",
            "stats", "explain");
    static final List<String> DATABASE_METHODS = List.of("getSiblingDB", "getCollection", "runCommand", "adminCommand", "getCollectionNames", "getCollectionInfos", "stats");
    private static final Set<String> FIND_MODIFIERS = Set.of("sort", "limit", "skip", "projection", "batchSize", "hint", "collation", "comment", "maxTimeMS", "allowDiskUse",
            "min", "max", "returnKey", "showRecordId", "noCursorTimeout");
    private static final Set<String> NO_OPS = Set.of("pretty", "toArray");
    private static final Set<String> WRITES = Set.of("insert", "insertOne", "insertMany", "update", "updateOne", "updateMany", "replaceOne", "remove", "delete", "deleteOne",
            "deleteMany", "save", "drop", "dropDatabase", "findAndModify", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite", "createIndex",
            "createIndexes", "dropIndex", "dropIndexes", "renameCollection", "createCollection", "createView");
    private static final Set<String> DATABASE_WRITES = Set.of("dropDatabase", "createCollection", "createView", "createUser", "dropUser", "dropAllUsers", "createRole",
            "dropRole", "grantRolesToUser", "revokeRolesFromUser", "setProfilingLevel", "shutdownServer", "killOp", "fsyncLock");
    private static final String NOT_JAVASCRIPT = "Queries are not run as JavaScript, so variables, functions and cursor iteration are not available";

    private String source;
    private LineIndex lines;
    private int pos;

    /** Whether a shell statement starts at {@code i}: {@code db} followed by {@code .}. */
    static boolean startsStatement(String source, int i)
    {
        if (!source.startsWith("db", i)
                || (i > 0
                        && Character.isJavaIdentifierPart(source.charAt(i - 1))))
        {
            return false;
        }
        int j = i + 2;
        while (j < source.length()
                && (source.charAt(j) == ' '
                        || source.charAt(j) == '\t'))
        {
            j++;
        }
        return j < source.length()
                && source.charAt(j) == '.';
    }

    Statement parse(String text, int start, LineIndex index)
    {
        this.source = text;
        this.lines = index;
        this.pos = start + 2;
        int line = lines.line(start);
        int column = lines.column(start);

        String database = null;
        List<String> path = new ArrayList<>();
        String collection = null;
        Call first;
        while (true)
        {
            expect('.');
            int nameAt = skipSpace();
            String name = identifier();
            skipSpace();
            if (peek() != '(')
            {
                if (collection != null)
                {
                    throw error("Expected a method call after the collection, e.g. ." + "find()", nameAt);
                }
                path.add(name);
                continue;
            }
            Call call = call(name, nameAt);
            if (collection == null
                    && path.isEmpty())
            {
                switch (name)
                {
                    case "getSiblingDB" ->
                    {
                        database = stringArg(call, 0, "the database name");
                        continue;
                    }
                    case "getCollection" ->
                    {
                        collection = stringArg(call, 0, "the collection name");
                        continue;
                    }
                    case "runCommand", "adminCommand" ->
                    {
                        BsonDocument command = documentArg(call, 0, "the command document");
                        if (command == null
                                || command.isEmpty())
                        {
                            throw error("db." + name + "() needs the command document, e.g. db." + name + "({ ping: 1 })", call);
                        }
                        return finish(new ParsedCommand("adminCommand".equals(name) ? "admin"
                                : database, command, line, column), List.of());
                    }
                    case "getCollectionNames", "getCollectionInfos" ->
                    {
                        BsonDocument command = new BsonDocument("listCollections", new BsonInt32(1));
                        BsonDocument filter = documentArg(call, 0, "the filter");
                        if (filter != null)
                        {
                            command.put("filter", filter);
                        }
                        if ("getCollectionNames".equals(name))
                        {
                            command.put("nameOnly", BsonBoolean.TRUE);
                        }
                        return finish(new ParsedCommand(database, command, line, column), chain());
                    }
                    case "stats" ->
                    {
                        return finish(new ParsedCommand(database, new BsonDocument("dbStats", new BsonInt32(1)), line, column), chain());
                    }
                    default ->
                    {
                        if (DATABASE_WRITES.contains(name))
                        {
                            throw error("db." + name + "() writes data and is not allowed. This plugin is read-only", call);
                        }
                        if (COLLECTION_METHODS.contains(name)
                                || WRITES.contains(name))
                        {
                            throw error("Name a collection, e.g. db.orders." + name + "()", call);
                        }
                        throw unsupported("db." + name + "()", DATABASE_METHODS, call);
                    }
                }
            }
            if (collection == null)
            {
                collection = String.join(".", path);
            }
            first = call;
            break;
        }

        // db.orders.explain("executionStats").find(...)
        String verbosity = null;
        if ("explain".equals(first.name()))
        {
            verbosity = explainVerbosity(first);
            expect('.');
            int nameAt = skipSpace();
            first = call(identifier(), nameAt);
        }
        BsonDocument command = collectionCommand(collection, first);
        List<Call> chain = chain();
        for (Call call : chain)
        {
            if ("explain".equals(call.name()))
            {
                if (verbosity != null)
                {
                    throw error("explain is given twice", call);
                }
                verbosity = explainVerbosity(call);
            }
            else if (NO_OPS.contains(call.name()))
            {
                continue;
            }
            else if (("count".equals(call.name())
                    || "size".equals(call.name()))
                    && command.containsKey("find"))
            {
                command = cursorCount(command, "size".equals(call.name()));
            }
            else if (command.containsKey("find")
                    && FIND_MODIFIERS.contains(call.name()))
            {
                command.put(findOption(call.name()), call.args()
                        .isEmpty() ? BsonBoolean.TRUE
                                : call.args()
                                        .get(0));
            }
            else if (command.containsKey("aggregate")
                    && "batchSize".equals(call.name()))
            {
                command.put("cursor", new BsonDocument("batchSize", numberArg(call, 0, "the batch size")));
            }
            else
            {
                throw error("." + call.name() + "() cannot follow " + firstKey(command) + ". " + NOT_JAVASCRIPT, call);
            }
        }
        if (verbosity != null)
        {
            command = new BsonDocument("explain", command).append("verbosity", new BsonString(verbosity));
        }
        return finish(new ParsedCommand(database, command, line, column), List.of());
    }

    /** The command for the first method called on a collection. */
    private BsonDocument collectionCommand(String collection, Call call)
    {
        if (collection.isEmpty())
        {
            throw error("Name a collection, e.g. db.orders." + call.name() + "()", call);
        }
        BsonString name = new BsonString(collection);
        switch (call.name())
        {
            case "find", "findOne" ->
            {
                // Like mongosh, always with a filter ({} when none is given)
                BsonDocument filter = documentArg(call, 0, "the filter");
                BsonDocument command = new BsonDocument("find", name).append("filter", filter == null ? new BsonDocument()
                        : filter);
                putIfPresent(command, "projection", documentArg(call, 1, "the projection"));
                merge(command, documentArg(call, 2, "the options"));
                if ("findOne".equals(call.name()))
                {
                    command.put("limit", new BsonInt32(1));
                }
                return command;
            }
            case "aggregate" ->
            {
                BsonArray pipeline;
                BsonDocument options = null;
                if (!call.args()
                        .isEmpty()
                        && call.args()
                                .get(0)
                                .isArray())
                {
                    pipeline = call.args()
                            .get(0)
                            .asArray();
                    options = documentArg(call, 1, "the options");
                }
                else
                {
                    // The older form: stages as separate arguments
                    pipeline = new BsonArray();
                    for (int i = 0; i < call.args()
                            .size(); i++)
                    {
                        pipeline.add(documentArg(call, i, "a pipeline stage"));
                    }
                }
                BsonDocument command = new BsonDocument("aggregate", name).append("pipeline", pipeline);
                BsonDocument cursor = new BsonDocument();
                if (options != null)
                {
                    BsonValue batchSize = options.remove("batchSize");
                    if (batchSize != null)
                    {
                        cursor.put("batchSize", batchSize);
                    }
                    merge(command, options);
                }
                command.put("cursor", cursor);
                return command;
            }
            case "countDocuments", "count" ->
            {
                // mongosh runs countDocuments as an aggregation ($match + $group), which returns no row at all for no matches and leaves the 0 to
                // the shell; the count command (what mongosh's count() sends) returns { n: 0 }, so it is used for both
                BsonDocument command = new BsonDocument("count", name);
                putIfPresent(command, "query", documentArg(call, 0, "the filter"));
                merge(command, documentArg(call, 1, "the options"));
                return command;
            }
            case "estimatedDocumentCount" ->
            {
                BsonDocument command = new BsonDocument("count", name);
                merge(command, documentArg(call, 0, "the options"));
                return command;
            }
            case "distinct" ->
            {
                BsonDocument query = documentArg(call, 1, "the filter");
                BsonDocument command = new BsonDocument("distinct", name).append("key", new BsonString(stringArg(call, 0, "the field name")))
                        .append("query", query == null ? new BsonDocument()
                                : query);
                merge(command, documentArg(call, 2, "the options"));
                return command;
            }
            case "getIndexes", "getIndexSpecs" ->
            {
                return new BsonDocument("listIndexes", name).append("cursor", new BsonDocument());
            }
            case "stats" ->
            {
                return new BsonDocument("collStats", name);
            }
            default ->
            {
                if (WRITES.contains(call.name()))
                {
                    throw error("db." + collection + "." + call.name() + "() writes data and is not allowed. This plugin is read-only", call);
                }
                throw unsupported("db." + collection + "." + call.name() + "()", COLLECTION_METHODS, call);
            }
        }
    }

    /** {@code find(...).count()} / {@code .size()}: the count command for the find's filter (size also applies skip and limit, as in mongosh). */
    private static BsonDocument cursorCount(BsonDocument find, boolean applySkipAndLimit)
    {
        BsonDocument command = new BsonDocument("count", find.get("find"));
        if (find.containsKey("filter"))
        {
            command.put("query", find.get("filter"));
        }
        if (applySkipAndLimit)
        {
            for (String key : List.of("skip", "limit"))
            {
                if (find.containsKey(key))
                {
                    command.put(key, find.get(key));
                }
            }
        }
        return command;
    }

    private static String findOption(String modifier)
    {
        return switch (modifier)
        {
            case "showRecordId" -> "showRecordId";
            default -> modifier;
        };
    }

    private String explainVerbosity(Call call)
    {
        if (call.args()
                .isEmpty())
        {
            return "queryPlanner";
        }
        BsonValue value = call.args()
                .get(0);
        if (value.isBoolean())
        {
            return value.asBoolean()
                    .getValue() ? "allPlansExecution"
                            : "queryPlanner";
        }
        if (value.isString()
                && Set.of("queryPlanner", "executionStats", "allPlansExecution")
                        .contains(value.asString()
                                .getValue()))
        {
            return value.asString()
                    .getValue();
        }
        throw error("explain() takes \"queryPlanner\", \"executionStats\" or \"allPlansExecution\"", call);
    }

    /** {@code .name(args)} calls following the current position. */
    private List<Call> chain()
    {
        List<Call> calls = new ArrayList<>();
        while (true)
        {
            int before = pos;
            skipSpace();
            if (peek() != '.')
            {
                pos = before;
                return calls;
            }
            pos++;
            int nameAt = skipSpace();
            String name = identifier();
            skipSpace();
            if (peek() != '(')
            {
                throw error("Expected '(' after ." + name + ". " + NOT_JAVASCRIPT, nameAt);
            }
            calls.add(call(name, nameAt));
        }
    }

    private Statement finish(ParsedCommand command, List<Call> unexpected)
    {
        for (Call call : unexpected)
        {
            if (!NO_OPS.contains(call.name()))
            {
                throw error("." + call.name() + "() cannot follow " + firstKey(command.command()) + ". " + NOT_JAVASCRIPT, call);
            }
        }
        // Only blanks (and comments) may follow on the statement's line, then an optional ';'
        int end = pos;
        while (end < source.length()
                && (source.charAt(end) == ' '
                        || source.charAt(end) == '\t'))
        {
            end++;
        }
        if (end < source.length()
                && source.charAt(end) == ';')
        {
            end++;
        }
        else if (end < source.length()
                && !Character.isWhitespace(source.charAt(end))
                && !SourceScanner.isCommentStart(source, end)
                && source.charAt(end) != ',')
        {
            throw new QueryValidationException("Unexpected '" + source.charAt(end) + "' after the statement. " + NOT_JAVASCRIPT, lines.line(end), lines.column(end));
        }
        return new Statement(command, end);
    }

    /** Reads {@code (args)} at the current position. */
    private Call call(String name, int nameAt)
    {
        int open = pos;
        int depth = 0;
        int i = open;
        while (i < source.length())
        {
            int next = SourceScanner.skipNonCode(source, i, lines);
            if (next > i)
            {
                i = next;
                continue;
            }
            char c = source.charAt(i);
            if (c == '('
                    || c == '['
                    || c == '{')
            {
                depth++;
            }
            else if (c == ')'
                    || c == ']'
                    || c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    if (c != ')')
                    {
                        break;
                    }
                    pos = i + 1;
                    return new Call(name, arguments(source.substring(open + 1, i), name, nameAt), lines.line(nameAt), lines.column(nameAt));
                }
            }
            i++;
        }
        throw error(name + "( is not closed. Check that every '(', '{' and '[' has a matching ')', '}' or ']'", nameAt);
    }

    private BsonArray arguments(String text, String name, int nameAt)
    {
        if (text.isBlank())
        {
            return new BsonArray();
        }
        if (text.contains("=>")
                || text.matches("(?s).*\\bfunction\\s*\\(.*"))
        {
            throw error(name + "() is given a function. " + NOT_JAVASCRIPT, nameAt);
        }
        try
        {
            return BsonDocument.parse("{\"args\": [" + SourceScanner.forBsonReader(text, new LineIndex(text)) + "\n]}")
                    .getArray("args");
        }
        catch (JsonParseException | BsonInvalidOperationException e)
        {
            throw error("Invalid arguments to " + name + "(): " + e.getMessage(), nameAt);
        }
    }

    private BsonDocument documentArg(Call call, int index, String what)
    {
        BsonValue value = argument(call, index);
        if (value == null)
        {
            return null;
        }
        if (!value.isDocument())
        {
            throw error(call.name() + "() expects " + what + " as a document " + ordinal(index), call);
        }
        return value.asDocument();
    }

    private String stringArg(Call call, int index, String what)
    {
        BsonValue value = argument(call, index);
        if (value == null
                || !value.isString()
                || value.asString()
                        .getValue()
                        .isBlank())
        {
            throw error(call.name() + "() expects " + what + " as a string " + ordinal(index), call);
        }
        return value.asString()
                .getValue();
    }

    private BsonValue numberArg(Call call, int index, String what)
    {
        BsonValue value = argument(call, index);
        if (value == null
                || !value.isNumber())
        {
            throw error(call.name() + "() expects " + what + " as a number " + ordinal(index), call);
        }
        return value;
    }

    /** The argument at {@code index}; {@code null} when missing, null or undefined (mongosh treats those as not given). */
    private static BsonValue argument(Call call, int index)
    {
        if (index >= call.args()
                .size())
        {
            return null;
        }
        BsonValue value = call.args()
                .get(index);
        return value.isNull()
                || value.getBsonType() == org.bson.BsonType.UNDEFINED ? null
                        : value;
    }

    private static String ordinal(int index)
    {
        return switch (index)
        {
            case 0 -> "(first argument)";
            case 1 -> "(second argument)";
            case 2 -> "(third argument)";
            default -> "(argument " + (index + 1) + ")";
        };
    }

    private static void putIfPresent(BsonDocument command, String key, BsonValue value)
    {
        if (value != null)
        {
            command.put(key, value);
        }
    }

    private static void merge(BsonDocument command, BsonDocument options)
    {
        if (options != null)
        {
            options.forEach(command::put);
        }
    }

    private static String firstKey(BsonDocument command)
    {
        return command.isEmpty() ? "the statement"
                : command.getFirstKey() + "()";
    }

    private void expect(char c)
    {
        skipSpace();
        if (peek() != c)
        {
            throw error("Expected '" + c + "'" + (pos < source.length() ? " but found '" + source.charAt(pos) + "'"
                    : " at the end"), pos);
        }
        pos++;
    }

    /** Skips whitespace and comments; returns the new position. */
    private int skipSpace()
    {
        while (pos < source.length())
        {
            char c = source.charAt(pos);
            if (Character.isWhitespace(c))
            {
                pos++;
            }
            else if (SourceScanner.isCommentStart(source, pos))
            {
                pos = SourceScanner.skipNonCode(source, pos, lines);
            }
            else
            {
                break;
            }
        }
        return pos;
    }

    private String identifier()
    {
        int start = pos;
        if (pos < source.length()
                && Character.isJavaIdentifierStart(source.charAt(pos)))
        {
            pos++;
            while (pos < source.length()
                    && Character.isJavaIdentifierPart(source.charAt(pos)))
            {
                pos++;
            }
        }
        if (pos == start)
        {
            throw error("Expected a name" + (pos < source.length() ? " but found '" + source.charAt(pos) + "'"
                    : " at the end"), pos);
        }
        return source.substring(start, pos);
    }

    private char peek()
    {
        return pos < source.length() ? source.charAt(pos)
                : '\0';
    }

    private QueryValidationException unsupported(String what, List<String> supported, Call call)
    {
        return error(what + " is not supported. Supported: " + String.join(", ", supported), call);
    }

    private QueryValidationException error(String message, Call call)
    {
        return new QueryValidationException(message, call.line(), call.column());
    }

    private QueryValidationException error(String message, int offset)
    {
        int at = Math.min(offset, Math.max(0, source.length() - 1));
        return new QueryValidationException(message, lines.line(at), lines.column(at));
    }
}
