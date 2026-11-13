package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonInt64;
import org.bson.BsonString;
import org.bson.BsonValue;

import com.mongodb.MongoOperationTimeoutException;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoDatabase;
import com.queryeer.backend.api.LoggerService;

/**
 * The "execute" stage: runs one {@link ParsedCommand} and publishes its reply as one result set.
 *
 * <ul>
 * <li>Cursor replies ({@code find}, {@code aggregate}, {@code listCollections}, {@code listIndexes}): one row per document, followed with {@code getMore} until the cursor is
 * exhausted or the query is cancelled.</li>
 * <li>{@code distinct}: one row per value in a {@code value} column.</li>
 * <li>{@code listDatabases}: one row per database.</li>
 * <li>Anything else: the reply document as a single row.</li>
 * </ul>
 */
final class CommandRunner
{
    /** Reply fields that carry no information for the user: {@code ok} is always 1 on success, the others are replica-set bookkeeping. */
    private static final List<String> REPLY_NOISE = List.of("ok", "$clusterTime", "operationTime");

    private final LoggerService logger;

    CommandRunner(LoggerService logger)
    {
        this.logger = logger;
    }

    /** Wall-clock budget for the whole execution, from the host's {@code timeoutMs}. */
    record Deadline(long endNanos)
    {
        static Deadline none()
        {
            return new Deadline(Long.MAX_VALUE);
        }

        static Deadline in(Integer timeoutMs)
        {
            return timeoutMs == null
                    || timeoutMs <= 0 ? none()
                            : new Deadline(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs));
        }

        boolean isSet()
        {
            return endNanos != Long.MAX_VALUE;
        }

        long remainingMs()
        {
            return Math.max(0, TimeUnit.NANOSECONDS.toMillis(endNanos - System.nanoTime()));
        }
    }

    /** Runs the command and returns the number of rows published. */
    long run(Execution execution, MongoClient client, String database, ParsedCommand parsed, ResultSetWriter writer, Deadline deadline)
    {
        BsonDocument command = parsed.command()
                .clone();
        if (!command.containsKey("comment"))
        {
            command.append("comment", new BsonString(execution.id()));
        }

        BsonDocument reply = runCommand(execution, client.getDatabase(database), command, deadline, true);
        if (reply == null)
        {
            return 0;
        }

        BsonValue cursor = reply.get("cursor");
        if (cursor != null
                && cursor.isDocument())
        {
            return publishCursor(execution, client, cursor.asDocument(), writer, deadline);
        }

        List<BsonDocument> rows;
        String name = parsed.name();
        if ("distinct".equals(name))
        {
            rows = new ArrayList<>();
            for (BsonValue value : reply.getArray("values", new BsonArray()))
            {
                rows.add(new BsonDocument("value", value));
            }
        }
        else if ("listDatabases".equals(name))
        {
            rows = documents(reply.getArray("databases", new BsonArray()));
        }
        else
        {
            BsonDocument row = reply.clone();
            REPLY_NOISE.forEach(row::remove);
            rows = List.of(row);
        }

        writer.start(rows, false);
        writer.write(rows);
        return writer.rowCount();
    }

    private long publishCursor(Execution execution, MongoClient client, BsonDocument cursor, ResultSetWriter writer, Deadline deadline)
    {
        String namespace = cursor.getString("ns")
                .getValue();
        long cursorId = cursor.get("id")
                .asNumber()
                .longValue();
        List<BsonDocument> batch = documents(cursor.getArray("firstBatch", new BsonArray()));

        execution.openCursor(namespace, cursorId);
        try
        {
            // Columns come from the first non-empty batch
            while (batch.isEmpty()
                    && cursorId != 0)
            {
                BsonDocument next = getMore(execution, client, namespace, cursorId, deadline);
                if (next == null)
                {
                    return writer.rowCount();
                }
                cursorId = next.get("id")
                        .asNumber()
                        .longValue();
                batch = documents(next.getArray("nextBatch", new BsonArray()));
            }

            writer.start(batch, cursorId != 0);
            writer.write(batch);

            while (cursorId != 0)
            {
                BsonDocument next = getMore(execution, client, namespace, cursorId, deadline);
                if (next == null)
                {
                    return writer.rowCount();
                }
                cursorId = next.get("id")
                        .asNumber()
                        .longValue();
                writer.write(documents(next.getArray("nextBatch", new BsonArray())));
            }
            return writer.rowCount();
        }
        finally
        {
            if (cursorId != 0)
            {
                Execution.killCursor(client, namespace, cursorId, logger);
            }
            execution.closeCursor();
        }
    }

    /** Returns the {@code cursor} document of the getMore reply, or {@code null} when the execution was cancelled. */
    private BsonDocument getMore(Execution execution, MongoClient client, String namespace, long cursorId, Deadline deadline)
    {
        int dot = namespace.indexOf('.');
        // The comment lets cancellation and the timeout watchdog find a running getMore with killOp (MongoDB 4.4+)
        BsonDocument command = new BsonDocument("getMore", new BsonInt64(cursorId)).append("collection", new BsonString(namespace.substring(dot + 1)))
                .append("comment", new BsonString(execution.id()));
        // The server rejects maxTimeMS on getMore for regular cursors, so getMore never gets the driver timeout. A getMore that is still running
        // at the deadline is stopped by the provider's timeout watchdog instead.
        BsonDocument reply = runCommand(execution, client.getDatabase(namespace.substring(0, dot)), command, deadline, false);
        return reply == null ? null
                : reply.getDocument("cursor");
    }

    /**
     * Returns the reply, or {@code null} when the execution was cancelled before or during the call.
     *
     * @param applyDriverTimeout whether to apply the remaining time as the driver's client-side operation timeout (which sends maxTimeMS)
     */
    private static BsonDocument runCommand(Execution execution, MongoDatabase database, BsonDocument command, Deadline deadline, boolean applyDriverTimeout)
    {
        if (execution.isCancelled())
        {
            return null;
        }
        MongoDatabase target = database;
        if (deadline.isSet())
        {
            long remaining = deadline.remainingMs();
            if (remaining <= 0)
            {
                throw new MongoOperationTimeoutException("Query timed out");
            }
            if (applyDriverTimeout)
            {
                target = database.withTimeout(remaining, TimeUnit.MILLISECONDS);
            }
        }
        BsonDocument reply = target.runCommand(command, BsonDocument.class);
        return execution.isCancelled() ? null
                : reply;
    }

    private static List<BsonDocument> documents(BsonArray array)
    {
        List<BsonDocument> result = new ArrayList<>(array.size());
        for (BsonValue value : array)
        {
            result.add(value.isDocument() ? value.asDocument()
                    : new BsonDocument("value", value));
        }
        return result;
    }
}
