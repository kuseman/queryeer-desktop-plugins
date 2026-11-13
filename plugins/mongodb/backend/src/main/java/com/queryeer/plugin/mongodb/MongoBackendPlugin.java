package com.queryeer.plugin.mongodb;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.api.PluginDescriptor;

/** Backend entry point for the MongoDB plugin ({@code plugin.json} {@code backend.entrypointClass}). */
public final class MongoBackendPlugin implements BackendPlugin
{
    public static final String ENGINE_ID = "mongodb";

    private MongoClientCache clients;
    private MongoQueryEngineProvider provider;

    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor)
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
        context.logger()
                .info("MongoDB plugin " + descriptor.version() + " activated");
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
