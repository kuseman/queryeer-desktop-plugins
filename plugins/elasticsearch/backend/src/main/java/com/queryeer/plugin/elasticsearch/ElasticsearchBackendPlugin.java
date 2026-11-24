package com.queryeer.plugin.elasticsearch;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.DependencyExtension;
import com.queryeer.backend.api.PluginDescriptor;

/** Backend entry point for the Elasticsearch plugin ({@code plugin.json} {@code backend.entrypointClass}). */
public final class ElasticsearchBackendPlugin implements BackendPlugin
{
    /** An optional dependency (plugin.json): with it, this plugin's connections serve payloadbuilder's elasticsearch catalog. */
    static final String PAYLOADBUILDER_PLUGIN_ID = "queryengine.payloadbuilder";
    /** Named, not referenced, so payloadbuilder's classes load only when it is in use. */
    static final String PAYLOADBUILDER_CATALOG_EXTENSION = "com.queryeer.plugin.elasticsearch.PayloadbuilderElasticsearchCatalog";

    /** The frontend's backend actions ({@code context.backend.invoke}); the frontend uses the same names (constants.ts). */
    static final String ACTION_LIST_INDICES = "indices.list";
    static final String ACTION_TEST_CONNECTION = "connection.test";

    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor) throws Exception
    {
        ElasticsearchConnections connections = new ElasticsearchConnections(context.config());
        context.actions()
                .register(ACTION_LIST_INDICES, payload -> listIndices(connections, payload));
        context.actions()
                .register(ACTION_TEST_CONNECTION, payload -> testConnection(connections, payload));
        // A failing catalog extension is logged, and the rest of the plugin works without it
        DependencyExtension.whenDependencyActive(context, PAYLOADBUILDER_PLUGIN_ID, PAYLOADBUILDER_CATALOG_EXTENSION, connections);
        String changelog = changelog();
        if (changelog != null)
        {
            context.changelogs()
                    .registerChangelog(descriptor.id(), changelog);
        }
        context.logger()
                .info("Elasticsearch plugin " + descriptor.version() + " activated");
    }

    /** {@code { connectionId }} → {@code { indices }}: the aliases, data streams and indices of a saved connection. */
    static Map<String, Object> listIndices(ElasticsearchConnections connections, Object payload)
    {
        String connectionId = payload instanceof Map<?, ?> map
                && map.get("connectionId") instanceof String id ? id
                        : null;
        if (connectionId == null
                || connectionId.isBlank())
        {
            throw new IllegalArgumentException("Select an Elasticsearch connection");
        }
        ElasticsearchConnections.Resolved resolved = connections.resolve(connections.find(connectionId));
        return Map.of("indices", ElasticsearchClient.listIndices(resolved));
    }

    /**
     * {@code { connection }} → {@code { ok: true, clusterName, version }} or {@code { ok: false, message }}: connects with settings that may not be saved yet, for the settings editor's "Test
     * connection". A secret reference in them is resolved through the vault.
     */
    static Map<String, Object> testConnection(ElasticsearchConnections connections, Object payload)
    {
        Object raw = payload instanceof Map<?, ?> map ? map.get("connection")
                : null;
        ElasticsearchConnectionSettings connection = raw instanceof Map<?, ?> map ? ElasticsearchConnectionSettings.parse(map)
                : null;
        Map<String, Object> result = new LinkedHashMap<>();
        if (connection == null)
        {
            result.put("ok", false);
            result.put("message", "Enter the endpoint");
            return result;
        }
        try
        {
            result.put("ok", true);
            result.putAll(ElasticsearchClient.info(connections.resolve(connection)));
        }
        catch (IllegalArgumentException e)
        {
            result.clear();
            result.put("ok", false);
            result.put("message", e.getMessage());
        }
        return result;
    }

    /** The plugin's CHANGELOG.md, generated from git history by the build (pom.xml), or null when it is missing. */
    static String changelog()
    {
        try (InputStream stream = ElasticsearchBackendPlugin.class.getResourceAsStream("CHANGELOG.md"))
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
