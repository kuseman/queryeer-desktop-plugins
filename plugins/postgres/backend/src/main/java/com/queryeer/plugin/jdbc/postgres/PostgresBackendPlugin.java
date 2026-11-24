package com.queryeer.plugin.jdbc.postgres;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.PluginDescriptor;
import com.queryeer.backend.queryengine.jdbc.JdbcRuntimeService;

/** Registers the PostgreSQL dialect with Queryeer's built-in JDBC query engine. */
public final class PostgresBackendPlugin implements BackendPlugin
{
    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor)
    {
        JdbcRuntimeService runtimeService = context.services()
                .get(JdbcRuntimeService.class);
        if (runtimeService == null)
        {
            throw new IllegalStateException("JdbcRuntimeService is required before the PostgreSQL dialect activates");
        }
        new PostgresDialectContributor().contribute(runtimeService.dialectRegistry());

        String changelog = changelog();
        if (changelog != null)
        {
            context.changelogs()
                    .registerChangelog(descriptor.id(), changelog);
        }
        context.logger()
                .info("PostgreSQL dialect " + descriptor.version() + " activated");
    }

    /** The plugin's CHANGELOG.md, generated from git history by the build (pom.xml), or null when it is missing. */
    static String changelog()
    {
        try (InputStream stream = PostgresBackendPlugin.class.getResourceAsStream("CHANGELOG.md"))
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
