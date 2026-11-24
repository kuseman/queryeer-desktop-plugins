package com.queryeer.plugin.elasticsearch;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedTrustManager;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The plugin's own calls to a cluster: list indices and test a connection. They use the JDK's HTTP client, not payloadbuilder's, so they work without payloadbuilder. Each call opens and closes its
 * own client, with the connection's timeouts and certificate trust.
 */
final class ElasticsearchClient
{
    /** Used when the connection sets no timeout; longer than payloadbuilder's defaults, as listing indices on a big cluster takes a while. */
    static final int DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
    static final int DEFAULT_RECEIVE_TIMEOUT_MS = 30_000;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ElasticsearchClient()
    {
    }

    /**
     * Aliases, then data streams, then indices, each sorted case-insensitively, without duplicates or hidden names: what a catalog's {@code index} can name.
     */
    static List<String> listIndices(ElasticsearchConnections.Resolved connection)
    {
        try (HttpClient client = client(connection))
        {
            List<String> aliases = names(get(client, connection, "/_cat/aliases?format=json&h=alias"), "alias");
            List<String> dataStreams;
            try
            {
                JsonNode streams = get(client, connection, "/_data_stream").path("data_streams");
                dataStreams = new ArrayList<>();
                for (JsonNode stream : streams)
                {
                    addText(dataStreams, stream.path("name"));
                }
            }
            catch (IllegalArgumentException e)
            {
                // Clusters before 7.9 have no data streams, and a user may not be allowed to list them
                dataStreams = List.of();
            }
            List<String> indices = names(get(client, connection, "/_cat/indices?format=json&h=index"), "index");

            LinkedHashSet<String> result = new LinkedHashSet<>();
            for (List<String> names : List.of(aliases, dataStreams, indices))
            {
                List<String> sorted = new ArrayList<>(names);
                sorted.sort(String.CASE_INSENSITIVE_ORDER);
                result.addAll(sorted);
            }
            return List.copyOf(result);
        }
    }

    /** {@code { clusterName, version }} of the cluster, when it answers. */
    static Map<String, Object> info(ElasticsearchConnections.Resolved connection)
    {
        try (HttpClient client = client(connection))
        {
            JsonNode root = get(client, connection, "/");
            Map<String, Object> result = new LinkedHashMap<>();
            String clusterName = root.path("cluster_name")
                    .asText(null);
            String version = root.path("version")
                    .path("number")
                    .asText(null);
            if (clusterName != null)
            {
                result.put("clusterName", clusterName);
            }
            if (version != null)
            {
                result.put("version", version);
            }
            return result;
        }
    }

    private static HttpClient client(ElasticsearchConnections.Resolved connection)
    {
        HttpClient.Builder builder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(connection.connectTimeoutMs() != null ? connection.connectTimeoutMs()
                        : DEFAULT_CONNECT_TIMEOUT_MS))
                .followRedirects(HttpClient.Redirect.NORMAL);
        if (connection.trustCertificate())
        {
            builder.sslContext(trustAll());
        }
        return builder.build();
    }

    /** The answer's JSON; an {@link IllegalArgumentException} with a message for the user when the call fails. */
    private static JsonNode get(HttpClient client, ElasticsearchConnections.Resolved connection, String path)
    {
        URI uri;
        try
        {
            uri = URI.create(connection.endpoint() + path);
        }
        catch (IllegalArgumentException e)
        {
            throw new IllegalArgumentException("\"" + connection.endpoint() + "\" is not a valid URL");
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(uri)
                .GET()
                .timeout(Duration.ofMillis(connection.receiveTimeoutMs() != null ? connection.receiveTimeoutMs()
                        : DEFAULT_RECEIVE_TIMEOUT_MS))
                .header("Accept", "application/json");
        if (connection.basicAuth())
        {
            String token = Base64.getEncoder()
                    .encodeToString((connection.username() + ":" + connection.password()).getBytes(StandardCharsets.UTF_8));
            request.header("Authorization", "Basic " + token);
        }

        HttpResponse<String> response;
        try
        {
            response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }
        catch (InterruptedException e)
        {
            Thread.currentThread()
                    .interrupt();
            throw new IllegalArgumentException("Interrupted while calling " + connection.endpoint(), e);
        }
        catch (IOException e)
        {
            throw new IllegalArgumentException(failure(connection, e), e);
        }

        int status = response.statusCode();
        if (status == 401)
        {
            throw new IllegalArgumentException(connection.basicAuth() ? "Elasticsearch rejected the username or password"
                    : "Elasticsearch needs a username and a password");
        }
        if (status == 403)
        {
            throw new IllegalArgumentException("The user isn't allowed to call " + path.replaceAll("\\?.*", ""));
        }
        if (status >= 400)
        {
            throw new IllegalArgumentException("Elasticsearch answered " + status + " for " + path.replaceAll("\\?.*", ""));
        }
        try
        {
            return MAPPER.readTree(response.body());
        }
        catch (IOException e)
        {
            throw new IllegalArgumentException(connection.endpoint() + " didn't answer with JSON. Is it an Elasticsearch endpoint?", e);
        }
    }

    private static String failure(ElasticsearchConnections.Resolved connection, IOException e)
    {
        if (causedBy(e, SSLHandshakeException.class))
        {
            return connection.trustCertificate() ? "TLS handshake with " + connection.endpoint() + " failed: " + e.getMessage()
                    : "The certificate of " + connection.endpoint() + " isn't trusted. Turn on \"Trust certificate\" to accept it, for example a self-signed one";
        }
        if (e instanceof HttpConnectTimeoutException)
        {
            return "Timed out connecting to " + connection.endpoint();
        }
        if (e instanceof HttpTimeoutException)
        {
            return connection.endpoint() + " didn't answer in time";
        }
        if (causedBy(e, ConnectException.class))
        {
            return "Could not connect to " + connection.endpoint();
        }
        return "Could not call " + connection.endpoint() + ": " + (e.getMessage() != null ? e.getMessage()
                : e.getClass()
                        .getSimpleName());
    }

    private static boolean causedBy(Throwable e, Class<? extends Throwable> type)
    {
        for (Throwable cause = e; cause != null; cause = cause.getCause())
        {
            if (type.isInstance(cause))
            {
                return true;
            }
        }
        return false;
    }

    private static List<String> names(JsonNode rows, String field)
    {
        List<String> result = new ArrayList<>();
        for (JsonNode row : rows)
        {
            addText(result, row.path(field));
        }
        return result;
    }

    /** Leaves out hidden and system names ({@code .security}, {@code .kibana_1}, ...); a query can still name them. */
    private static void addText(List<String> target, JsonNode value)
    {
        String text = value.isTextual() ? value.asText()
                .trim()
                : "";
        if (!text.isEmpty()
                && !text.startsWith("."))
        {
            target.add(text);
        }
    }

    /**
     * Accepts any certificate and host name, as payloadbuilder's catalog does with {@code trustCertificate}. An {@link X509ExtendedTrustManager} also does the host name check, so this one skips it.
     */
    private static SSLContext trustAll()
    {
        TrustManager trustAll = new X509ExtendedTrustManager()
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
            public void checkClientTrusted(X509Certificate[] chain, String authType, java.net.Socket socket)
            {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType, java.net.Socket socket)
            {
            }

            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine)
            {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine)
            {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers()
            {
                return new X509Certificate[0];
            }
        };
        try
        {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { trustAll }, null);
            return context;
        }
        catch (GeneralSecurityException e)
        {
            throw new IllegalStateException("Cannot create a TLS context", e);
        }
    }
}
