package com.queryeer.plugin.jdbc.mysql;

import static com.queryeer.backend.api.PayloadUtils.stringValue;
import static com.queryeer.backend.api.PayloadUtils.trimToNull;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.queryeer.backend.queryengine.jdbc.JdbcConnection;
import com.queryeer.backend.queryengine.jdbc.JdbcDialect;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectSupport;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaObject;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaResolver;
import com.queryeer.backend.queryengine.jdbc.schema.JdbcSchemaTarget;

/**
 * The database tree for MySQL and MariaDB.
 *
 * <p>
 * The JDBC engine's default tree reads {@code information_schema} the standard way: {@code table_catalog} is the database and {@code table_schema} the schema. MySQL and MariaDB have no catalogs
 * ({@code table_catalog} is always {@code def}), and what they call a database is {@code table_schema}. So here a database is a row of {@code information_schema.schemata}, its Tables, Views,
 * Procedures and Triggers folders sit directly under it, and every node carries the database as {@code catalog}, which the frontend and the schema crawler read as the target database.
 * </p>
 */
final class MySqlSchemaResolvers
{
    private static final String KEY_CATALOG = "catalog";
    private static final String KEY_TABLE = "table";
    private static final String KEY_TYPE = "type";
    private static final String OPTION_TARGET = "target";

    private static final String KIND_DATABASES_CONTAINER = "databases_container";
    private static final String KIND_DATABASE = "database";
    private static final String KIND_TABLES_FOLDER = "tables_folder";
    private static final String KIND_VIEWS_FOLDER = "views_folder";
    private static final String KIND_PROCEDURES_FOLDER = "procedures_folder";
    private static final String KIND_TRIGGERS_FOLDER = "triggers_folder";
    private static final String KIND_COLUMNS_FOLDER = "columns_folder";
    private static final String KIND_INDEXES_FOLDER = "indexes_folder";
    private static final String KIND_TABLE = "table";
    private static final String KIND_VIEW = "view";

    //@formatter:off
    private static final String SQL_DATABASES = """
            select schema_name
            from information_schema.schemata
            order by schema_name
            """;

    /** The database is a parameter; when the target names none, the connection's current database is used. */
    private static final String SQL_TABLES = """
            select table_schema, table_name
            from information_schema.tables
            where table_schema = coalesce(?, database())
              and table_type in (?, ?)
            order by table_name
            """;

    private static final String SQL_PROCEDURES = """
            select routine_schema, specific_name, routine_name
            from information_schema.routines
            where routine_schema = coalesce(?, database())
              and routine_type = 'PROCEDURE'
            order by routine_name
            """;

    private static final String SQL_PARAMETERS = """
            select parameter_name, data_type, parameter_mode, ordinal_position
            from information_schema.parameters
            where specific_schema = ?
              and specific_name = ?
              and ordinal_position > 0
            order by ordinal_position
            """;

    private static final String SQL_TRIGGERS = """
            select event_object_schema, trigger_name
            from information_schema.triggers
            where event_object_schema = coalesce(?, database())
            order by trigger_name
            """;

    private static final String SQL_COLUMNS = """
            select c.column_name, c.data_type, c.is_nullable, c.ordinal_position, c.column_default, c.column_key,
                   k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name
            from information_schema.columns c
            left join information_schema.key_column_usage k
              on k.table_schema = c.table_schema
             and k.table_name = c.table_name
             and k.column_name = c.column_name
             and k.referenced_table_name is not null
            where c.table_schema = coalesce(?, database())
              and c.table_name = ?
            order by c.ordinal_position
            """;

    private static final String SQL_INDEXES = """
            select index_name, column_name, seq_in_index, non_unique, collation
            from information_schema.statistics
            where table_schema = coalesce(?, database())
              and table_name = ?
            order by index_name, seq_in_index
            """;
    //@formatter:on

    private final JdbcDialect dialect;

    MySqlSchemaResolvers(JdbcDialect dialect)
    {
        this.dialect = dialect;
    }

    Map<String, JdbcSchemaResolver> resolvers()
    {
        //@formatter:off
        return Map.ofEntries(
                Map.entry("connection", this::databasesContainer),
                Map.entry(KIND_DATABASES_CONTAINER, this::databasesContainer),
                Map.entry(KIND_DATABASE, MySqlSchemaResolvers::databaseFolders),
                // MariaDB's system-versioned tables have their own type; information_schema's own tables are system views
                Map.entry(KIND_TABLES_FOLDER, (connection, options) -> tables(connection, options, "BASE TABLE", "SYSTEM VERSIONED", KIND_TABLE)),
                Map.entry(KIND_VIEWS_FOLDER, (connection, options) -> tables(connection, options, "VIEW", "SYSTEM VIEW", KIND_VIEW)),
                Map.entry(KIND_PROCEDURES_FOLDER, this::procedures),
                Map.entry(KIND_TRIGGERS_FOLDER, this::triggers),
                Map.entry(KIND_TABLE, (connection, options) -> JdbcDialectSupport.resolveTableFolders(target(options))),
                Map.entry(KIND_VIEW, (connection, options) -> JdbcDialectSupport.resolveTableFolders(target(options))),
                Map.entry(KIND_COLUMNS_FOLDER, this::columns),
                Map.entry(KIND_INDEXES_FOLDER, this::indexes));
        //@formatter:on
    }

    private List<JdbcSchemaObject> databasesContainer(JdbcConnection connection, Map<String, Object> options)
    {
        List<JdbcSchemaObject> databases = query(connection, "databases", jdbc ->
        {
            List<JdbcSchemaObject> result = new ArrayList<>();
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_DATABASES); ResultSet rs = statement.executeQuery())
            {
                while (rs.next())
                {
                    String name = rs.getString(1);
                    result.add(new JdbcSchemaObject("database:" + name, name, KIND_DATABASE, null, Map.of()));
                }
            }
            return result;
        });
        return List.of(new JdbcSchemaObject("__databases__", "Databases", KIND_DATABASES_CONTAINER, databases, Map.of()));
    }

    /** A database's folders. They carry the database as {@code catalog}, so expanding one targets that database. */
    private static List<JdbcSchemaObject> databaseFolders(JdbcConnection connection, Map<String, Object> options)
    {
        JdbcSchemaTarget target = target(options);
        String database = target != null ? target.database()
                : null;
        if (database == null)
        {
            return List.of();
        }
        Map<String, Object> attributes = Map.of(KEY_CATALOG, database);
        return List.of(new JdbcSchemaObject(KIND_TABLES_FOLDER + ":" + database, "Tables", KIND_TABLES_FOLDER, null, attributes),
                new JdbcSchemaObject(KIND_VIEWS_FOLDER + ":" + database, "Views", KIND_VIEWS_FOLDER, null, attributes),
                new JdbcSchemaObject(KIND_PROCEDURES_FOLDER + ":" + database, "Procedures", KIND_PROCEDURES_FOLDER, null, attributes),
                new JdbcSchemaObject(KIND_TRIGGERS_FOLDER + ":" + database, "Triggers", KIND_TRIGGERS_FOLDER, null, attributes));
    }

    private List<JdbcSchemaObject> tables(JdbcConnection connection, Map<String, Object> options, String type, String otherType, String kind)
    {
        String database = database(options);
        return query(connection, kind + "s", jdbc ->
        {
            List<JdbcSchemaObject> result = new ArrayList<>();
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_TABLES))
            {
                statement.setString(1, database);
                statement.setString(2, type);
                statement.setString(3, otherType);
                try (ResultSet rs = statement.executeQuery())
                {
                    while (rs.next())
                    {
                        String schema = rs.getString(1);
                        String name = rs.getString(2);
                        result.add(new JdbcSchemaObject(kind + ":" + schema + ":" + name, name, kind, null, schema + "." + name, null, Map.of(KEY_CATALOG, schema)));
                    }
                }
            }
            return result;
        });
    }

    private List<JdbcSchemaObject> procedures(JdbcConnection connection, Map<String, Object> options)
    {
        String database = database(options);
        return query(connection, "procedures", jdbc ->
        {
            List<JdbcSchemaObject> result = new ArrayList<>();
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_PROCEDURES); PreparedStatement parameters = jdbc.prepareStatement(SQL_PARAMETERS))
            {
                statement.setString(1, database);
                try (ResultSet rs = statement.executeQuery())
                {
                    while (rs.next())
                    {
                        String schema = rs.getString(1);
                        String specificName = rs.getString(2);
                        String name = rs.getString(3);
                        result.add(new JdbcSchemaObject("procedure:" + schema + ":" + specificName, name, "procedure", null, schema + "." + name,
                                parameters(parameters, schema, specificName), Map.of(KEY_CATALOG, schema)));
                    }
                }
            }
            return result;
        });
    }

    private static List<JdbcSchemaObject> parameters(PreparedStatement statement, String schema, String specificName) throws SQLException
    {
        statement.setString(1, schema);
        statement.setString(2, specificName);
        List<JdbcSchemaObject> result = new ArrayList<>();
        try (ResultSet rs = statement.executeQuery())
        {
            while (rs.next())
            {
                String name = rs.getString(1);
                Map<String, Object> attributes = new LinkedHashMap<>();
                attributes.put(KEY_TYPE, lower(rs.getString(2)));
                attributes.put("mode", rs.getString(3) == null ? ""
                        : rs.getString(3)
                                .toUpperCase());
                attributes.put("ordinal", rs.getInt(4));
                result.add(new JdbcSchemaObject("param:" + schema + ":" + specificName + ":" + name, name, "parameter", null, Map.copyOf(attributes)));
            }
        }
        return result;
    }

    private List<JdbcSchemaObject> triggers(JdbcConnection connection, Map<String, Object> options)
    {
        String database = database(options);
        return query(connection, "triggers", jdbc ->
        {
            List<JdbcSchemaObject> result = new ArrayList<>();
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_TRIGGERS))
            {
                statement.setString(1, database);
                try (ResultSet rs = statement.executeQuery())
                {
                    while (rs.next())
                    {
                        String schema = rs.getString(1);
                        String name = rs.getString(2);
                        result.add(new JdbcSchemaObject("trigger:" + schema + ":" + name, name, "trigger", null, schema + "." + name, null, Map.of(KEY_CATALOG, schema)));
                    }
                }
            }
            return result;
        });
    }

    private List<JdbcSchemaObject> columns(JdbcConnection connection, Map<String, Object> options)
    {
        JdbcSchemaTarget target = target(options);
        if (target == null
                || target.table() == null)
        {
            return List.of();
        }
        return query(connection, "columns of " + target.table(), jdbc ->
        {
            List<JdbcSchemaObject> result = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_COLUMNS))
            {
                statement.setString(1, target.database());
                statement.setString(2, target.table());
                try (ResultSet rs = statement.executeQuery())
                {
                    while (rs.next())
                    {
                        String name = rs.getString(1);
                        // A column in two foreign keys has two rows; the first one describes it
                        if (!seen.add(name))
                        {
                            continue;
                        }
                        Map<String, Object> attributes = new LinkedHashMap<>();
                        attributes.put(KEY_TYPE, lower(rs.getString(2)));
                        attributes.put("nullable", rs.getString(3));
                        attributes.put("ordinal", rs.getInt(4));
                        String defaultValue = rs.getString(5);
                        if (defaultValue != null)
                        {
                            attributes.put("defaultValue", defaultValue);
                        }
                        if ("PRI".equalsIgnoreCase(rs.getString(6)))
                        {
                            attributes.put("primaryKey", true);
                        }
                        String referencedTable = rs.getString(8);
                        if (referencedTable != null)
                        {
                            attributes.put("foreignKey", true);
                            attributes.put("referencesSchema", rs.getString(7));
                            attributes.put("referencesTable", referencedTable);
                            attributes.put("referencesColumn", rs.getString(9));
                        }
                        result.add(new JdbcSchemaObject("column:" + target.database() + ":" + target.table() + ":" + name, name, "column", null, Map.copyOf(attributes)));
                    }
                }
            }
            return result;
        });
    }

    private List<JdbcSchemaObject> indexes(JdbcConnection connection, Map<String, Object> options)
    {
        JdbcSchemaTarget target = target(options);
        if (target == null
                || target.table() == null)
        {
            return List.of();
        }
        return query(connection, "indexes of " + target.table(), jdbc ->
        {
            Map<String, Boolean> unique = new LinkedHashMap<>();
            Map<String, List<JdbcSchemaObject>> columns = new LinkedHashMap<>();
            String prefix = target.database() + ":" + target.table() + ":";
            try (PreparedStatement statement = jdbc.prepareStatement(SQL_INDEXES))
            {
                statement.setString(1, target.database());
                statement.setString(2, target.table());
                try (ResultSet rs = statement.executeQuery())
                {
                    while (rs.next())
                    {
                        String index = rs.getString(1);
                        String column = rs.getString(2);
                        unique.put(index, rs.getInt(4) == 0);
                        Map<String, Object> attributes = new LinkedHashMap<>();
                        attributes.put("ordinal", rs.getInt(3));
                        String collation = rs.getString(5);
                        if (collation != null)
                        {
                            attributes.put("sortOrder", "D".equalsIgnoreCase(collation) ? "DESC"
                                    : "ASC");
                        }
                        columns.computeIfAbsent(index, _ -> new ArrayList<>())
                                .add(new JdbcSchemaObject("index_col:" + prefix + index + ":" + column, column, "index_column", null, Map.copyOf(attributes)));
                    }
                }
            }
            List<JdbcSchemaObject> result = new ArrayList<>();
            for (Map.Entry<String, List<JdbcSchemaObject>> entry : columns.entrySet())
            {
                Map<String, Object> attributes = new LinkedHashMap<>();
                attributes.put("unique", unique.get(entry.getKey()));
                attributes.put("columns", String.join(", ", entry.getValue()
                        .stream()
                        .map(JdbcSchemaObject::name)
                        .toList()));
                result.add(new JdbcSchemaObject("index:" + prefix + entry.getKey(), entry.getKey(), "index", List.copyOf(entry.getValue()), Map.copyOf(attributes)));
            }
            return result;
        });
    }

    // -- Helpers --

    @FunctionalInterface
    private interface SqlFunction<T>
    {
        T apply(Connection jdbc) throws SQLException;
    }

    private <T> T query(JdbcConnection connection, String what, SqlFunction<T> function)
    {
        try (Connection jdbc = dialect.openSessionConnection(connection.properties()))
        {
            return function.apply(jdbc);
        }
        catch (SQLException e)
        {
            throw new RuntimeException("Failed to list " + what, e);
        }
    }

    private static String database(Map<String, Object> options)
    {
        JdbcSchemaTarget target = target(options);
        return target != null ? target.database()
                : null;
    }

    static JdbcSchemaTarget target(Map<String, Object> options)
    {
        Object value = options.get(OPTION_TARGET);
        if (value instanceof JdbcSchemaTarget target)
        {
            return new JdbcSchemaTarget(trimToNull(target.database()), trimToNull(target.schema()), trimToNull(target.table()));
        }
        if (value instanceof Map<?, ?> map)
        {
            return new JdbcSchemaTarget(trimToNull(stringValue(map, "database")), trimToNull(stringValue(map, "schema")), trimToNull(stringValue(map, KEY_TABLE)));
        }
        return null;
    }

    private static String lower(String value)
    {
        return value == null ? ""
                : value.toLowerCase();
    }
}
