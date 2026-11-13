import type { PluginModule } from "@queryeer/api/plugin/PluginModule";
import { mongoPlugin } from "./plugin.js";

export const pluginModule: PluginModule = {
  manifest: mongoPlugin.manifest,
  plugin: mongoPlugin
};
