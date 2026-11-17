package com.queryeer.plugin.jdbc.mysql;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;

import org.junit.jupiter.api.Test;

class MySqlDialectTest
{
    private final MySqlDialect dialect = new MySqlDialect();

    @Test
    void buildsUrlWithDefaultPort()
    {
        assertEquals("jdbc:mariadb://db.local:3306/", dialect.buildUrl(Map.of("host", "db.local")));
    }

    @Test
    void buildsUrlWithPortAndDatabase()
    {
        assertEquals("jdbc:mariadb://db.local:3307/shop", dialect.buildUrl(Map.of("host", "db.local", "port", 3307, "database", "shop")));
        assertEquals("jdbc:mariadb://db.local:3307/shop", dialect.buildUrl(Map.of("host", "db.local", "port", "3307", "database", "shop")));
    }

    @Test
    void encodesDatabaseName()
    {
        assertEquals("jdbc:mariadb://db.local:3306/my%20db%3F", dialect.buildUrl(Map.of("host", "db.local", "database", "my db?")));
    }

    @Test
    void addsSslMode()
    {
        assertEquals("jdbc:mariadb://db.local:3306/shop?sslMode=verify-full", dialect.buildUrl(Map.of("host", "db.local", "database", "shop", "sslMode", "verify-full")));
        assertThrows(IllegalArgumentException.class, () -> dialect.buildUrl(Map.of("host", "db.local", "sslMode", "maybe")));
    }

    @Test
    void requiresHost()
    {
        assertThrows(IllegalArgumentException.class, () -> dialect.buildUrl(Map.of("database", "shop")));
    }

    @Test
    void rejectsPortThatIsNotANumber()
    {
        assertThrows(IllegalArgumentException.class, () -> dialect.buildUrl(Map.of("host", "db.local", "port", "abc")));
    }

    @Test
    void describesItself()
    {
        assertEquals("mysql", dialect.metadata()
                .id());
        assertEquals("org.mariadb.jdbc.Driver", dialect.metadata()
                .driverClassName());
    }
}
