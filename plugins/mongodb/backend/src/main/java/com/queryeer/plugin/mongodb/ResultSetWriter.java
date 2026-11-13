package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.bson.BsonDocument;
import org.bson.BsonValue;

import com.queryeer.backend.api.QueryPublisher;
import com.queryeer.backend.contract.query.ColumnTypes;

/**
 * Publishes one result set of documents.
 *
 * <p>
 * Queryeer fixes the columns when a result set starts. Columns are therefore the top-level keys of the first batch, in first-seen order. When more batches may follow, a
 * trailing {@value #EXTRA_COLUMN} column collects keys that first appear later, so no data is lost.
 * </p>
 */
final class ResultSetWriter
{
    static final String EXTRA_COLUMN = "$extra";
    private static final int ROW_CHUNK_SIZE = 500;

    private final QueryPublisher publisher;
    private final ValueMapper values;
    private List<String> columns;
    private List<String> types;
    private Set<String> columnSet;
    private boolean extraColumn;
    private long rowCount;

    ResultSetWriter(QueryPublisher publisher, ValueMapper values)
    {
        this.publisher = publisher;
        this.values = values;
    }

    void start(List<BsonDocument> firstBatch, boolean moreBatches)
    {
        Map<String, List<BsonValue>> valuesByKey = new LinkedHashMap<>();
        for (BsonDocument document : firstBatch)
        {
            for (Map.Entry<String, BsonValue> entry : document.entrySet())
            {
                valuesByKey.computeIfAbsent(entry.getKey(), k -> new ArrayList<>())
                        .add(entry.getValue());
            }
        }

        columns = new ArrayList<>(valuesByKey.keySet());
        types = new ArrayList<>();
        for (List<BsonValue> columnValues : valuesByKey.values())
        {
            types.add(ValueMapper.inferColumnType(columnValues));
        }
        columnSet = new LinkedHashSet<>(columns);

        extraColumn = moreBatches;
        List<String> names = new ArrayList<>(columns);
        List<String> columnTypes = new ArrayList<>(types);
        if (extraColumn)
        {
            names.add(EXTRA_COLUMN);
            columnTypes.add(ColumnTypes.OBJECT);
        }
        publisher.resultSetStart(names, columnTypes);
    }

    void write(List<BsonDocument> documents)
    {
        List<List<Object>> chunk = new ArrayList<>();
        for (BsonDocument document : documents)
        {
            chunk.add(row(document));
            if (chunk.size() == ROW_CHUNK_SIZE)
            {
                publisher.resultSetRows(chunk);
                chunk = new ArrayList<>();
            }
        }
        if (!chunk.isEmpty())
        {
            publisher.resultSetRows(chunk);
        }
        rowCount += documents.size();
    }

    long rowCount()
    {
        return rowCount;
    }

    private List<Object> row(BsonDocument document)
    {
        List<Object> row = new ArrayList<>(columns.size() + 1);
        for (int i = 0; i < columns.size(); i++)
        {
            row.add(values.cell(document.get(columns.get(i)), types.get(i)));
        }
        if (extraColumn)
        {
            BsonDocument extra = new BsonDocument();
            for (Map.Entry<String, BsonValue> entry : document.entrySet())
            {
                if (!columnSet.contains(entry.getKey()))
                {
                    extra.append(entry.getKey(), entry.getValue());
                }
            }
            row.add(extra.isEmpty() ? null
                    : values.jsonCell(extra));
        }
        return row;
    }
}
