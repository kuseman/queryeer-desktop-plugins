package com.queryeer.plugin.jdbc.mysql;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.PluginDescriptor;
import com.queryeer.backend.queryengine.jdbc.JdbcRuntimeService;

/** Registers the MySQL and MariaDB dialect with Queryeer's built-in JDBC query engine. */
public final class MySqlBackendPlugin implements BackendPlugin
{
    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor)
    {
        JdbcRuntimeService runtimeService = context.services()
                .get(JdbcRuntimeService.class);
        if (runtimeService == null)
        {
            throw new IllegalStateException("JdbcRuntimeService is required before the MySQL dialect activates");
        }
        new MySqlDialectContributor().contribute(runtimeService.dialectRegistry());

        String changelog = changelog();
        if (changelog != null)
        {
            context.changelogs()
                    .registerChangelog(descriptor.id(), changelog);
        }
        context.logger()
                .info("MySQL and MariaDB dialect " + descriptor.version() + " activated");
    }

    /** The plugin's CHANGELOG.md, generated from git history by the build (pom.xml), or null when it is missing. */
    static String changelog()
    {
        try (InputStream stream = MySqlBackendPlugin.class.getResourceAsStream("CHANGELOG.md"))
        {
            return stream != null ? new String(stream.readAllBytes(), StandardCharsets.UTF_8)
                    : null;
        }
        catch (IOException e)
        {
            throw new UncheckedIOException(e);
        }
    }
}
