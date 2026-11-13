package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

class CommandParserTest
{
    private final CommandParser parser = new CommandParser();

    @Test
    void parsesSingleCommand()
    {
        List<ParsedCommand> commands = parser.parse("{ \"find\": \"orders\", \"filter\": { \"status\": \"open\" } }");

        assertEquals(1, commands.size());
        assertEquals("find", commands.get(0)
                .name());
        assertNull(commands.get(0)
                .database());
        assertEquals(1, commands.get(0)
                .line());
        assertEquals(1, commands.get(0)
                .column());
    }

    @Test
    void parsesSeveralCommandsWithCommentsCommasAndArrayWrapper()
    {
        String text = """
                // first
                [
                  { "count": "orders" },
                  /* second */ { "distinct": "orders", "key": "status" }
                ]
                { "ping": 1 }
                """;

        List<ParsedCommand> commands = parser.parse(text);

        assertEquals(List.of("count", "distinct", "ping"), commands.stream()
                .map(ParsedCommand::name)
                .toList());
        assertEquals(3, commands.get(0)
                .line());
        assertEquals(3, commands.get(0)
                .column());
        assertEquals(4, commands.get(1)
                .line());
    }

    @Test
    void extractsDbKey()
    {
        ParsedCommand command = parser.parse("{ \"find\": \"orders\", \"$db\": \"shop\" }")
                .get(0);

        assertEquals("shop", command.database());
        assertTrue(!command.command()
                .containsKey("$db"));
        assertEquals("find", command.name());
    }

    @Test
    void acceptsShellHelpersAndExtendedJson()
    {
        ParsedCommand command = parser.parse("{ \"find\": \"orders\", \"filter\": { \"_id\": ObjectId(\"65a000000000000000000001\"), \"at\": { \"$date\": \"2024-01-01T00:00:00Z\" } } }")
                .get(0);

        assertTrue(command.command()
                .getDocument("filter")
                .get("_id")
                .isObjectId());
        assertTrue(command.command()
                .getDocument("filter")
                .get("at")
                .isDateTime());
    }

    @Test
    void bracesInsideStringsDoNotEndTheDocument()
    {
        ParsedCommand command = parser.parse("{ \"find\": \"orders\", \"filter\": { \"note\": \"has } and { and \\\" quote\" } }")
                .get(0);

        assertEquals("has } and { and \" quote", command.command()
                .getDocument("filter")
                .getString("note")
                .getValue());
    }

    @Test
    void reportsPositionOfInvalidDocument()
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> parser.parse("{ \"ping\": 1 }\n\n  { \"find\": orders }"));

        assertEquals(3, e.line());
        assertEquals(3, e.column());
        assertTrue(e.getMessage()
                .startsWith("Invalid command document"));
    }

    @Test
    void reportsUnclosedDocument()
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> parser.parse("\n{ \"find\": \"orders\""));

        assertEquals(2, e.line());
        assertEquals(1, e.column());
    }

    @Test
    void rejectsTextOutsideDocuments()
    {
        QueryValidationException e = assertThrows(QueryValidationException.class, () -> parser.parse("db.orders.find({})"));

        assertEquals(1, e.line());
        assertEquals(1, e.column());
    }

    @Test
    void rejectsEmptyTextAndBadDb()
    {
        assertThrows(QueryValidationException.class, () -> parser.parse("  // nothing\n"));
        assertThrows(QueryValidationException.class, () -> parser.parse("{ \"find\": \"orders\", \"$db\": 1 }"));
        assertThrows(QueryValidationException.class, () -> parser.parse("{ \"$db\": \"shop\" }"));
        assertThrows(QueryValidationException.class, () -> parser.parse("{ }"));
    }
}
