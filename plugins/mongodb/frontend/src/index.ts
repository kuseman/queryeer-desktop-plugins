import type { ExternalPluginModule } from "@queryeer/api/plugin/PluginModule";
import { mongoPlugin } from "./plugin.js";

// The plugin's id, name, version and description come from plugin.json
export const pluginModule: ExternalPluginModule = {
  manifest: mongoPlugin.manifest,
  plugin: mongoPlugin
};
