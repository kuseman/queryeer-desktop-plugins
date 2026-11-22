package com.queryeer.plugin.kafka;

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

/** Backend entry point for the Kafka plugin ({@code plugin.json} {@code backend.entrypointClass}). */
public final class KafkaBackendPlugin implements BackendPlugin
{
    /** An optional dependency (plugin.json): with it, this plugin's connections serve payloadbuilder's kafka catalog. */
    static final String PAYLOADBUILDER_PLUGIN_ID = "queryengine.payloadbuilder";
    /** Named, not referenced, so payloadbuilder's classes load only when it is in use. */
    static final String PAYLOADBUILDER_CATALOG_EXTENSION = "com.queryeer.plugin.kafka.PayloadbuilderKafkaCatalog";

    /** The frontend's backend actions ({@code context.backend.invoke}); the frontend uses the same names (constants.ts). */
    static final String ACTION_LIST_TOPICS = "topics.list";
    static final String ACTION_TEST_CONNECTION = "connection.test";

    @Override
    public void activate(BackendPluginContext context, PluginDescriptor descriptor) throws Exception
    {
        KafkaConnections connections = new KafkaConnections(context.config());
        context.actions()
                .register(ACTION_LIST_TOPICS, payload -> listTopics(connections, payload));
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
                .info("Kafka plugin " + descriptor.version() + " activated");
    }

    /** {@code { connectionId }} → {@code { topics }}: the topics of a saved connection. */
    static Map<String, Object> listTopics(KafkaConnections connections, Object payload)
    {
        String connectionId = payload instanceof Map<?, ?> map
                && map.get("connectionId") instanceof String id ? id
                        : null;
        if (connectionId == null
                || connectionId.isBlank())
        {
            throw new IllegalArgumentException("Select a Kafka connection");
        }
        KafkaConnections.Resolved resolved = connections.resolve(connections.find(connectionId));
        return Map.of("topics", KafkaAdmin.listTopics(resolved.clientProperties()));
    }

    /**
     * {@code { connection }} → {@code { ok: true, clusterId, brokers }} or {@code { ok: false, message }}: connects with settings that may not be saved yet, for the settings editor's "Test connection".
     * Secret references in them are resolved through the vault.
     */
    static Map<String, Object> testConnection(KafkaConnections connections, Object payload)
    {
        Object raw = payload instanceof Map<?, ?> map ? map.get("connection")
                : null;
        KafkaConnectionSettings connection = raw instanceof Map<?, ?> map ? KafkaConnectionSettings.parse(map)
                : null;
        Map<String, Object> result = new LinkedHashMap<>();
        if (connection == null)
        {
            result.put("ok", false);
            result.put("message", "Enter the bootstrap servers");
            return result;
        }
        try
        {
            result.put("ok", true);
            result.putAll(KafkaAdmin.describeCluster(connections.resolve(connection)
                    .clientProperties()));
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
        try (InputStream stream = KafkaBackendPlugin.class.getResourceAsStream("CHANGELOG.md"))
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
