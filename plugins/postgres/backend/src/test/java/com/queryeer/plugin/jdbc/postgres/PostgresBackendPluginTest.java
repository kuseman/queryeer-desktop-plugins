package com.queryeer.plugin.jdbc.postgres;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;

import com.queryeer.backend.api.BackendPluginContext;
import com.queryeer.backend.api.ChangelogRegistry;
import com.queryeer.backend.api.LoggerService;
import com.queryeer.backend.api.PluginDescriptor;
import com.queryeer.backend.api.PluginServiceRegistry;
import com.queryeer.backend.queryengine.jdbc.JdbcDialectRegistry;
import com.queryeer.backend.queryengine.jdbc.JdbcRuntimeService;

class PostgresBackendPluginTest
{
    @Test
    void activateContributesDialect()
    {
        JdbcDialectRegistry registry = mock(JdbcDialectRegistry.class);
        JdbcRuntimeService runtimeService = mock(JdbcRuntimeService.class);
        when(runtimeService.dialectRegistry()).thenReturn(registry);

        PluginServiceRegistry services = mock(PluginServiceRegistry.class, CALLS_REAL_METHODS); // require() is a default method over get()
        when(services.get(JdbcRuntimeService.class)).thenReturn(runtimeService);

        LoggerService logger = mock(LoggerService.class);
        BackendPluginContext context = mock(BackendPluginContext.class);
        when(context.services()).thenReturn(services);
        when(context.logger()).thenReturn(logger);

        when(context.changelogs()).thenReturn(mock(ChangelogRegistry.class));
        PluginDescriptor descriptor = mock(PluginDescriptor.class);
        when(descriptor.version()).thenReturn("0.1.0");

        PostgresBackendPlugin plugin = new PostgresBackendPlugin();
        plugin.activate(context, descriptor);

        verify(registry).register(argThat(dialect -> "postgres".equals(dialect.metadata()
                .id())
                && dialect.queryPlanExecutor()
                        .isPresent()));
        verify(logger).info(eq("PostgreSQL dialect 0.1.0 activated"));
    }

    @Test
    void activateThrowsWhenJdbcRuntimeServiceIsMissing()
    {
        PluginServiceRegistry services = mock(PluginServiceRegistry.class, CALLS_REAL_METHODS); // require() is a default method over get()
        when(services.get(JdbcRuntimeService.class)).thenReturn(null);

        BackendPluginContext context = mock(BackendPluginContext.class);
        when(context.services()).thenReturn(services);

        PluginDescriptor descriptor = mock(PluginDescriptor.class);

        PostgresBackendPlugin plugin = new PostgresBackendPlugin();
        assertThrows(IllegalStateException.class, () -> plugin.activate(context, descriptor));
    }
}
