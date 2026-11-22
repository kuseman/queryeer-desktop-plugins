package com.queryeer.plugin.kafka;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.DescribeClusterResult;
import org.apache.kafka.clients.admin.ListTopicsOptions;
import org.apache.kafka.common.Node;

/** The plugin's own admin calls: list topics and test a connection. Each call opens and closes its own client. */
final class KafkaAdmin
{
    static final int LIST_TOPICS_TIMEOUT_MS = 30_000;
    static final int TEST_CONNECTION_TIMEOUT_MS = 10_000;

    private KafkaAdmin()
    {
    }

    /** The cluster's topics, internal ones left out, sorted. */
    static List<String> listTopics(Properties clientProperties)
    {
        return call(clientProperties, LIST_TOPICS_TIMEOUT_MS, "list topics", admin -> new ArrayList<>(new TreeSet<>(admin.listTopics(new ListTopicsOptions().listInternal(false))
                .names()
                .get(LIST_TOPICS_TIMEOUT_MS, TimeUnit.MILLISECONDS))));
    }

    /** {@code { clusterId, brokers }} of the cluster, when it answers. */
    static Map<String, Object> describeCluster(Properties clientProperties)
    {
        return call(clientProperties, TEST_CONNECTION_TIMEOUT_MS, "connect", admin ->
        {
            DescribeClusterResult cluster = admin.describeCluster();
            String clusterId = cluster.clusterId()
                    .get(TEST_CONNECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            List<Node> nodes = new ArrayList<>(cluster.nodes()
                    .get(TEST_CONNECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS));
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("clusterId", clusterId);
            result.put("brokers", nodes.size());
            return result;
        });
    }

    private interface AdminCall<T>
    {
        T call(AdminClient admin) throws Exception;
    }

    private static <T> T call(Properties clientProperties, int timeoutMs, String what, AdminCall<T> call)
    {
        Properties properties = new Properties();
        properties.putAll(clientProperties);
        properties.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, timeoutMs);
        properties.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, timeoutMs);
        // Kafka loads configured classes and SASL login modules through the context class loader: make it the plugin's, which holds kafka-clients
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(AdminClient.class.getClassLoader());
        try (AdminClient admin = AdminClient.create(properties))
        {
            return call.call(admin);
        }
        catch (InterruptedException e)
        {
            thread.interrupt();
            throw new IllegalStateException("Interrupted while trying to " + what, e);
        }
        catch (TimeoutException e)
        {
            throw new IllegalArgumentException("Kafka did not answer within " + (timeoutMs / 1000) + " seconds", e);
        }
        catch (ExecutionException e)
        {
            Throwable cause = e.getCause() != null ? e.getCause()
                    : e;
            if (cause instanceof org.apache.kafka.common.errors.TimeoutException)
            {
                throw new IllegalArgumentException("Kafka did not answer within " + (timeoutMs / 1000) + " seconds: " + cause.getMessage(), cause);
            }
            throw new IllegalArgumentException("Could not " + what + ": " + cause.getMessage(), cause);
        }
        catch (org.apache.kafka.common.KafkaException e)
        {
            // E.g. an invalid bootstrap server or JAAS configuration, found when the client is created
            throw new IllegalArgumentException("Could not " + what + ": " + e.getMessage(), e);
        }
        catch (RuntimeException e)
        {
            throw e;
        }
        catch (Exception e)
        {
            throw new IllegalStateException("Could not " + what + ": " + e.getMessage(), e);
        }
        finally
        {
            thread.setContextClassLoader(previous);
        }
    }
}
