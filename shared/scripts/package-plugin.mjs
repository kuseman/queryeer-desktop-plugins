// Assembles an installable plugin ZIP from a plugin folder.
//
//   node shared/scripts/package-plugin.mjs plugins/mongodb
//
// Expects the backend to be built already (Maven `package`, which copies runtime dependencies to
// backend/target/lib) and, when plugin.json declares a frontend, the bundle at frontend/dist/index.js.
//
// Produces, at the repository root:
//   dist/<id>-<version>/          unpacked package (usable as a local development folder)
//   dist/<id>-<version>.zip       installable package, plugin.json at the archive root
//   dist/<id>-<version>.zip.sha256
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const pluginDir = resolve(process.argv[2] ?? fail("Usage: package-plugin.mjs <plugin folder>"));

const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
const { id, version } = manifest;
const packageName = `${id}-${version}`;
const distDir = join(repoRoot, "dist");
const stageDir = join(distDir, packageName);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const packaged = { ...manifest };
delete packaged.$schema;

if (manifest.backend) {
  if (manifest.backend.classpath) {
    fail("backend.classpath is not supported for packaged plugins; jars are loaded from lib/ by convention");
  }
  const targetDir = join(pluginDir, "backend", "target");
  const pluginJars = existsSync(targetDir)
    ? readdirSync(targetDir).filter((f) => f.endsWith(".jar") && !f.startsWith("original-") && !f.endsWith("-sources.jar") && !f.endsWith("-tests.jar"))
    : [];
  if (pluginJars.length !== 1) {
    fail(`Expected exactly one plugin jar in ${relative(repoRoot, targetDir)}, found ${pluginJars.length}. Build the backend first.`);
  }
  if (!pluginJars[0].endsWith(`-${version}.jar`)) {
    fail(`Backend jar ${pluginJars[0]} does not match plugin.json version ${version}. Keep the pom <version> and plugin.json "version" in sync.`);
  }
  const libDir = join(stageDir, "lib");
  mkdirSync(libDir, { recursive: true });
  cpSync(join(targetDir, pluginJars[0]), join(libDir, pluginJars[0]));
  const depsDir = join(targetDir, "lib");
  if (existsSync(depsDir)) {
    for (const jar of readdirSync(depsDir).filter((f) => f.endsWith(".jar"))) {
      cpSync(join(depsDir, jar), join(libDir, jar));
    }
  }
}

if (manifest.frontend) {
  const bundle = join(pluginDir, "frontend", "dist", "index.js");
  if (!existsSync(bundle)) {
    fail(`Frontend bundle ${relative(repoRoot, bundle)} not found. Build the frontend first.`);
  }
  mkdirSync(join(stageDir, "frontend"), { recursive: true });
  cpSync(bundle, join(stageDir, "frontend", "index.js"));
  packaged.frontend = { ...manifest.frontend, entryModule: "./frontend/index.js" };
}

writeFileSync(join(stageDir, "plugin.json"), JSON.stringify(packaged, null, 2) + "\n");

const zipPath = join(distDir, `${packageName}.zip`);
const zip = createZip(listFiles(stageDir).map((file) => ({ name: relative(stageDir, file).split("\\").join("/"), data: readFileSync(file) })));
writeFileSync(zipPath, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${basename(zipPath)}\n`);

console.log(`Packaged ${id} ${version}`);
console.log(`  folder: ${relative(repoRoot, stageDir)}`);
console.log(`  zip:    ${relative(repoRoot, zipPath)}`);
console.log(`  sha256: ${sha256}`);

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

function fail(message) {
  console.error(`package-plugin: ${message}`);
  process.exit(1);
}
