package com.queryeer.plugin.elasticsearch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
import se.kuseman.payloadbuilder.api.execution.UTF8String;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.es.ESCatalog;

class ElasticsearchBackendPluginTest
{
    private static final String PLUGIN_PACKAGE = "com.queryeer.plugin.elasticsearch.";

    @Test
    void registersItsActionsWithoutPayloadbuilderAndNeverLoadsItsClasses() throws Exception
    {
        // As Queryeer's plugin class loader does when queryengine.payloadbuilder isn't there: its packages are invisible
        HidingClassLoader loader = new HidingClassLoader(getClass().getClassLoader(), name -> name.startsWith("se.kuseman.payloadbuilder.")
                || name.startsWith("com.queryeer.backend.queryengine.payloadbuilder."));
        BackendPlugin plugin = (BackendPlugin) loader.loadClass(ElasticsearchBackendPlugin.class.getName())
                .getDeclaredConstructor()
                .newInstance();
        Map<String, PluginActionHandler> actions = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();

        plugin.activate(context(false, null, actions, errors), descriptor());

        assertEquals(List.of(), errors);
        assertEquals(List.of(ElasticsearchBackendPlugin.ACTION_LIST_INDICES, ElasticsearchBackendPlugin.ACTION_TEST_CONNECTION), List.copyOf(actions.keySet()));
        assertFalse(loader.isLoaded(ElasticsearchBackendPlugin.PAYLOADBUILDER_CATALOG_EXTENSION));
        assertFalse(loader.isLoaded(PLUGIN_PACKAGE + "PayloadbuilderElasticsearchCatalogProvider"));
    }

    @Test
    void registersTheElasticsearchCatalogWhenPayloadbuilderIsThere() throws Exception
    {
        List<PayloadbuilderCatalogProviderContributor> registered = new ArrayList<>();
        List<String> errors = new ArrayList<>();

        new ElasticsearchBackendPlugin().activate(context(true, registered::add, new HashMap<>(), errors), descriptor());

        assertEquals(List.of(), errors);
        assertEquals(1, registered.size());
        assertEquals("elasticsearch", registered.get(0)
                .catalogId());
    }

    @Test
    void listIndicesNeedsAConnection()
    {
        ElasticsearchConnections connections = ElasticsearchConnectionsTest.connections();

        assertEquals("Select an Elasticsearch connection", assertThrows(IllegalArgumentException.class, () -> ElasticsearchBackendPlugin.listIndices(connections, Map.of())).getMessage());
        assertEquals("Elasticsearch connection \"gone\" was not found. It may have been removed in settings",
                assertThrows(IllegalArgumentException.class, () -> ElasticsearchBackendPlugin.listIndices(connections, Map.of("connectionId", "gone"))).getMessage());
    }

    @Test
    void testConnectionAnswersWhatIsMissing()
    {
        ElasticsearchConnections connections = ElasticsearchConnectionsTest.connections();

        assertEquals(Map.of("ok", false, "message", "Enter the endpoint"), ElasticsearchBackendPlugin.testConnection(connections, Map.of("connection", Map.of("connectionId", "new"))));
        assertEquals(Map.of("ok", false, "message", "Elasticsearch connection \"new\" uses basic authentication and needs a username and a password"), ElasticsearchBackendPlugin
                .testConnection(connections, Map.of("connection", Map.of("connectionId", "new", "endpoint", "https://es:9200", "authType", "BASIC", "authUsername", "app"))));
    }

    @Test
    void injectsTheConnectionIndexTrustAndTimeouts()
    {
        PayloadbuilderElasticsearchCatalogProvider provider = new PayloadbuilderElasticsearchCatalogProvider(ElasticsearchConnectionsTest.connections(Map.of("connectionId", "c1", "endpoint",
                "https://es:9200/", "authType", "BASIC", "authUsername", "app", "authPassword", Map.of("secretRef", "pw"), "trustCertificate", true, "connectTimeoutMs", 2000, "receiveTimeoutMs",
                60000)));
        Map<String, Object> session = new HashMap<>();

        provider.injectProperties(session(session), "es", Map.of("connectionId", "c1", "index", "orders-*"));

        assertEquals("https://es:9200", session.get(ESCatalog.ENDPOINT_KEY));
        assertEquals("BASIC", session.get(ESCatalog.AUTH_TYPE_KEY));
        assertEquals("app", session.get(ESCatalog.AUTH_USERNAME_KEY));
        assertEquals("secret", session.get(ESCatalog.AUTH_PASSWORD_KEY));
        assertEquals("orders-*", session.get(ESCatalog.INDEX_KEY));
        // payloadbuilder's catalog casts these to Boolean and Integer
        assertEquals(Boolean.TRUE, session.get(ESCatalog.TRUSTCERTIFICATE_KEY));
        assertEquals(Integer.valueOf(2000), session.get(ESCatalog.CONNECT_TIMEOUT_KEY));
        assertEquals(Integer.valueOf(60000), session.get(ESCatalog.RECEIVE_TIMEOUT_KEY));
    }

    @Test
    void leavesDefaultsToPayloadbuilderAndClearsWhatAnEarlierRunSet()
    {
        PayloadbuilderElasticsearchCatalogProvider provider = new PayloadbuilderElasticsearchCatalogProvider(ElasticsearchConnectionsTest.connections(Map.of("connectionId", "local", "endpoint",
                "http://localhost:9200")));
        Map<String, Object> session = new HashMap<>(Map.of(ESCatalog.TRUSTCERTIFICATE_KEY, true, ESCatalog.AUTH_PASSWORD_KEY, "stale", ESCatalog.INDEX_KEY, "old"));

        provider.injectProperties(session(session), "es", Map.of("connectionId", "local"));

        assertEquals(Map.of(ESCatalog.ENDPOINT_KEY, "http://localhost:9200", ESCatalog.AUTH_TYPE_KEY, "NONE"), session);
    }

    @Test
    void leavesTheCatalogUnconfiguredWithoutAConnectionAndSaysWhyOneCantBeUsed()
    {
        PayloadbuilderElasticsearchCatalogProvider provider = new PayloadbuilderElasticsearchCatalogProvider(ElasticsearchConnectionsTest.connections(Map.of("connectionId", "off", "endpoint",
                "http://es:9200", "enabled", false)));
        Map<String, Object> session = new HashMap<>(Map.of(ESCatalog.ENDPOINT_KEY, "http://stale:9200"));

        provider.injectProperties(session(session), "es", Map.of());

        assertNull(session.get(ESCatalog.ENDPOINT_KEY));
        assertEquals("Catalog 'es': Elasticsearch connection \"off\" is disabled",
                assertThrows(IllegalArgumentException.class, () -> provider.injectProperties(session(session), "es", Map.of("connectionId", "off"))).getMessage());
    }

    @Test
    void reportsTheConnectionAQueryPickedByItsEndpoint()
    {
        PayloadbuilderElasticsearchCatalogProvider provider = new PayloadbuilderElasticsearchCatalogProvider(ElasticsearchConnectionsTest.connections(Map.of("connectionId", "c1", "endpoint",
                "http://one:9200"), Map.of("connectionId", "c2", "endpoint", "http://two:9200"), Map.of("connectionId", "c3", "endpoint", "http://two:9200/")));

        // use es.endpoint = 'http://one:9200/' while c2 was picked: exactly c1's
        // (core sets the file's input properties in the session after injectProperties, then the query changes it)
        Map<String, Object> session = new HashMap<>(Map.of("connectionId", "c2", ESCatalog.ENDPOINT_KEY, "http://one:9200/"));
        assertEquals("c1", provider.buildCatalogPatch(session(session), "es", Map.of("connectionId", "c2"))
                .get("connectionId"));
        // http://two:9200 is two connections': left as an override
        session.put("connectionId", "c1");
        session.put(ESCatalog.ENDPOINT_KEY, "http://two:9200");
        assertFalse(provider.buildCatalogPatch(session(session), "es", Map.of("connectionId", "c1"))
                .containsKey("connectionId"));
    }

    private static PluginDescriptor descriptor()
    {
        return new PluginDescriptor("com.queryeer.elasticsearch", "Elasticsearch", "test", List.of(), List.of(), List.of(), Map.of(), List.of(ElasticsearchBackendPlugin.PAYLOADBUILDER_PLUGIN_ID));
    }

    /** A plugin context whose services hold a payloadbuilder catalog registry when {@code payloadbuilderActive}; actions are collected in {@code actions}. */
    private static BackendPluginContext context(boolean payloadbuilderActive, Consumer<PayloadbuilderCatalogProviderContributor> registry, Map<String, PluginActionHandler> actions,
            List<String> errors)
    {
        ConfigService config = ElasticsearchConnectionsTest.config();
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
            case "isDependencyActive" -> payloadbuilderActive && ElasticsearchBackendPlugin.PAYLOADBUILDER_PLUGIN_ID.equals(args[0]);
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
                    // Strings as String; Boolean, Integer and the password (an Object) as they are
                    Object stored = value.valueAsObject(0);
                    properties.put((String) args[1], stored instanceof UTF8String text ? text.toString()
                            : stored);
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
