package com.queryeer.plugin.jdbc.sqlserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.Map;

import org.junit.jupiter.api.Test;

import com.microsoft.sqlserver.jdbc.SQLServerError;
import com.microsoft.sqlserver.jdbc.SQLServerException;
import com.queryeer.backend.queryengine.jdbc.execute.AbstractJdbcQueryExecutor.JdbcQueryExecutionException;

class SqlServerDialectErrorDetailsTest
{
    /** "Invalid column name" on line 3 of its batch. The driver's classes have no public constructors for a server error. */
    private static SQLServerException invalidColumn()
    {
        SQLServerError error = mock(SQLServerError.class);
        when(error.getLineNumber()).thenReturn(3L);
        when(error.getErrorNumber()).thenReturn(207);
        SQLServerException exception = mock(SQLServerException.class);
        when(exception.getSQLServerError()).thenReturn(error);
        when(exception.getMessage()).thenReturn("Invalid column name 'bad'.");
        return exception;
    }

    @Test
    void aQueryErrorKeepsItsLine()
    {
        SQLServerException error = invalidColumn();

        Map<String, Object> details = new SqlServerDialect().extractErrorDetails(new JdbcQueryExecutionException(error.getMessage(), error));

        assertEquals(3, details.get("line"));
        assertEquals(207, details.get("sqlErrorNumber"));
    }

    @Test
    void aPlanRunErrorLeavesOutItsLineWhichCountsFromItsBatch()
    {
        SqlServerQueryExecutor.PlanStatementException planError = new SqlServerQueryExecutor.PlanStatementException(invalidColumn());

        Map<String, Object> details = new SqlServerDialect().extractErrorDetails(new JdbcQueryExecutionException(planError.getMessage(), planError));

        assertFalse(details.containsKey("line"));
        assertEquals(207, details.get("sqlErrorNumber"));
    }
}
