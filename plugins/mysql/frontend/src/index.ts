import type { PluginModule } from "@queryeer/api/plugin/PluginModule";
import { mysqlPlugin } from "./plugin.js";

export const pluginModule: PluginModule = {
  manifest: mysqlPlugin.manifest,
  plugin: mysqlPlugin
};
