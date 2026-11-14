package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import com.queryeer.backend.api.OutputEvent;
import com.queryeer.backend.api.QueryPublisher;

/** Records everything a provider publishes. Modelled on the RecordingPublisher in Queryeer's JDBC engine tests. */
final class RecordingPublisher implements QueryPublisher
{
    record ResultSet(List<String> columns, List<String> types, List<List<Object>> rows)
    {
    }

    final List<ResultSet> resultSets = new CopyOnWriteArrayList<>();
    final List<String> terminalEvents = new CopyOnWriteArrayList<>();
    final List<OutputEvent> messages = new CopyOnWriteArrayList<>();
    volatile String errorCode;
    volatile String errorMessage;
    volatile Map<String, Object> errorDetails;
    volatile long completedRowCount = -1;
    private final CountDownLatch terminal = new CountDownLatch(1);
    private volatile Consumer<List<List<Object>>> onRows = rows ->
    {
    };

    RecordingPublisher onRows(Consumer<List<List<Object>>> listener)
    {
        this.onRows = listener;
        return this;
    }

    @Override
    public void progress(int percent, String message)
    {
    }

    @Override
    public void resultSetStart(List<String> columnNames, List<String> columnTypes)
    {
        resultSets.add(new ResultSet(List.copyOf(columnNames), List.copyOf(columnTypes), new CopyOnWriteArrayList<>()));
    }

    @Override
    public void resultSetRows(List<List<Object>> rows)
    {
        resultSets.get(resultSets.size() - 1)
                .rows()
                .addAll(new ArrayList<>(rows));
        onRows.accept(rows);
    }

    @Override
    public void resultSetRows(List<List<Object>> rows, List<OutputEvent> events)
    {
        if (!rows.isEmpty())
        {
            resultSetRows(rows);
        }
        messages.addAll(events);
    }

    @Override
    public void completed(long durationMs, long rowCount)
    {
        completedRowCount = rowCount;
        terminalEvents.add("completed");
        terminal.countDown();
    }

    @Override
    public void failed(String errorCode, String errorMessage)
    {
        failed(errorCode, errorMessage, Map.of());
    }

    @Override
    public void failed(String errorCode, String errorMessage, Map<String, Object> details)
    {
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
        this.errorDetails = details;
        terminalEvents.add("failed:" + errorCode);
        terminal.countDown();
    }

    boolean awaitTerminal(long timeout, TimeUnit unit) throws InterruptedException
    {
        return terminal.await(timeout, unit);
    }

    ResultSet resultSet(int index)
    {
        return resultSets.get(index);
    }

    int totalRows()
    {
        return resultSets.stream()
                .mapToInt(r -> r.rows()
                        .size())
                .sum();
    }
}
