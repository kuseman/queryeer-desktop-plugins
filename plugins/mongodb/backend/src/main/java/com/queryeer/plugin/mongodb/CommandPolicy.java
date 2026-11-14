package com.queryeer.plugin.mongodb;

import java.util.Set;

import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonValue;

/** Read-only allowlist for v1. Anything not listed here is rejected before it reaches the server. */
final class CommandPolicy
{
    static final Set<String> ALLOWED_COMMANDS = Set.of("find", "aggregate", "count", "distinct", "listDatabases", "listCollections", "listIndexes", "dbStats", "collStats", "explain",
            "ping", "buildInfo");

    private static final Set<String> WRITE_STAGES = Set.of("$out", "$merge");

    void validate(ParsedCommand command)
    {
        String name = command.name();
        if (!ALLOWED_COMMANDS.contains(name))
        {
            throw new QueryValidationException("Command \"" + name + "\" is not allowed. This plugin is read-only; allowed commands are: " + String.join(", ", ALLOWED_COMMANDS.stream()
                    .sorted()
                    .toList()), command.line(), command.column());
        }

        if ("explain".equals(name))
        {
            BsonValue inner = command.command()
                    .get("explain");
            if (inner == null
                    || !inner.isDocument()
                    || inner.asDocument()
                            .isEmpty())
            {
                throw new QueryValidationException("\"explain\" must contain the command document to explain", command.line(), command.column());
            }
            String innerName = inner.asDocument()
                    .getFirstKey();
            if ("explain".equals(innerName)
                    || !ALLOWED_COMMANDS.contains(innerName))
            {
                throw new QueryValidationException("Command \"" + innerName + "\" cannot be explained. Only allowed read commands can be explained", command.line(), command.column());
            }
        }

        String writeStage = findWriteStage(command.command());
        if (writeStage != null)
        {
            throw new QueryValidationException("Aggregation stage \"" + writeStage + "\" writes data and is not allowed. This plugin is read-only", command.line(), command.column());
        }
    }

    /** Searches the whole command, including nested pipelines ($facet, $lookup, $unionWith, explain), for a write stage. */
    private static String findWriteStage(BsonValue value)
    {
        if (value.isDocument())
        {
            BsonDocument document = value.asDocument();
            for (String key : document.keySet())
            {
                if (WRITE_STAGES.contains(key))
                {
                    return key;
                }
                String nested = findWriteStage(document.get(key));
                if (nested != null)
                {
                    return nested;
                }
            }
        }
        else if (value.isArray())
        {
            BsonArray array = value.asArray();
            for (BsonValue item : array)
            {
                String nested = findWriteStage(item);
                if (nested != null)
                {
                    return nested;
                }
            }
        }
        return null;
    }
}
