package com.queryeer.plugin.jdbc.sqlite;

import com.queryeer.backend.queryengine.jdbc.JdbcDialectContributor;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectRegistry;
import com.queryeer.backend.queryengine.jdbc.JdbcDriverLoader;

/**
 * Registers the dialect, and loads its driver when it is installed. The driver lives in {@code libShared}, the shared class loader above this plugin's. A missing driver is normal until the user
 * installs it; connecting then fails with "No suitable driver".
 */
final class SqliteDialectContributor implements JdbcDialectContributor
{
    private static final String DRIVER_CLASS_NAME = "org.sqlite.JDBC";

    @Override
    public void contribute(JdbcDialectRegistry registry)
    {
        JdbcDriverLoader.loadDriver(DRIVER_CLASS_NAME, getClass().getClassLoader());
        registry.register(new SqliteDialect());
    }
}
