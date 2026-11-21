package com.queryeer.plugin.mongodb;

import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.DependencyExtension;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderRegistry;

/**
 * Registers the {@code mongodb} payloadbuilder catalog over this plugin's connections, replacing Queryeer's built-in one. Started by
 * {@link MongoBackendPlugin} through {@link DependencyExtension#whenDependencyActive}, so it loads only when {@code queryengine.payloadbuilder} is in use: it and
 * {@link PayloadbuilderMongoCatalogProvider} are the only classes that refer to payloadbuilder types.
 */
final class PayloadbuilderMongoCatalog implements DependencyExtension<MongoClientCache>
{
    @Override
    public void activate(BackendPluginContext context, MongoClientCache clients)
    {
        context.services()
                .require(PayloadbuilderCatalogProviderRegistry.class)
                .registerContributor(new PayloadbuilderMongoCatalogProvider(clients));
    }
}
