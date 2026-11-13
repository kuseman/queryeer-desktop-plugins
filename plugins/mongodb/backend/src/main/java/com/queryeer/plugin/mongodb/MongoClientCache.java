package com.queryeer.plugin.mongodb;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import org.bson.BsonDocument;
import org.bson.BsonInt32;

import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.MongoCredential;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.SettingsModule;

/**
 * One lazily created {@link MongoClient} per connection ID. A client is rebuilt when its connection's settings, including the resolved password, change.
 *
 * <p>
 * Resolving the password goes through the host vault on every lookup, so a locked vault surfaces as {@code SecuritySessionClosedException}, which the host turns into its
 * unlock flow.
 * </p>
 */
final class MongoClientCache implements AutoCloseable
{
    private static final int DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10_000;

    private final ConfigService config;
    private final LoggerService logger;
    private final Map<String, Entry> clients = new ConcurrentHashMap<>();

    MongoClientCache(ConfigService config, LoggerService logger)
    {
        this.config = config;
        this.logger = logger;
    }

    /** A connected client together with the settings it was built from. */
    record Handle(MongoConnectionSettings settings, MongoClient client)
    {
    }

    Handle get(String connectionId)
    {
        MongoConnectionSettings settings = findSettings(connectionId);
        String password = resolvePassword(settings);
        String fingerprint = fingerprint(settings, password);

        Entry entry = clients.compute(connectionId, (id, existing) ->
        {
            if (existing != null
                    && existing.fingerprint()
                            .equals(fingerprint))
            {
                return existing;
            }
            if (existing != null)
            {
                closeQuietly(existing);
            }
            return new Entry(fingerprint, settings, create(settings, password));
        });
        return new Handle(entry.settings(), entry.client());
    }

    MongoConnectionSettings findSettings(String connectionId)
    {
        SettingsModule module = config.getModule(MongoConnectionSettings.MODULE_ID);
        Object raw = module == null
                || module.values() == null ? null
                        : module.values()
                                .get(MongoConnectionSettings.CONNECTIONS_SETTING_ID);
        for (MongoConnectionSettings settings : MongoConnectionSettings.parseList(raw))
        {
            if (settings.connectionId()
                    .equals(connectionId))
            {
                if (!settings.enabled())
                {
                    throw new QueryValidationException("MongoDB connection \"" + settings.displayName() + "\" is disabled");
                }
                return settings;
            }
        }
        throw new QueryValidationException("MongoDB connection \"" + connectionId + "\" was not found. It may have been removed in settings");
    }

    /**
     * Connects with settings that may not be saved yet (for the settings editor's "Test connection"), returns the server version, and closes the client. The password is
     * still resolved through the vault.
     */
    String testConnection(MongoConnectionSettings settings)
    {
        try (MongoClient client = create(settings, resolvePassword(settings)))
        {
            BsonDocument buildInfo = client.getDatabase("admin")
                    .runCommand(new BsonDocument("buildInfo", new BsonInt32(1)), BsonDocument.class);
            return buildInfo.getString("version")
                    .getValue();
        }
    }

    @Override
    public void close()
    {
        clients.values()
                .forEach(this::closeQuietly);
        clients.clear();
    }

    private String resolvePassword(MongoConnectionSettings settings)
    {
        if (settings.username() == null)
        {
            return null;
        }
        Object materialized = config.materializeSecrets(settings.password());
        if (!(materialized instanceof String password)
                || password.isEmpty())
        {
            throw new QueryValidationException("MongoDB connection \"" + settings.displayName() + "\" has a username but no password");
        }
        return password;
    }

    private static MongoClient create(MongoConnectionSettings settings, String password)
    {
        ConnectionString connectionString;
        try
        {
            connectionString = new ConnectionString(settings.connectionString());
        }
        catch (IllegalArgumentException e)
        {
            throw new QueryValidationException("MongoDB connection \"" + settings.displayName() + "\" has invalid hosts or options: " + e.getMessage());
        }

        MongoClientSettings.Builder builder = MongoClientSettings.builder()
                .applicationName("Queryeer")
                .applyConnectionString(connectionString);

        if (connectionString.getServerSelectionTimeout() == null)
        {
            builder.applyToClusterSettings(b -> b.serverSelectionTimeout(DEFAULT_SERVER_SELECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS));
        }
        if (settings.username() != null)
        {
            builder.credential(MongoCredential.createCredential(settings.username(), settings.effectiveAuthDatabase(), password.toCharArray()));
        }
        if (settings.tls())
        {
            builder.applyToSslSettings(b ->
            {
                b.enabled(true);
                if (settings.tlsAllowInvalidCertificates())
                {
                    b.invalidHostNameAllowed(true);
                    b.context(trustAllContext());
                }
            });
        }
        return MongoClients.create(builder.build());
    }

    private static SSLContext trustAllContext()
    {
        try
        {
            SSLContext context = SSLContext.getInstance("TLS");
            TrustManager trustAll = new X509TrustManager()
            {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType)
                {
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType)
                {
                }

                @Override
                public X509Certificate[] getAcceptedIssuers()
                {
                    return new X509Certificate[0];
                }
            };
            context.init(null, new TrustManager[] { trustAll }, new SecureRandom());
            return context;
        }
        catch (Exception e)
        {
            throw new IllegalStateException("Could not create TLS context", e);
        }
    }

    private static String fingerprint(MongoConnectionSettings settings, String password)
    {
        String raw = String.join("\u0000", settings.connectionString(), String.valueOf(settings.username()), settings.effectiveAuthDatabase(), String.valueOf(settings.tls()),
                String.valueOf(settings.tlsAllowInvalidCertificates()), String.valueOf(password));
        try
        {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256")
                            .digest(raw.getBytes(StandardCharsets.UTF_8)));
        }
        catch (NoSuchAlgorithmException e)
        {
            throw new IllegalStateException(e);
        }
    }

    private void closeQuietly(Entry entry)
    {
        try
        {
            entry.client()
                    .close();
        }
        catch (RuntimeException e)
        {
            logger.warn("Failed to close MongoDB client for connection " + entry.settings()
                    .connectionId() + ": " + e.getMessage());
        }
    }

    private record Entry(String fingerprint, MongoConnectionSettings settings, MongoClient client)
    {
    }
}
