package com.queryeer.plugin.mongodb;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.DependencyExtension;
import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.api.PluginDescriptor;

/** Backend entry point for the MongoDB plugin ({@code plugin.json} {@code backend.entrypointClass}). */
public final class MongoBackendPlugin implements BackendPlugin
{
    public static final String ENGINE_ID = "mongodb";
    /** An optional dependency (plugin.json): with it, this plugin's connections also serve payloadbuilder's mongodb catalog. */
    static final String PAYLOADBUILDER_PLUGIN_ID = "queryengine.payloadbuilder";
    /** Named, not referenced, so payloadbuilder's classes load only when it is in use. */
    static final String PAYLOADBUILDER_CATALOG_EXTENSION = "com.queryeer.plugin.mongodb.PayloadbuilderMongoCatalog";

    private MongoClientCache clients;
    private MongoQueryEngineProvider provider;

    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor) throws Exception
    {
        LargeValueStore largeValues = context.services()
                .get(LargeValueStore.class);
        if (largeValues == null)
        {
            largeValues = LargeValueStore.inlineOnly();
        }

        FileConnections fileConnections = new FileConnections();
        clients = new MongoClientCache(context.config(), context.logger());
        provider = new MongoQueryEngineProvider(clients, fileConnections, largeValues, context.logger());

        context.fileSessions()
                .register(fileConnections);
        context.queryEngines()
                .register(provider);
        try
        {
            DependencyExtension.whenDependencyActive(context, PAYLOADBUILDER_PLUGIN_ID, PAYLOADBUILDER_CATALOG_EXTENSION, clients);
        }
        catch (Exception | LinkageError e)
        {
            // The MongoDB engine works without it
            context.logger()
                    .error("MongoDB plugin: payloadbuilder's mongodb catalog isn't available from this plugin", e);
        }
        String changelog = changelog();
        if (changelog != null)
        {
            context.changelogs()
                    .registerChangelog(descriptor.id(), changelog);
        }
        context.logger()
                .info("MongoDB plugin " + descriptor.version() + " activated");
    }

    /** The plugin's CHANGELOG.md, generated from git history by the build (pom.xml), or null when it is missing. */
    static String changelog()
    {
        try (InputStream stream = MongoBackendPlugin.class.getResourceAsStream("CHANGELOG.md"))
        {
            return stream != null ? new String(stream.readAllBytes(), StandardCharsets.UTF_8)
                    : null;
        }
        catch (IOException e)
        {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void deactivate()
    {
        if (provider != null)
        {
            provider.shutdown();
        }
        if (clients != null)
        {
            clients.close();
        }
    }
}
