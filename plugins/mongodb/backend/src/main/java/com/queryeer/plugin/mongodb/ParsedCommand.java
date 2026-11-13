package com.queryeer.plugin.mongodb;

import org.bson.BsonDocument;

/**
 * One command document parsed from the query text.
 *
 * @param database database from the document's {@code $db} key, or {@code null} when not given
 * @param command the command document, without {@code $db}
 * @param line 1-based line where the document starts
 * @param column 1-based column where the document starts
 */
record ParsedCommand(String database, BsonDocument command, int line, int column)
{
    /** The command name, which MongoDB defines as the first key of the command document. */
    String name()
    {
        return command.isEmpty() ? ""
                : command.getFirstKey();
    }
}
