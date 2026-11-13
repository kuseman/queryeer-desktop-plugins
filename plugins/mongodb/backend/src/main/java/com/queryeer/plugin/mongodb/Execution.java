package com.queryeer.plugin.mongodb;

import java.util.List;

import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.BsonInt64;
import org.bson.BsonString;
import org.bson.BsonValue;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoDatabase;
import com.queryeer.backend.api.LoggerService;

/**
 * State for one running query, shared between the executing thread and the thread that calls {@code cancel}.
 *
 * <p>
 * Every command sent for this execution carries {@code comment: <queryExecutionId>} (unless the user set their own comment), which is how {@link #killServerSide} finds the
 * running operation.
 * </p>
 */
final class Execution
{
    private final String id;
    private final GuardedPublisher publisher;
    private volatile boolean cancelled;
    private volatile MongoClient client;
    private volatile String cursorNamespace;
    private volatile long cursorId;

    Execution(String id, GuardedPublisher publisher)
    {
        this.id = id;
        this.publisher = publisher;
    }

    String id()
    {
        return id;
    }

    GuardedPublisher publisher()
    {
        return publisher;
    }

    boolean isCancelled()
    {
        return cancelled;
    }

    /**
     * Stops the execution from another thread: the executing thread stops at its next check, the terminal event is reported now, and the server-side work is killed in the
     * background. Used for both cancellation ({@code CANCELLED}) and the timeout watchdog ({@code TIMEOUT}).
     */
    void stop(String errorCode, String message, LoggerService logger)
    {
        cancelled = true;
        publisher.failed(errorCode, message);
        Thread.ofVirtual()
                .name("mongodb-stop-" + id)
                .start(() -> killServerSide(logger));
    }

    void useClient(MongoClient client)
    {
        this.client = client;
    }

    void openCursor(String namespace, long id)
    {
        this.cursorNamespace = namespace;
        this.cursorId = id;
    }

    void closeCursor()
    {
        this.cursorId = 0;
        this.cursorNamespace = null;
    }

    /** Best effort: close the open cursor and kill the server operation tagged with this execution's ID. Never throws. */
    void killServerSide(LoggerService logger)
    {
        MongoClient currentClient = client;
        if (currentClient == null)
        {
            return;
        }

        long openCursor = cursorId;
        String namespace = cursorNamespace;
        if (openCursor != 0
                && namespace != null)
        {
            killCursor(currentClient, namespace, openCursor, logger);
        }

        try
        {
            MongoDatabase admin = currentClient.getDatabase("admin");
            List<BsonDocument> pipeline = List.of(new BsonDocument("$currentOp", new BsonDocument()), new BsonDocument("$match", new BsonDocument("command.comment", new BsonString(
                    id))));
            for (BsonDocument op : admin.aggregate(pipeline, BsonDocument.class))
            {
                BsonValue opId = op.get("opid");
                if (opId != null)
                {
                    admin.runCommand(new BsonDocument("killOp", new BsonInt32(1)).append("op", opId));
                }
            }
        }
        catch (RuntimeException e)
        {
            logger.info("MongoDB: could not kill server operation for cancelled query " + id + " (" + e.getMessage() + "). It will stop when the server finishes it.");
        }
    }

    static void killCursor(MongoClient client, String namespace, long cursorId, LoggerService logger)
    {
        int dot = namespace.indexOf('.');
        if (dot <= 0)
        {
            return;
        }
        try
        {
            client.getDatabase(namespace.substring(0, dot))
                    .runCommand(new BsonDocument("killCursors", new BsonString(namespace.substring(dot + 1))).append("cursors", new BsonArray(List.of(new BsonInt64(cursorId)))));
        }
        catch (RuntimeException e)
        {
            logger.info("MongoDB: could not close cursor " + cursorId + " on " + namespace + " (" + e.getMessage() + ")");
        }
    }
}
