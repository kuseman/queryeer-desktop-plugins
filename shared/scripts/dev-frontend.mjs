// Frontend development loop for a plugin: rebuild on save, copy the bundle into the installed plugin, then Reload Window in Queryeer.
//
//   node shared/scripts/dev-frontend.mjs plugins/mongodb
//
// - Watches <plugin>/frontend/src with esbuild (same options as the workspace's `build` script).
// - After each successful build, copies frontend/dist/index.js to <plugins dir>/<plugin id>/frontend/index.js.
// - If the plugin is not installed yet, installs the packaged folder dist/<id>-<version>/ first (run `npm run <plugin>:package` once).
//
// Queryeer loads external plugins once at startup and has no file watching, so:
// - frontend changes: Reload Window (Tools → Dev → Reload, or the "Reload Window" command); no restart needed
// - backend changes:  re-run `npm run <plugin>:package`, quit Queryeer, copy the folder again (the JVM locks the jars), start Queryeer
// See API-GAPS.md "Developer experience" (D1–D4) for what core could add to remove those steps.
//
// The plugins directory defaults to Queryeer's per-user directory; override it with QUERYEER_PLUGINS_DIR.
import { context as esbuildContext } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const pluginDir = resolve(process.argv[2] ?? fail("Usage: dev-frontend.mjs <plugin folder>"));
const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
if (!manifest.frontend) {
  fail(`${manifest.id} has no frontend`);
}

const pluginsDir = process.env.QUERYEER_PLUGINS_DIR ?? defaultPluginsDir();
// Same folder naming as Queryeer's installer (plugin-inventory-service.ts toPluginFolderName)
const installedDir = join(pluginsDir, manifest.id.replace(/[\\/:*?"<>|]/g, "_"));
const installedBundle = join(installedDir, "frontend", "index.js");
const frontendDir = join(pluginDir, "frontend");
const outfile = join(frontendDir, "dist", "index.js");

ensureInstalled();

const ctx = await esbuildContext({
  entryPoints: [join(frontendDir, "src", "index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  external: ["react", "react-dom"],
  loader: { ".css": "text" },
  logLevel: "warning",
  plugins: [
    {
      name: "copy-to-installed-plugin",
      setup(build) {
        build.onEnd((result) => {
          const time = new Date().toLocaleTimeString();
          if (result.errors.length > 0) {
            console.log(`[${time}] build failed (${result.errors.length} error(s)); installed bundle unchanged`);
            return;
          }
          mkdirSync(join(installedDir, "frontend"), { recursive: true });
          copyFileSync(outfile, installedBundle);
          console.log(`[${time}] updated ${installedBundle}. Reload Window in Queryeer to pick it up.`);
        });
      }
    }
  ]
});

await ctx.watch();
console.log(`Watching ${relative(repoRoot, join(frontendDir, "src"))} for ${manifest.id}. Press Ctrl+C to stop.`);

const stop = async () => {
  await ctx.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function ensureInstalled() {
  if (existsSync(join(installedDir, "plugin.json"))) {
    const installed = JSON.parse(readFileSync(join(installedDir, "plugin.json"), "utf8"));
    if (installed.frontend?.entryModule !== "./frontend/index.js") {
      fail(`${installedDir} has frontend.entryModule "${installed.frontend?.entryModule}"; expected "./frontend/index.js". Reinstall from dist/.`);
    }
    if (installed.version !== manifest.version) {
      console.warn(`Installed ${manifest.id} is ${installed.version}, source is ${manifest.version}. Reinstall to update the backend and manifest.`);
    }
    return;
  }
  const packaged = join(repoRoot, "dist", `${manifest.id}-${manifest.version}`);
  if (!existsSync(packaged)) {
    fail(`${manifest.id} is not installed in ${pluginsDir} and ${relative(repoRoot, packaged)} does not exist. Run the plugin's package script first.`);
  }
  cpSync(packaged, installedDir, { recursive: true });
  console.log(`Installed ${relative(repoRoot, packaged)} into ${installedDir}. Restart Queryeer once so it discovers the plugin.`);
}

function defaultPluginsDir() {
  // Electron userData for app name "queryeer-desktop" (app.setName in Queryeer's main process) + "/plugins"
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "queryeer-desktop", "plugins");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "queryeer-desktop", "plugins");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "queryeer-desktop", "plugins");
}

function fail(message) {
  console.error(`dev-frontend: ${message}`);
  process.exit(1);
}
