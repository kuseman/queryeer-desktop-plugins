package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.math.BigDecimal;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;

import org.bson.BsonArray;
import org.bson.BsonBinary;
import org.bson.BsonBoolean;
import org.bson.BsonDateTime;
import org.bson.BsonDecimal128;
import org.bson.BsonDocument;
import org.bson.BsonDouble;
import org.bson.BsonInt32;
import org.bson.BsonInt64;
import org.bson.BsonNull;
import org.bson.BsonObjectId;
import org.bson.BsonString;
import org.bson.BsonValue;
import org.bson.types.Decimal128;
import org.bson.types.ObjectId;
import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.contract.query.ColumnTypes;

class ValueMapperTest
{
    private final ValueMapper mapper = new ValueMapper(LargeValueStore.inlineOnly(), "qx-1");

    @Test
    void mapsBsonTypesToColumnTypes()
    {
        assertEquals(ColumnTypes.INT, ValueMapper.columnType(new BsonInt32(1)));
        assertEquals(ColumnTypes.LONG, ValueMapper.columnType(new BsonInt64(1)));
        assertEquals(ColumnTypes.DOUBLE, ValueMapper.columnType(new BsonDouble(1)));
        assertEquals(ColumnTypes.DECIMAL, ValueMapper.columnType(new BsonDecimal128(Decimal128.parse("1.5"))));
        assertEquals(ColumnTypes.BOOLEAN, ValueMapper.columnType(BsonBoolean.TRUE));
        assertEquals(ColumnTypes.DATETIMEOFFSET, ValueMapper.columnType(new BsonDateTime(0)));
        assertEquals(ColumnTypes.STRING, ValueMapper.columnType(new BsonString("a")));
        assertEquals(ColumnTypes.STRING, ValueMapper.columnType(new BsonObjectId()));
        assertEquals(ColumnTypes.OBJECT, ValueMapper.columnType(new BsonDocument()));
        assertEquals(ColumnTypes.ARRAY, ValueMapper.columnType(new BsonArray()));
        assertEquals(ColumnTypes.STRING, ValueMapper.columnType(new BsonBinary(new byte[] { 1 })));
        assertNull(ValueMapper.columnType(BsonNull.VALUE));
    }

    @Test
    void infersOneTypeOrAny()
    {
        assertEquals(ColumnTypes.INT, ValueMapper.inferColumnType(List.of(new BsonInt32(1), BsonNull.VALUE, new BsonInt32(2))));
        assertEquals(ColumnTypes.ANY, ValueMapper.inferColumnType(List.of(new BsonInt32(1), new BsonString("x"))));
        assertEquals(ColumnTypes.ANY, ValueMapper.inferColumnType(List.<BsonValue>of(BsonNull.VALUE)));
    }

    @Test
    void mapsCells()
    {
        assertEquals(5, mapper.cell(new BsonInt32(5), ColumnTypes.INT));
        assertEquals(5L, mapper.cell(new BsonInt64(5), ColumnTypes.LONG));
        assertEquals(1.5, mapper.cell(new BsonDouble(1.5), ColumnTypes.DOUBLE));
        assertEquals("NaN", mapper.cell(new BsonDouble(Double.NaN), ColumnTypes.DOUBLE));
        assertEquals(new BigDecimal("12.50"), mapper.cell(new BsonDecimal128(Decimal128.parse("12.50")), ColumnTypes.DECIMAL));
        assertEquals("NaN", mapper.cell(new BsonDecimal128(Decimal128.NaN), ColumnTypes.DECIMAL));
        assertEquals(BigDecimal.ZERO, mapper.cell(new BsonDecimal128(Decimal128.NEGATIVE_ZERO), ColumnTypes.DECIMAL));
        assertEquals(ZonedDateTime.of(2024, 1, 1, 0, 0, 0, 0, ZoneOffset.UTC), mapper.cell(new BsonDateTime(1704067200000L), ColumnTypes.DATETIMEOFFSET));
        assertEquals("65a000000000000000000001", mapper.cell(new BsonObjectId(new ObjectId("65a000000000000000000001")), ColumnTypes.STRING));
        assertEquals("{\"a\": 1, \"b\": {\"c\": [1, 2]}}", mapper.cell(BsonDocument.parse("{ \"a\": 1, \"b\": { \"c\": [1, 2] } }"), ColumnTypes.OBJECT));
        assertEquals("[1, \"x\"]", mapper.cell(BsonArray.parse("[1, \"x\"]"), ColumnTypes.ARRAY));
        assertNull(mapper.cell(BsonNull.VALUE, ColumnTypes.INT));
        assertNull(mapper.cell(null, ColumnTypes.INT));
    }

    @Test
    void sendsMismatchedValuesAsText()
    {
        assertEquals("abc", mapper.cell(new BsonString("abc"), ColumnTypes.INT));
        assertEquals("7", mapper.cell(new BsonInt64(7), ColumnTypes.INT));
        assertEquals(7L, mapper.cell(new BsonInt64(7), ColumnTypes.ANY));
    }

    @Test
    void writesNonDocumentValuesAsExtendedJson()
    {
        assertEquals("{\"$binary\": {\"base64\": \"AQ==\", \"subType\": \"00\"}}", ValueMapper.json(new BsonBinary(new byte[] { 1 })));
        assertEquals("\"x\"", ValueMapper.json(new BsonString("x")));
    }
}
