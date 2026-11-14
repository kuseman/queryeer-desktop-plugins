package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;

import org.bson.BsonDocument;
import org.bson.BsonInvalidOperationException;
import org.bson.BsonValue;
import org.bson.json.JsonParseException;

import com.queryeer.plugin.mongodb.SourceScanner.LineIndex;

/**
 * Parses query text into MongoDB command documents. Each statement is recognised by how it starts:
 *
 * <ul>
 * <li>{@code {}: a command document in Extended JSON, relaxed or canonical. Shell helpers such as {@code ObjectId("...")}, unquoted keys, single
 * quotes and trailing commas are accepted.</li>
 * <li>{@code db.}: a mongosh-style statement such as {@code db.orders.find({...}).sort({...})}, translated to the same command documents by
 * {@link ShellParser}.</li>
 * </ul>
 *
 * <p>
 * Statements may be separated by whitespace, commas or semicolons, JSON documents may be wrapped in one array, and {@code //} and
 * {@code /* *}{@code /} comments may appear anywhere outside strings.
 * </p>
 *
 * <p>
 * This is the "parse" stage of the parse/execute split: both forms give the same {@link ParsedCommand}s, so execution never knows which was written.
 * </p>
 */
final class CommandParser
{
    static final String DB_KEY = "$db";

    private final ShellParser shell = new ShellParser();

    List<ParsedCommand> parse(String text)
    {
        String source = text == null ? ""
                : text;
        LineIndex lines = new LineIndex(source);
        List<ParsedCommand> commands = new ArrayList<>();

        int i = 0;
        int length = source.length();
        while (i < length)
        {
            char c = source.charAt(i);
            if (Character.isWhitespace(c)
                    || c == ','
                    || c == ';'
                    || c == '['
                    || c == ']')
            {
                i++;
            }
            else if (SourceScanner.isCommentStart(source, i))
            {
                i = SourceScanner.skipNonCode(source, i, lines);
            }
            else if (c == '{')
            {
                int end = findDocumentEnd(source, i, lines);
                commands.add(toCommand(source.substring(i, end + 1), lines.line(i), lines.column(i)));
                i = end + 1;
            }
            else if (ShellParser.startsStatement(source, i))
            {
                ShellParser.Statement statement = shell.parse(source, i, lines);
                commands.add(statement.command());
                i = statement.end();
            }
            else
            {
                throw new QueryValidationException("Expected a command document ({ \"find\": \"orders\" }) or a shell statement (db.orders.find()) but found '" + c + "'",
                        lines.line(i), lines.column(i));
            }
        }

        if (commands.isEmpty())
        {
            throw new QueryValidationException("No command to execute. Write a command document such as { \"find\": \"orders\", \"filter\": {} }, or a shell statement such as db.orders.find({})");
        }
        return commands;
    }

    private static ParsedCommand toCommand(String json, int line, int column)
    {
        BsonDocument document;
        try
        {
            document = BsonDocument.parse(SourceScanner.forBsonReader(json, new LineIndex(json)));
        }
        catch (JsonParseException | BsonInvalidOperationException e)
        {
            throw new QueryValidationException("Invalid command document: " + e.getMessage(), line, column);
        }

        if (document.isEmpty())
        {
            throw new QueryValidationException("Command document is empty", line, column);
        }

        String database = null;
        BsonValue db = document.remove(DB_KEY);
        if (db != null)
        {
            if (!db.isString()
                    || db.asString()
                            .getValue()
                            .isBlank())
            {
                throw new QueryValidationException("\"$db\" must be a non-empty string", line, column);
            }
            database = db.asString()
                    .getValue()
                    .trim();
            if (document.isEmpty())
            {
                throw new QueryValidationException("Command document contains only \"$db\"", line, column);
            }
        }
        return new ParsedCommand(database, document, line, column);
    }

    /** Returns the index of the '}' closing the document that starts at {@code start}. */
    private static int findDocumentEnd(String source, int start, LineIndex lines)
    {
        int depth = 0;
        int i = start;
        int length = source.length();
        while (i < length)
        {
            int next = SourceScanner.skipNonCode(source, i, lines);
            if (next > i)
            {
                i = next;
                continue;
            }
            char c = source.charAt(i);
            if (c == '{'
                    || c == '[')
            {
                depth++;
            }
            else if (c == '}'
                    || c == ']')
            {
                depth--;
                if (depth == 0)
                {
                    if (c != '}')
                    {
                        break;
                    }
                    return i;
                }
            }
            i++;
        }
        throw new QueryValidationException("Command document is not closed. Check that every '{' and '[' has a matching '}' or ']'", lines.line(start), lines.column(start));
    }
}
