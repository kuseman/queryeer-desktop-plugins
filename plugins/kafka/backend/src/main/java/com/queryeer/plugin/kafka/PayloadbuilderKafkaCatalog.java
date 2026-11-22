package com.queryeer.plugin.kafka;

import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.DependencyExtension;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderRegistry;

/**
 * Registers the {@code kafka} payloadbuilder catalog over this plugin's connections, replacing Queryeer's built-in one. Started by {@link KafkaBackendPlugin} through
 * {@link DependencyExtension#whenDependencyActive}, so it loads only when {@code queryengine.payloadbuilder} is in use: it and {@link PayloadbuilderKafkaCatalogProvider} are the only classes
 * that refer to payloadbuilder types.
 */
final class PayloadbuilderKafkaCatalog implements DependencyExtension<KafkaConnections>
{
    @Override
    public void activate(BackendPluginContext context, KafkaConnections connections)
    {
        context.services()
                .require(PayloadbuilderCatalogProviderRegistry.class)
                .registerContributor(new PayloadbuilderKafkaCatalogProvider(connections));
    }
}
