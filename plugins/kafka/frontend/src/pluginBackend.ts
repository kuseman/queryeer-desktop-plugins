import type { PluginContext } from "@queryeer/api/plugin/Plugin";

// The plugin's own backend actions are PluginContext.backend in @queryeer/api 0.23 (PluginBackend). That version isn't on npm
// yet, so its shape is repeated here; import it from "@queryeer/api/plugin/PluginBackend" once the plugin builds against 0.23.

export type PluginBackendInvokeOptions = { silent?: boolean; timeoutMs?: number };

export type PluginBackend = {
  invoke: <TResult = unknown>(action: string, payload?: unknown, options?: PluginBackendInvokeOptions) => Promise<TResult>;
};

/** This plugin's backend actions; Queryeer 0.23 or later (plugin.json requires it). */
export function pluginBackend(context: PluginContext): PluginBackend {
  const backend = (context as PluginContext & { backend?: PluginBackend }).backend;
  if (!backend) {
    throw new Error("The Kafka plugin needs Queryeer 0.23 or later");
  }
  return backend;
}
