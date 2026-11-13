package com.queryeer.plugin.mongodb;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

import org.bson.BsonDocument;
import org.bson.BsonType;
import org.bson.BsonValue;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;
import org.bson.types.Decimal128;

import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.contract.query.ColumnTypes;

/** Maps BSON values to Queryeer column types and result cells. */
final class ValueMapper
{
    static final JsonWriterSettings RELAXED_JSON = JsonWriterSettings.builder()
            .outputMode(JsonMode.RELAXED)
            .build();

    private static final String LARGE_TYPE_JSON = "json";
    private static final String LARGE_TYPE_TEXT = "text";
    private static final String CONTENT_TYPE_JSON = "application/json";
    private static final String CONTENT_TYPE_TEXT = "text/plain";
    private static final String WRAPPER_PREFIX = "{\"v\": ";

    private final LargeValueStore largeValues;
    private final String queryExecutionId;

    ValueMapper(LargeValueStore largeValues, String queryExecutionId)
    {
        this.largeValues = largeValues;
        this.queryExecutionId = queryExecutionId;
    }

    /** The column type for a single value, or {@code null} for BSON null/undefined (which says nothing about the column). */
    static String columnType(BsonValue value)
    {
        if (value == null)
        {
            return null;
        }
        return switch (value.getBsonType())
        {
            case NULL, UNDEFINED -> null;
            case INT32 -> ColumnTypes.INT;
            case INT64 -> ColumnTypes.LONG;
            case DOUBLE -> ColumnTypes.DOUBLE;
            case DECIMAL128 -> ColumnTypes.DECIMAL;
            case BOOLEAN -> ColumnTypes.BOOLEAN;
            case DATE_TIME -> ColumnTypes.DATETIMEOFFSET;
            case DOCUMENT -> ColumnTypes.OBJECT;
            case ARRAY -> ColumnTypes.ARRAY;
            default -> ColumnTypes.STRING;
        };
    }

    /** One type when all non-null values agree, {@code any} when they differ or are all null. */
    static String inferColumnType(Collection<BsonValue> values)
    {
        Set<String> types = new HashSet<>();
        for (BsonValue value : values)
        {
            String type = columnType(value);
            if (type != null)
            {
                types.add(type);
            }
        }
        return types.size() == 1 ? types.iterator()
                .next()
                : ColumnTypes.ANY;
    }

    /**
     * The cell for {@code value} in a column of {@code columnType}. A value whose type differs from a typed column (possible for documents after the first batch) is sent as
     * text so the grid never receives a cell that contradicts its column type.
     */
    Object cell(BsonValue value, String columnType)
    {
        String valueType = columnType(value);
        if (valueType == null)
        {
            return null;
        }
        if (!ColumnTypes.ANY.equals(columnType)
                && !columnType.equals(valueType))
        {
            return text(value.isString() ? value.asString()
                    .getValue()
                    : json(value));
        }
        return nativeCell(value);
    }

    /** A JSON large-value cell holding {@code value} as relaxed Extended JSON. */
    Object jsonCell(BsonValue value)
    {
        return largeValues.storeText(queryExecutionId, LARGE_TYPE_JSON, CONTENT_TYPE_JSON, json(value));
    }

    /** Relaxed Extended JSON for any BSON value, including non-document values. */
    static String json(BsonValue value)
    {
        if (value.isDocument())
        {
            return value.asDocument()
                    .toJson(RELAXED_JSON);
        }
        String wrapped = new BsonDocument("v", value).toJson(RELAXED_JSON);
        if (wrapped.startsWith(WRAPPER_PREFIX)
                && wrapped.endsWith("}"))
        {
            return wrapped.substring(WRAPPER_PREFIX.length(), wrapped.length() - 1);
        }
        return wrapped;
    }

    private Object nativeCell(BsonValue value)
    {
        BsonType type = value.getBsonType();
        return switch (type)
        {
            case INT32 -> value.asInt32()
                    .getValue();
            case INT64 -> value.asInt64()
                    .getValue();
            case DOUBLE -> doubleCell(value.asDouble()
                    .getValue());
            case DECIMAL128 -> decimalCell(value.asDecimal128()
                    .getValue());
            case BOOLEAN -> value.asBoolean()
                    .getValue();
            case DATE_TIME -> ZonedDateTime.ofInstant(Instant.ofEpochMilli(value.asDateTime()
                    .getValue()), ZoneOffset.UTC);
            case STRING -> text(value.asString()
                    .getValue());
            case OBJECT_ID -> value.asObjectId()
                    .getValue()
                    .toHexString();
            case DOCUMENT, ARRAY -> jsonCell(value);
            default -> text(json(value));
        };
    }

    private Object text(String text)
    {
        return largeValues.storeText(queryExecutionId, LARGE_TYPE_TEXT, CONTENT_TYPE_TEXT, text);
    }

    /** NaN and infinities are not valid JSON numbers, so they are sent as text. */
    private static Object doubleCell(double value)
    {
        return Double.isFinite(value) ? value
                : String.valueOf(value);
    }

    private static Object decimalCell(Decimal128 value)
    {
        if (value.isNaN()
                || value.isInfinite())
        {
            return value.toString();
        }
        try
        {
            return value.bigDecimalValue();
        }
        catch (ArithmeticException e)
        {
            // Negative zero has no BigDecimal representation
            return BigDecimal.ZERO;
        }
    }
}
