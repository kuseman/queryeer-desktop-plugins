package com.queryeer.plugin.elasticsearch;

import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.DependencyExtension;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderRegistry;

/**
 * Registers the {@code elasticsearch} payloadbuilder catalog over this plugin's connections, replacing Queryeer's built-in one. Started by {@link ElasticsearchBackendPlugin} through
 * {@link DependencyExtension#whenDependencyActive}, so it loads only when {@code queryengine.payloadbuilder} is in use: it and {@link PayloadbuilderElasticsearchCatalogProvider} are the only
 * classes that refer to payloadbuilder types.
 */
final class PayloadbuilderElasticsearchCatalog implements DependencyExtension<ElasticsearchConnections>
{
    @Override
    public void activate(BackendPluginContext context, ElasticsearchConnections connections)
    {
        context.services()
                .require(PayloadbuilderCatalogProviderRegistry.class)
                .registerContributor(new PayloadbuilderElasticsearchCatalogProvider(connections));
    }
}
