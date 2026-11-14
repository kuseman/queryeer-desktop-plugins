package com.queryeer.plugin.mongodb;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import com.queryeer.backend.api.OutputEvent;
import com.queryeer.backend.api.QueryPublisher;
import com.queryeer.backend.contract.query.QueryOutputArtifact;

/**
 * Lets exactly one terminal event ({@code completed} or {@code failed}) through and drops everything after it.
 *
 * <p>
 * Cancellation reports {@code CANCELLED} from the cancelling thread immediately, while the executing thread may still be finishing a server call. Whatever that thread
 * publishes afterwards is dropped here.
 * </p>
 */
final class GuardedPublisher implements QueryPublisher
{
    private final QueryPublisher delegate;
    private final AtomicBoolean terminated = new AtomicBoolean();

    GuardedPublisher(QueryPublisher delegate)
    {
        this.delegate = delegate;
    }

    boolean isTerminated()
    {
        return terminated.get();
    }

    @Override
    public void progress(int percent, String message)
    {
        if (!terminated.get())
        {
            delegate.progress(percent, message);
        }
    }

    @Override
    public void resultSetStart(List<String> columnNames, List<String> columnTypes)
    {
        if (!terminated.get())
        {
            delegate.resultSetStart(columnNames, columnTypes);
        }
    }

    @Override
    public void resultSetStart(List<String> columnNames, List<String> columnTypes, Map<String, String> metadata)
    {
        if (!terminated.get())
        {
            delegate.resultSetStart(columnNames, columnTypes, metadata);
        }
    }

    @Override
    public void resultSetRows(List<List<Object>> rows)
    {
        if (!terminated.get())
        {
            delegate.resultSetRows(rows);
        }
    }

    @Override
    public void resultSetRows(List<List<Object>> rows, List<OutputEvent> messages)
    {
        if (!terminated.get())
        {
            delegate.resultSetRows(rows, messages);
        }
    }

    @Override
    public void completed(long durationMs, long rowCount)
    {
        if (terminated.compareAndSet(false, true))
        {
            delegate.completed(durationMs, rowCount);
        }
    }

    @Override
    public void completed(long durationMs, long rowCount, Object engineState)
    {
        if (terminated.compareAndSet(false, true))
        {
            delegate.completed(durationMs, rowCount, engineState);
        }
    }

    @Override
    public void completed(long durationMs, long rowCount, List<String> features, List<QueryOutputArtifact> artifacts, Object engineState)
    {
        if (terminated.compareAndSet(false, true))
        {
            delegate.completed(durationMs, rowCount, features, artifacts, engineState);
        }
    }

    @Override
    public void failed(String errorCode, String errorMessage)
    {
        if (terminated.compareAndSet(false, true))
        {
            delegate.failed(errorCode, errorMessage);
        }
    }

    @Override
    public void failed(String errorCode, String errorMessage, Map<String, Object> details)
    {
        if (terminated.compareAndSet(false, true))
        {
            delegate.failed(errorCode, errorMessage, details);
        }
    }
}
