package com.queryeer.plugin.mongodb;

import java.util.LinkedHashMap;
import java.util.Map;

/** A user error in the query text or its context. Reported as {@code VALIDATION}, optionally with an editor position. */
final class QueryValidationException extends RuntimeException
{
    private final int line;
    private final int column;

    QueryValidationException(String message)
    {
        this(message, -1, -1);
    }

    QueryValidationException(String message, int line, int column)
    {
        super(message);
        this.line = line;
        this.column = column;
    }

    /** 1-based line, or -1 when the error has no position. */
    int line()
    {
        return line;
    }

    /** 1-based column, or -1 when the error has no position. */
    int column()
    {
        return column;
    }

    Map<String, Object> details()
    {
        Map<String, Object> details = new LinkedHashMap<>();
        if (line > 0)
        {
            details.put("line", line);
            details.put("column", column);
        }
        return details;
    }
}
