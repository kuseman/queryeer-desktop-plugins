package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CommandPolicyTest
{
    private final CommandParser parser = new CommandParser();
    private final CommandPolicy policy = new CommandPolicy();

    @ParameterizedTest
    @ValueSource(strings = { "{ \"find\": \"orders\" }", "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$match\": {} } ], \"cursor\": {} }", "{ \"count\": \"orders\" }",
            "{ \"distinct\": \"orders\", \"key\": \"status\" }", "{ \"listDatabases\": 1 }", "{ \"listCollections\": 1 }", "{ \"listIndexes\": \"orders\" }", "{ \"dbStats\": 1 }",
            "{ \"collStats\": \"orders\" }", "{ \"explain\": { \"find\": \"orders\" } }", "{ \"ping\": 1 }", "{ \"buildInfo\": 1 }" })
    void allowsReadCommands(String text)
    {
        assertDoesNotThrow(() -> policy.validate(parser.parse(text)
                .get(0)));
    }

    @ParameterizedTest
    @ValueSource(strings = { "{ \"insert\": \"orders\", \"documents\": [ {} ] }", "{ \"update\": \"orders\", \"updates\": [] }", "{ \"delete\": \"orders\", \"deletes\": [] }",
            "{ \"drop\": \"orders\" }", "{ \"dropDatabase\": 1 }", "{ \"findAndModify\": \"orders\" }", "{ \"createIndexes\": \"orders\" }", "{ \"shutdown\": 1 }",
            "{ \"Find\": \"orders\" }" })
    void rejectsOtherCommands(String text)
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> policy.validate(parser.parse(text)
                .get(0)));
        assertTrue(e.getMessage()
                .contains("not allowed"));
    }

    @ParameterizedTest
    @ValueSource(strings = { "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$out\": \"copy\" } ], \"cursor\": {} }",
            "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$merge\": { \"into\": \"copy\" } } ], \"cursor\": {} }",
            "{ \"aggregate\": \"orders\", \"pipeline\": [ { \"$facet\": { \"a\": [ { \"$out\": \"copy\" } ] } } ], \"cursor\": {} }",
            "{ \"explain\": { \"aggregate\": \"orders\", \"pipeline\": [ { \"$out\": \"copy\" } ], \"cursor\": {} } }" })
    void rejectsWriteStagesAnywhere(String text)
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> policy.validate(parser.parse(text)
                .get(0)));
        assertTrue(e.getMessage()
                .contains("writes data"));
    }

    @Test
    void rejectsExplainOfDisallowedOrMissingCommand()
    {
        assertThrows(QueryValidationException.class, () -> policy.validate(parser.parse("{ \"explain\": { \"delete\": \"orders\", \"deletes\": [] } }")
                .get(0)));
        assertThrows(QueryValidationException.class, () -> policy.validate(parser.parse("{ \"explain\": 1 }")
                .get(0)));
        assertThrows(QueryValidationException.class, () -> policy.validate(parser.parse("{ \"explain\": { \"explain\": { \"find\": \"orders\" } } }")
                .get(0)));
    }
}
