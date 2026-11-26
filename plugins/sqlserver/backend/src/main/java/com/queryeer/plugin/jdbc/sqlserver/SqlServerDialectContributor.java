package com.queryeer.plugin.jdbc.sqlserver;

import com.queryeer.backend.queryengine.jdbc.JdbcDialectContributor;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectRegistry;
import com.queryeer.backend.queryengine.jdbc.JdbcDriverLoader;

/**
 * Registers the dialect, and loads its driver when it is installed. The driver lives in {@code libShared}, the shared class loader above this plugin's, and plugin.json makes its packages load
 * parent-first. A missing driver is normal until the user installs it; connecting then fails with "No suitable driver".
 */
final class SqlServerDialectContributor implements JdbcDialectContributor
{
    static final String DRIVER_CLASS_NAME = "com.microsoft.sqlserver.jdbc.SQLServerDriver";

    @Override
    public void contribute(JdbcDialectRegistry registry)
    {
        JdbcDriverLoader.loadDriver(DRIVER_CLASS_NAME, getClass().getClassLoader());
        registry.register(new SqlServerDialect());
    }
}
