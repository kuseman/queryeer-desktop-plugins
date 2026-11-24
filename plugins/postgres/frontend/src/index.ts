import type { ExternalPluginModule } from "@queryeer/api/plugin/PluginModule";
import { postgresPlugin } from "./plugin.js";

// The plugin's id, name, version and description come from plugin.json
export const pluginModule: ExternalPluginModule = {
  manifest: postgresPlugin.manifest,
  plugin: postgresPlugin
};
