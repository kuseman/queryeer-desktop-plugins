package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;

import org.bson.BsonDocument;
import org.bson.BsonInvalidOperationException;
import org.bson.BsonValue;
import org.bson.json.JsonParseException;

/**
 * Parses query text into MongoDB command documents (Extended JSON, relaxed or canonical; shell helpers such as {@code ObjectId("...")} are accepted by the BSON parser).
 *
 * <p>
 * The text may contain several top-level documents. They may be separated by whitespace or commas, may be wrapped in one JSON array, and may be surrounded by {@code //} and
 * {@code /* *}{@code /} comments. Comments inside a document are not supported.
 * </p>
 *
 * <p>
 * This is the "parse" stage of the parse/execute split. A future shell-syntax parser ({@code db.orders.find(...)}) produces the same {@link ParsedCommand}s.
 * </p>
 */
final class CommandParser
{
    static final String DB_KEY = "$db";

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
                    || c == '['
                    || c == ']')
            {
                i++;
            }
            else if (c == '/'
                    && i + 1 < length
                    && source.charAt(i + 1) == '/')
            {
                i = skipLineComment(source, i);
            }
            else if (c == '/'
                    && i + 1 < length
                    && source.charAt(i + 1) == '*')
            {
                i = skipBlockComment(source, i, lines);
            }
            else if (c == '{')
            {
                int end = findDocumentEnd(source, i, lines);
                commands.add(toCommand(source.substring(i, end + 1), lines.line(i), lines.column(i)));
                i = end + 1;
            }
            else
            {
                throw new QueryValidationException("Expected '{' to start a command document but found '" + c + "'", lines.line(i), lines.column(i));
            }
        }

        if (commands.isEmpty())
        {
            throw new QueryValidationException("No command to execute. Write a command document such as { \"find\": \"orders\", \"filter\": {} }");
        }
        return commands;
    }

    private static ParsedCommand toCommand(String json, int line, int column)
    {
        BsonDocument document;
        try
        {
            document = BsonDocument.parse(json);
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
            char c = source.charAt(i);
            if (c == '"'
                    || c == '\'')
            {
                i = skipString(source, i, lines);
                continue;
            }
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

    /** Returns the index after the closing quote of the string starting at {@code start}. */
    private static int skipString(String source, int start, LineIndex lines)
    {
        char quote = source.charAt(start);
        int i = start + 1;
        int length = source.length();
        while (i < length)
        {
            char c = source.charAt(i);
            if (c == '\\')
            {
                i += 2;
                continue;
            }
            if (c == quote)
            {
                return i + 1;
            }
            i++;
        }
        throw new QueryValidationException("String is not closed", lines.line(start), lines.column(start));
    }

    private static int skipLineComment(String source, int start)
    {
        int newline = source.indexOf('\n', start);
        return newline < 0 ? source.length()
                : newline + 1;
    }

    private static int skipBlockComment(String source, int start, LineIndex lines)
    {
        int end = source.indexOf("*/", start + 2);
        if (end < 0)
        {
            throw new QueryValidationException("Comment is not closed", lines.line(start), lines.column(start));
        }
        return end + 2;
    }

    /** Maps character offsets to 1-based line and column numbers. */
    private static final class LineIndex
    {
        private final int[] lineStarts;

        LineIndex(String source)
        {
            List<Integer> starts = new ArrayList<>();
            starts.add(0);
            for (int i = 0; i < source.length(); i++)
            {
                if (source.charAt(i) == '\n')
                {
                    starts.add(i + 1);
                }
            }
            lineStarts = starts.stream()
                    .mapToInt(Integer::intValue)
                    .toArray();
        }

        int line(int offset)
        {
            return lineIndex(offset) + 1;
        }

        int column(int offset)
        {
            return offset - lineStarts[lineIndex(offset)] + 1;
        }

        private int lineIndex(int offset)
        {
            int low = 0;
            int high = lineStarts.length - 1;
            while (low < high)
            {
                int mid = (low + high + 1) >>> 1;
                if (lineStarts[mid] <= offset)
                {
                    low = mid;
                }
                else
                {
                    high = mid - 1;
                }
            }
            return low;
        }
    }
}
