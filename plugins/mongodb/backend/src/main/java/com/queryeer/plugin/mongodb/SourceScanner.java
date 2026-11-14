package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lexical helpers shared by the JSON and shell parsers: query text is JavaScript-like, so strings, comments and regular expression literals
 * have to be skipped as units before brackets can be counted.
 *
 * <p>
 * A {@code /} outside a string starts a comment when followed by {@code /} or {@code *}, and a regular expression literal otherwise. Query
 * text has no division, so that is never ambiguous.
 * </p>
 */
final class SourceScanner
{
    /** {@code new Date("...")}: the BSON reader only accepts a number or a JavaScript date string there, so ISO strings go through {@code ISODate}. */
    private static final Pattern NEW_DATE_WITH_STRING = Pattern.compile("new\\s+Date\\s*\\(\\s*(?=[\"'])");

    private SourceScanner()
    {
    }

    /** Whether a comment starts at {@code i}. */
    static boolean isCommentStart(String source, int i)
    {
        return source.charAt(i) == '/'
                && i + 1 < source.length()
                && (source.charAt(i + 1) == '/'
                        || source.charAt(i + 1) == '*');
    }

    /**
     * When {@code i} starts a string, comment or regular expression literal, returns the index just after it; otherwise returns {@code i}.
     *
     * @throws QueryValidationException when it is not closed
     */
    static int skipNonCode(String source, int i, LineIndex lines)
    {
        char c = source.charAt(i);
        if (c == '"'
                || c == '\'')
        {
            return skipString(source, i, lines);
        }
        if (c != '/')
        {
            return i;
        }
        if (i + 1 < source.length()
                && source.charAt(i + 1) == '/')
        {
            int newline = source.indexOf('\n', i);
            return newline < 0 ? source.length()
                    : newline + 1;
        }
        if (i + 1 < source.length()
                && source.charAt(i + 1) == '*')
        {
            int end = source.indexOf("*/", i + 2);
            if (end < 0)
            {
                throw new QueryValidationException("Comment is not closed", lines.line(i), lines.column(i));
            }
            return end + 2;
        }
        return skipRegex(source, i, lines);
    }

    /** Returns the index after the closing quote of the string starting at {@code start}. */
    static int skipString(String source, int start, LineIndex lines)
    {
        char quote = source.charAt(start);
        int i = start + 1;
        while (i < source.length())
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
            if (c == '\n')
            {
                break;
            }
            i++;
        }
        throw new QueryValidationException("String is not closed", lines.line(start), lines.column(start));
    }

    /** Returns the index after the flags of the regular expression literal starting at {@code start}. */
    private static int skipRegex(String source, int start, LineIndex lines)
    {
        int i = start + 1;
        boolean inClass = false;
        while (i < source.length())
        {
            char c = source.charAt(i);
            if (c == '\\')
            {
                i += 2;
                continue;
            }
            if (c == '\n')
            {
                break;
            }
            if (c == '[')
            {
                inClass = true;
            }
            else if (c == ']')
            {
                inClass = false;
            }
            else if (c == '/'
                    && !inClass)
            {
                i++;
                while (i < source.length()
                        && Character.isLetter(source.charAt(i)))
                {
                    i++;
                }
                return i;
            }
            i++;
        }
        throw new QueryValidationException("Regular expression is not closed", lines.line(start), lines.column(start));
    }

    /**
     * Prepares a value for the BSON reader: comments become spaces (the reader would take {@code /* *}{@code /} for a regular expression) and
     * {@code new Date("...")} becomes {@code ISODate("...")}. Strings and regular expressions are left as they are.
     */
    static String forBsonReader(String source, LineIndex lines)
    {
        StringBuilder out = new StringBuilder(source.length());
        int i = 0;
        while (i < source.length())
        {
            int next = skipNonCode(source, i, lines);
            if (next > i)
            {
                if (isCommentStart(source, i))
                {
                    for (int k = i; k < next; k++)
                    {
                        out.append(source.charAt(k) == '\n' ? '\n'
                                : ' ');
                    }
                }
                else
                {
                    out.append(source, i, next);
                }
                i = next;
                continue;
            }
            Matcher newDate = NEW_DATE_WITH_STRING.matcher(source).region(i, source.length());
            if (newDate.lookingAt())
            {
                out.append("ISODate(");
                i = newDate.end();
                continue;
            }
            out.append(source.charAt(i));
            i++;
        }
        return out.toString();
    }

    /** Maps character offsets to 1-based line and column numbers. */
    static final class LineIndex
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
