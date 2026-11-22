package com.queryeer.plugin.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.PluginActionHandler;
import com.queryeer.backend.api.PluginActionRegistry;
import com.queryeer.backend.api.PluginDescriptor;
import com.queryeer.backend.api.PluginServiceRegistry;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderContributor;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderRegistry;

import se.kuseman.payloadbuilder.api.execution.IQuerySession;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.kafka.KafkaCatalog;

class KafkaBackendPluginTest
{
    private static final String PLUGIN_PACKAGE = "com.queryeer.plugin.kafka.";

    @Test
    void registersItsActionsWithoutPayloadbuilderAndNeverLoadsItsClasses() throws Exception
    {
        // As Queryeer's plugin class loader does when queryengine.payloadbuilder isn't there: its packages are invisible
        HidingClassLoader loader = new HidingClassLoader(getClass().getClassLoader(), name -> name.startsWith("se.kuseman.payloadbuilder.")
                || name.startsWith("com.queryeer.backend.queryengine.payloadbuilder."));
        BackendPlugin plugin = (BackendPlugin) loader.loadClass(KafkaBackendPlugin.class.getName())
                .getDeclaredConstructor()
                .newInstance();
        Map<String, PluginActionHandler> actions = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();

        plugin.activate(context(false, null, actions, errors), descriptor());

        assertEquals(List.of(), errors);
        assertEquals(List.of(KafkaBackendPlugin.ACTION_LIST_TOPICS, KafkaBackendPlugin.ACTION_TEST_CONNECTION), List.copyOf(actions.keySet()));
        assertFalse(loader.isLoaded(KafkaBackendPlugin.PAYLOADBUILDER_CATALOG_EXTENSION));
        assertFalse(loader.isLoaded(PLUGIN_PACKAGE + "PayloadbuilderKafkaCatalogProvider"));
    }

    @Test
    void registersTheKafkaCatalogWhenPayloadbuilderIsThere() throws Exception
    {
        List<PayloadbuilderCatalogProviderContributor> registered = new ArrayList<>();
        List<String> errors = new ArrayList<>();

        new KafkaBackendPlugin().activate(context(true, registered::add, new HashMap<>(), errors), descriptor());

        assertEquals(List.of(), errors);
        assertEquals(1, registered.size());
        assertEquals("kafka", registered.get(0)
                .catalogId());
    }

    @Test
    void listTopicsNeedsAConnection()
    {
        KafkaConnections connections = KafkaConnectionsTest.connections();

        assertEquals("Select a Kafka connection", assertThrows(IllegalArgumentException.class, () -> KafkaBackendPlugin.listTopics(connections, Map.of())).getMessage());
        assertEquals("Kafka connection \"gone\" was not found. It may have been removed in settings",
                assertThrows(IllegalArgumentException.class, () -> KafkaBackendPlugin.listTopics(connections, Map.of("connectionId", "gone"))).getMessage());
    }

    @Test
    void testConnectionAnswersWhatIsMissing()
    {
        KafkaConnections connections = KafkaConnectionsTest.connections();

        assertEquals(Map.of("ok", false, "message", "Enter the bootstrap servers"), KafkaBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new"))));
        assertEquals(Map.of("ok", false, "message", "Kafka connection \"new\" uses SASL PLAIN and needs a username and a password"), KafkaBackendPlugin.testConnection(connections,
                Map.of("connection", Map.of("connectionId", "new", "bootstrapServers", "b:9093", "securityProtocol", "SASL_SSL", "saslMechanism", "PLAIN"))));
    }

    @Test
    void injectsTheConnectionAndTopic()
    {
        PayloadbuilderKafkaCatalogProvider provider = new PayloadbuilderKafkaCatalogProvider(KafkaConnectionsTest.connections(Map.of("connectionId", "c1", "bootstrapServers", "b1:9093",
                "securityProtocol", "SASL_SSL", "saslMechanism", "SCRAM-SHA-512", "username", "app", "password", Map.of("secretRef", "pw"), "schemaRegistryUrl", "http://registry:8081")));
        Map<String, Object> session = new HashMap<>();

        provider.injectProperties(session(session), "kafka", Map.of("connectionId", "c1", "topic", "orders"));

        assertEquals("b1:9093", session.get(KafkaCatalog.BOOTSTRAP_SERVERS));
        assertEquals("SASL_SSL", session.get(KafkaCatalog.SECURITY_PROTOCOL));
        assertEquals("SCRAM-SHA-512", session.get(KafkaCatalog.SASL_MECHANISM));
        assertTrue(String.valueOf(session.get(KafkaCatalog.SASL_JAAS_CONFIG))
                .startsWith("org.apache.kafka.common.security.scram.ScramLoginModule required username=\"app\""));
        assertEquals("http://registry:8081", session.get(KafkaCatalog.SCHEMA_REGISTRY_URL));
        assertEquals("orders", session.get(KafkaCatalog.TOPIC));
    }

    @Test
    void leavesTheCatalogUnconfiguredWithoutAConnectionAndSaysWhyOneCantBeUsed()
    {
        PayloadbuilderKafkaCatalogProvider provider = new PayloadbuilderKafkaCatalogProvider(KafkaConnectionsTest.connections(Map.of("connectionId", "off", "bootstrapServers", "b:9092", "enabled",
                false)));
        Map<String, Object> session = new HashMap<>(Map.of(KafkaCatalog.BOOTSTRAP_SERVERS, "stale:9092"));

        provider.injectProperties(session(session), "kafka", Map.of());

        assertNull(session.get(KafkaCatalog.BOOTSTRAP_SERVERS));
        assertEquals("Catalog 'kafka': Kafka connection \"off\" is disabled",
                assertThrows(IllegalArgumentException.class, () -> provider.injectProperties(session(session), "kafka", Map.of("connectionId", "off"))).getMessage());
    }

    @Test
    void reportsTheConnectionAQueryPickedByItsBootstrapServers()
    {
        PayloadbuilderKafkaCatalogProvider provider = new PayloadbuilderKafkaCatalogProvider(KafkaConnectionsTest.connections(Map.of("connectionId", "c1", "bootstrapServers", "one:9092"),
                Map.of("connectionId", "c2", "bootstrapServers", "two:9092"), Map.of("connectionId", "c3", "bootstrapServers", "two:9092")));

        // use kafka.bootstrap_servers = 'one:9092' while c2 was picked: exactly c1's
        // (core sets the file's input properties in the session after injectProperties, then the query changes it)
        Map<String, Object> session = new HashMap<>(Map.of("connectionId", "c2", KafkaCatalog.BOOTSTRAP_SERVERS, "one:9092"));
        assertEquals("c1", provider.buildCatalogPatch(session(session), "kafka", Map.of("connectionId", "c2"))
                .get("connectionId"));
        // two:9092 is two connections': left as an override
        session.put("connectionId", "c1");
        session.put(KafkaCatalog.BOOTSTRAP_SERVERS, "two:9092");
        assertFalse(provider.buildCatalogPatch(session(session), "kafka", Map.of("connectionId", "c1"))
                .containsKey("connectionId"));
    }

    private static PluginDescriptor descriptor()
    {
        return new PluginDescriptor("com.queryeer.kafka", "Kafka", "test", List.of(), List.of(), List.of(), Map.of(), List.of(KafkaBackendPlugin.PAYLOADBUILDER_PLUGIN_ID));
    }

    /** A plugin context whose services hold a payloadbuilder catalog registry when {@code payloadbuilderActive}; actions are collected in {@code actions}. */
    private static BackendPluginContext context(boolean payloadbuilderActive, Consumer<PayloadbuilderCatalogProviderContributor> registry, Map<String, PluginActionHandler> actions,
            List<String> errors)
    {
        ConfigService config = KafkaConnectionsTest.config();
        LoggerService logger = proxy(LoggerService.class, (proxy, method, args) ->
        {
            if (method.getName()
                    .equals("error"))
            {
                errors.add(String.valueOf(args[0]));
            }
            return null;
        });
        PluginActionRegistry actionRegistry = actions::put;
        PluginServiceRegistry services = proxy(PluginServiceRegistry.class, (proxy, method, args) ->
        {
            if (method.isDefault())
            {
                return InvocationHandler.invokeDefault(proxy, method, args);
            }
            if (method.getName()
                    .equals("get")
                    && registry != null
                    && args[0] == PayloadbuilderCatalogProviderRegistry.class)
            {
                return (PayloadbuilderCatalogProviderRegistry) registry::accept;
            }
            return null;
        });
        return proxy(BackendPluginContext.class, (proxy, method, args) -> switch (method.getName())
        {
            case "isDependencyActive" -> payloadbuilderActive && KafkaBackendPlugin.PAYLOADBUILDER_PLUGIN_ID.equals(args[0]);
            case "config" -> config;
            case "logger" -> logger;
            case "services" -> services;
            case "actions" -> actionRegistry;
            // changelogs, ...: registrations go nowhere
            default -> method.getReturnType()
                    .isInterface() ? proxy(method.getReturnType(), (p, m, a) -> null)
                            : null;
        });
    }

    /** Records catalog properties as plain values, and reads them back. */
    private static IQuerySession session(Map<String, Object> properties)
    {
        return proxy(IQuerySession.class, (proxy, method, args) ->
        {
            if (method.isDefault())
            {
                return InvocationHandler.invokeDefault(proxy, method, args);
            }
            if (method.getName()
                    .equals("getCatalogProperty"))
            {
                Object value = properties.get((String) args[1]);
                return value == null ? null
                        : ValueVector.literalAny(1, value);
            }
            if (method.getName()
                    .equals("setCatalogProperty")
                    && args[2] instanceof ValueVector value)
            {
                if (value.isNull(0))
                {
                    properties.remove((String) args[1]);
                }
                else
                {
                    properties.put((String) args[1], value.valueAsString(0));
                }
            }
            return null;
        });
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler)
    {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, handler);
    }

    /** Defines this plugin's classes itself (child-first) and can't see the hidden packages; everything else comes from the parent. */
    private static final class HidingClassLoader extends ClassLoader
    {
        private final Predicate<String> hidden;

        HidingClassLoader(ClassLoader parent, Predicate<String> hidden)
        {
            super(parent);
            this.hidden = hidden;
        }

        boolean isLoaded(String name)
        {
            return findLoadedClass(name) != null;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException
        {
            if (hidden.test(name))
            {
                throw new ClassNotFoundException(name);
            }
            if (!name.startsWith(PLUGIN_PACKAGE))
            {
                return super.loadClass(name, resolve);
            }
            synchronized (getClassLoadingLock(name))
            {
                Class<?> type = findLoadedClass(name);
                if (type == null)
                {
                    try (InputStream in = getParent().getResourceAsStream(name.replace('.', '/') + ".class"))
                    {
                        if (in == null)
                        {
                            throw new ClassNotFoundException(name);
                        }
                        byte[] bytes = in.readAllBytes();
                        type = defineClass(name, bytes, 0, bytes.length);
                    }
                    catch (IOException e)
                    {
                        throw new ClassNotFoundException(name, e);
                    }
                }
                return type;
            }
        }
    }
}
