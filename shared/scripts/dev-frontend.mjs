// Frontend development loop for a plugin: rebuild on save into the packaged folder Queryeer loads as a developer plugin.
//
//   node shared/scripts/dev-frontend.mjs plugins/mongodb
//
// - Watches <plugin>/frontend/src with esbuild (same options as the workspace's `build` script).
// - After each successful build, copies frontend/dist/index.js into dist/<id>-<version>/frontend/index.js.
// - Start Queryeer with QUERYEER_DEV_PLUGINS set to that folder (the script prints it). Queryeer 0.20.0 loads it in
//   place, instead of an installed copy with the same id.
//
// - frontend changes: Reload Window
// - backend changes:  re-run `npm run <plugin>:package`, then Restart Backend and Reload (Queryeer copies the jars, so
//   the build can overwrite them while it runs)
import { context as esbuildContext } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const pluginDir = resolve(process.argv[2] ?? fail("Usage: dev-frontend.mjs <plugin folder>"));
const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
if (!manifest.frontend) {
  fail(`${manifest.id} has no frontend`);
}

const packagedDir = join(repoRoot, "dist", `${manifest.id}-${manifest.version}`);
const packagedBundle = join(packagedDir, "frontend", "index.js");
const frontendDir = join(pluginDir, "frontend");
const outfile = join(frontendDir, "dist", "index.js");

ensurePackaged();

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
      name: "copy-to-packaged-plugin",
      setup(build) {
        build.onEnd((result) => {
          const time = new Date().toLocaleTimeString();
          if (result.errors.length > 0) {
            console.log(`[${time}] build failed (${result.errors.length} error(s)); packaged bundle unchanged`);
            return;
          }
          mkdirSync(join(packagedDir, "frontend"), { recursive: true });
          copyFileSync(outfile, packagedBundle);
          console.log(`[${time}] updated ${relative(repoRoot, packagedBundle)}. Reload Window in Queryeer to pick it up.`);
        });
      }
    }
  ]
});

await ctx.watch();
console.log(`Watching ${relative(repoRoot, join(frontendDir, "src"))} for ${manifest.id}. Press Ctrl+C to stop.`);
console.log(`Start Queryeer with QUERYEER_DEV_PLUGINS=${packagedDir}`);

const stop = async () => {
  await ctx.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function ensurePackaged() {
  const packagedManifest = join(packagedDir, "plugin.json");
  if (!existsSync(packagedManifest)) {
    fail(`${relative(repoRoot, packagedDir)} does not exist. Run the plugin's package script first.`);
  }
  const packaged = JSON.parse(readFileSync(packagedManifest, "utf8"));
  if (packaged.frontend?.entryModule !== "./frontend/index.js") {
    fail(`${packagedManifest} has frontend.entryModule "${packaged.frontend?.entryModule}"; expected "./frontend/index.js". Package again.`);
  }
}

function fail(message) {
  console.error(`dev-frontend: ${message}`);
  process.exit(1);
}
