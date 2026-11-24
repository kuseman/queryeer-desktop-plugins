package com.queryeer.plugin.jdbc.postgres;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.postgresql.util.PSQLException;
import org.postgresql.util.ServerErrorMessage;

import com.queryeer.backend.queryengine.jdbc.execute.AbstractJdbcQueryExecutor.JdbcQueryExecutionException;

class PostgresDialectErrorDetailsTest
{
    private static PSQLException undefinedTable()
    {
        return new PSQLException(new ServerErrorMessage("SERROR\0C42P01\0Mrelation \"nosuch\" does not exist\0P15\0"));
    }

    @Test
    void aQueryErrorKeepsItsPosition()
    {
        PSQLException error = undefinedTable();

        Map<String, Object> details = new PostgresDialect().extractErrorDetails(new JdbcQueryExecutionException(error.getMessage(), error));

        assertEquals(15, details.get("position"));
        assertEquals("42P01", details.get("sqlState"));
    }

    @Test
    void aPlanRunErrorLeavesOutItsPositionWhichCountsFromTheExplainStatement()
    {
        PSQLException error = undefinedTable();
        PostgresQueryExecutor.PlanStatementException planError = new PostgresQueryExecutor.PlanStatementException(error);

        Map<String, Object> details = new PostgresDialect().extractErrorDetails(new JdbcQueryExecutionException(planError.getMessage(), planError));

        assertFalse(details.containsKey("position"));
        assertEquals("42P01", details.get("sqlState"));
        assertEquals("42P01", planError.getSQLState());
    }
}
