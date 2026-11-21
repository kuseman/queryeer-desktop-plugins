package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.ConfigService;
import com.queryeer.backend.api.LargeValueStore;
import com.queryeer.backend.api.LoggerService;

/** The editor's diagnostics: {@code mongodb.validate} reports what a run would, before connecting. */
class ValidateActionTest
{
    @Test
    void reportsNothingForValidStatementsInEitherForm()
    {
        assertEquals(List.of(), MongoQueryEngineProvider.validate("""
                db.orders.find({ status: "A" }).sort({ created: -1 }).limit(10)
                { "count": "orders" }
                """));
        assertEquals(List.of(), MongoQueryEngineProvider.validate(""));
    }

    @Test
    void reportsASyntaxErrorWithItsPosition()
    {
        List<Map<String, Object>> problems = MongoQueryEngineProvider.validate("""
                db.orders.find({ status: "A" })
                db.orders.find({ status: })
                """);

        assertEquals(1, problems.size());
        assertEquals(2, problems.get(0)
                .get("line"));
        assertTrue(problems.get(0)
                .get("column") instanceof Integer column
                && column > 1, problems.toString());
        assertTrue(problems.get(0)
                .get("message") instanceof String message
                && !message.isBlank());
    }

    @Test
    void reportsWhatTheReadOnlyPolicyRejects()
    {
        List<Map<String, Object>> problems = MongoQueryEngineProvider.validate("db.orders.aggregate([{ $out: \"copy\" }])");

        assertEquals(1, problems.size(), problems.toString());
    }

    @Test
    void needsNoConnection()
    {
        MongoQueryEngineProvider provider = new MongoQueryEngineProvider(new MongoClientCache(noConnections(), logger()), new FileConnections(), LargeValueStore.inlineOnly(), logger());

        assertEquals(List.of(), provider.invoke("file-1", MongoQueryEngineProvider.ACTION_VALIDATE, Map.of("text", "db.orders.find()")));
        assertEquals(1, ((List<?>) provider.invoke(null, MongoQueryEngineProvider.ACTION_VALIDATE, Map.of("text", "db.orders.find(")))
                .size());
    }

    @Test
    void holdsNoParserSharedByRunsAndChecks()
    {
        // ShellParser keeps its position in fields: one shared by concurrent runs (or a run and a check) mixes up their texts
        for (java.lang.reflect.Field field : MongoQueryEngineProvider.class.getDeclaredFields())
        {
            assertTrue(field.getType() != CommandParser.class
                    && field.getType() != ShellParser.class, field.toString());
        }
    }

    @Test
    void validatesConcurrentlyWithoutMixingUpTexts() throws Exception
    {
        // Checks run while typing, on the host's threads
        ExecutorService executor = Executors.newFixedThreadPool(8);
        try
        {
            List<Callable<Boolean>> tasks = new ArrayList<>();
            for (int i = 0; i < 200; i++)
            {
                String valid = "db.orders.find({ n: " + i + " }).sort({ a: 1 }).limit(" + (i + 1) + ")";
                String invalid = "db.orders.find({ n: " + i + ", })(";
                tasks.add(() -> MongoQueryEngineProvider.validate(valid)
                        .isEmpty());
                tasks.add(() -> MongoQueryEngineProvider.validate(invalid)
                        .size() == 1);
            }
            for (Future<Boolean> result : executor.invokeAll(tasks))
            {
                assertTrue(result.get());
            }
        }
        finally
        {
            executor.shutdownNow();
        }
    }

    private static ConfigService noConnections()
    {
        return key -> null;
    }

    private static LoggerService logger()
    {
        return (LoggerService) java.lang.reflect.Proxy.newProxyInstance(ValidateActionTest.class.getClassLoader(), new Class<?>[] { LoggerService.class }, (proxy, method, args) -> null);
    }
}
