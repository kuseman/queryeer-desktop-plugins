import type { ExternalPluginModule } from "@queryeer/api/plugin/PluginModule";
import { elasticsearchPlugin } from "./plugin.js";

// The plugin's id, name, version and description come from plugin.json
export const pluginModule: ExternalPluginModule = {
  manifest: elasticsearchPlugin.manifest,
  plugin: elasticsearchPlugin
};
