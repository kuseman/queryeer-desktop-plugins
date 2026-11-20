package com.queryeer.plugin.mongodb;

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
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.BackendPlugin;
import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.PluginDescriptor;
import com.queryeer.backend.api.PluginServiceRegistry;
import com.queryeer.backend.api.SettingsModule;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderContributor;
import com.queryeer.backend.queryengine.payloadbuilder.PayloadbuilderCatalogProviderRegistry;

import se.kuseman.payloadbuilder.api.execution.IQuerySession;
import se.kuseman.payloadbuilder.api.execution.ValueVector;
import se.kuseman.payloadbuilder.catalog.mongodb.MongoCatalog;

class PayloadbuilderMongoCatalogTest
{
    private static final String PLUGIN_PACKAGE = "com.queryeer.plugin.mongodb.";

    @Test
    void activatesWithoutPayloadbuilderAndNeverLoadsItsClasses() throws Exception
    {
        // As Queryeer's plugin class loader does when queryengine.payloadbuilder isn't there: its packages are invisible
        HidingClassLoader loader = new HidingClassLoader(getClass().getClassLoader(), name -> name.startsWith("se.kuseman.payloadbuilder.")
                || name.startsWith("com.queryeer.backend.queryengine.payloadbuilder."));
        BackendPlugin plugin = (BackendPlugin) loader.loadClass(MongoBackendPlugin.class.getName())
                .getDeclaredConstructor()
                .newInstance();
        List<String> errors = new ArrayList<>();

        plugin.activate(context(false, null, errors), descriptor());

        assertEquals(List.of(), errors);
        assertFalse(loader.isLoaded(MongoBackendPlugin.PAYLOADBUILDER_CATALOG_EXTENSION));
        assertFalse(loader.isLoaded(PLUGIN_PACKAGE + "PayloadbuilderMongoCatalogProvider"));
        plugin.deactivate();
    }

    @Test
    void registersTheMongodbCatalogWhenPayloadbuilderIsThere() throws Exception
    {
        List<PayloadbuilderCatalogProviderContributor> registered = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        MongoBackendPlugin plugin = new MongoBackendPlugin();

        plugin.activate(context(true, registered::add, errors), descriptor());

        assertEquals(List.of(), errors);
        assertEquals(1, registered.size());
        assertEquals("mongodb", registered.get(0)
                .catalogId());
        plugin.deactivate();
    }

    @Test
    void injectsTheConnectionFromThePluginsSettings()
    {
        MongoClientCache clients = new MongoClientCache(config(Map.of("connectionId", "c1", "title", "Local", "hosts", "db1:27017,db2:27017", "tls", true, "username", "app", "password",
                "s3cret", "options", "replicaSet=rs0")), logger(new ArrayList<>()));
        Map<String, Object> session = new HashMap<>();

        new PayloadbuilderMongoCatalogProvider(clients).injectProperties(session(session), "mongo", Map.of("connectionId", "c1"));

        assertEquals("mongodb://db1:27017,db2:27017/?replicaSet=rs0&tls=true", session.get(MongoCatalog.CONNECTIONSTRING_KEY));
        assertEquals("app", session.get(MongoCatalog.AUTH_USERNAME_KEY));
        assertEquals("s3cret", session.get(MongoCatalog.AUTH_PASSWORD_KEY));
        assertEquals("admin", session.get(MongoCatalog.AUTH_DATABASE_KEY));
        assertNull(session.get(MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY));
    }

    @Test
    void trustsInvalidCertificatesOnlyForATlsConnectionThatAllowsThem()
    {
        MongoClientCache clients = new MongoClientCache(config(Map.of("connectionId", "lab", "hosts", "lab:27017", "tls", true, "tlsAllowInvalidCertificates", true),
                // Not possible from the settings editor, but the flag means nothing without TLS, as for the plugin's own client
                Map.of("connectionId", "plain", "hosts", "plain:27017", "tls", false, "tlsAllowInvalidCertificates", true)), logger(new ArrayList<>()));
        PayloadbuilderMongoCatalogProvider provider = new PayloadbuilderMongoCatalogProvider(clients);
        Map<String, Object> lab = new HashMap<>();
        Map<String, Object> plain = new HashMap<>();

        provider.injectProperties(session(lab), "mongo", Map.of("connectionId", "lab"));
        provider.injectProperties(session(plain), "mongo", Map.of("connectionId", "plain"));

        assertEquals("mongodb://lab:27017/?tls=true", lab.get(MongoCatalog.CONNECTIONSTRING_KEY));
        assertEquals("true", lab.get(MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY));
        assertEquals("mongodb://plain:27017/", plain.get(MongoCatalog.CONNECTIONSTRING_KEY));
        assertNull(plain.get(MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY));

        // Switching the alias to another connection drops the flag
        provider.injectProperties(session(lab), "mongo", Map.of("connectionId", "plain"));
        assertNull(lab.get(MongoCatalog.TLS_ALLOW_INVALID_CERTIFICATES_KEY));
    }

    @Test
    void injectsNoCredentialsForAConnectionWithoutAUsername()
    {
        MongoClientCache clients = new MongoClientCache(config(Map.of("connectionId", "c1", "hosts", "localhost:27017")), logger(new ArrayList<>()));
        Map<String, Object> session = new HashMap<>();

        new PayloadbuilderMongoCatalogProvider(clients).injectProperties(session(session), "mongo", Map.of("connectionId", "c1"));

        assertEquals("mongodb://localhost:27017/", session.get(MongoCatalog.CONNECTIONSTRING_KEY));
        assertNull(session.get(MongoCatalog.AUTH_USERNAME_KEY));
    }

    @Test
    void saysWhyAConnectionCantBeUsed()
    {
        MongoClientCache clients = new MongoClientCache(config(Map.of("connectionId", "off", "hosts", "off:27017", "enabled", false)), logger(new ArrayList<>()));
        PayloadbuilderMongoCatalogProvider provider = new PayloadbuilderMongoCatalogProvider(clients);
        IQuerySession session = session(new HashMap<>());

        IllegalArgumentException disabled = assertThrows(IllegalArgumentException.class, () -> provider.injectProperties(session, "mongo", Map.of("connectionId", "off")));
        // E.g. a file from before this plugin, whose connection was one of Queryeer's own MongoDB connections
        IllegalArgumentException unknown = assertThrows(IllegalArgumentException.class, () -> provider.injectProperties(session, "mongo", Map.of("connectionId", "core-connection")));

        assertTrue(disabled.getMessage()
                .startsWith("Catalog 'mongo': ")
                && disabled.getMessage()
                        .contains("disabled"),
                disabled.getMessage());
        assertTrue(unknown.getMessage()
                .contains("was not found"), unknown.getMessage());
    }

    @Test
    void leavesTheCatalogUnconfiguredWithoutAConnection()
    {
        MongoClientCache clients = new MongoClientCache(config(), logger(new ArrayList<>()));
        Map<String, Object> session = new HashMap<>();

        new PayloadbuilderMongoCatalogProvider(clients).injectProperties(session(session), "mongo", Map.of());

        assertNull(session.get(MongoCatalog.CONNECTIONSTRING_KEY));
    }

    @SafeVarargs
    private static ConfigService config(Map<String, Object>... connections)
    {
        return new ConfigService()
        {
            @Override
            public String get(String key)
            {
                return null;
            }

            @Override
            public SettingsModule getModule(String moduleId)
            {
                return MongoConnectionSettings.MODULE_ID.equals(moduleId) ? new SettingsModule(moduleId, 1, "now", Map.of(MongoConnectionSettings.CONNECTIONS_SETTING_ID, List.of(connections)))
                        : null;
            }
        };
    }

    private static LoggerService logger(List<String> errors)
    {
        return proxy(LoggerService.class, (proxy, method, args) ->
        {
            if (method.getName()
                    .equals("error"))
            {
                errors.add(String.valueOf(args[0]) + (args.length > 1 && args[1] != null ? ": " + args[1] : ""));
            }
            return null;
        });
    }

    /** A plugin context whose services hold a payloadbuilder catalog registry when {@code payloadbuilderActive}. */
    private static BackendPluginContext context(boolean payloadbuilderActive, java.util.function.Consumer<PayloadbuilderCatalogProviderContributor> registry,
            List<String> errors)
    {
        ConfigService config = config();
        LoggerService logger = logger(errors);
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
            case "isDependencyActive" -> payloadbuilderActive && MongoBackendPlugin.PAYLOADBUILDER_PLUGIN_ID.equals(args[0]);
            case "config" -> config;
            case "logger" -> logger;
            case "services" -> services;
            // queryEngines, fileSessions, changelogs, ...: registrations go nowhere
            default -> method.getReturnType()
                    .isInterface() ? proxy(method.getReturnType(), (p, m, a) -> null)
                            : null;
        });
    }

    private static PluginDescriptor descriptor()
    {
        return new PluginDescriptor("com.queryeer.mongodb", "MongoDB", "test", List.of(), List.of(), List.of(), Map.of(), List.of(MongoBackendPlugin.PAYLOADBUILDER_PLUGIN_ID));
    }

    /** Records catalog properties as plain values. */
    private static IQuerySession session(Map<String, Object> properties)
    {
        return proxy(IQuerySession.class, (proxy, method, args) ->
        {
            if (method.isDefault())
            {
                return InvocationHandler.invokeDefault(proxy, method, args);
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
