import type { ExternalPluginModule } from "@queryeer/api/plugin/PluginModule";
import { sqlServerPlugin } from "./plugin.js";

// The plugin's id, name, version and description come from plugin.json
export const pluginModule: ExternalPluginModule = {
  manifest: sqlServerPlugin.manifest,
  plugin: sqlServerPlugin
};
