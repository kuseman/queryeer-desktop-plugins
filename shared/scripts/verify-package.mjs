// Verifies an installable plugin ZIP without Docker or Queryeer.
//
//   node shared/scripts/verify-package.mjs dist/com.queryeer.mongodb-0.1.0.zip [--expect-jar <prefix> ...]
//   node shared/scripts/verify-package.mjs plugins/mongodb [--expect-jar <prefix> ...]
//
// Given a plugin folder, it verifies that plugin's ZIP in dist/, named after its plugin.json id and version.
//
// Checks: plugin.json at the archive root and valid against the vendored v1 schema, file name matches
// <id>-<version>.zip, safe entry names, no backend.classpath, backend jars under lib/ (including the
// plugin's own jar), no bundled copy of what Queryeer provides (its API, built-in engine libraries, JDBC
// drivers), the frontend entry module exists when declared, and the .sha256 file matches.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { readZip } from "./zip.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const args = process.argv.slice(2);
const zipPath = packagePath(resolve(args[0] ?? fail("Usage: verify-package.mjs <zip | plugin folder> [--expect-jar <prefix> ...]")));
const expectedJars = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--expect-jar") {
    expectedJars.push(args[++i]);
  }
}

const problems = [];
const buffer = readFileSync(zipPath);
const entries = readZip(buffer);
const names = [...entries.keys()];

for (const name of names) {
  if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) {
    problems.push(`unsafe entry name: ${name}`);
  }
}

const manifestData = entries.get("plugin.json");
let manifest;
if (!manifestData) {
  problems.push("plugin.json is not at the archive root");
} else {
  manifest = JSON.parse(manifestData.toString("utf8"));
  const schema = JSON.parse(readFileSync(join(repoRoot, "shared", "schema", "plugin.json.schema.v1.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    for (const error of validate.errors) {
      problems.push(`plugin.json ${error.instancePath || "/"} ${error.message}`);
    }
  }

  const expectedName = `${manifest.id}-${manifest.version}.zip`;
  if (basename(zipPath) !== expectedName) {
    problems.push(`file name ${basename(zipPath)} should be ${expectedName}`);
  }
  // runtime.shared (parent-first driver packages, native libraries to preload) applies to installed plugins since
  // Queryeer 0.24. The schema check above covers it; the backend validates it again when it reads the manifest.

  if (manifest.backend) {
    if (manifest.backend.classpath) {
      problems.push("backend.classpath must not be set; jars are loaded from lib/");
    }
    const jars = names.filter((n) => n.startsWith("lib/") && n.endsWith(".jar"));
    if (jars.length === 0) {
      problems.push("backend declared but lib/ contains no jars");
    }
    for (const prefix of expectedJars) {
      if (!jars.some((jar) => basename(jar).startsWith(prefix))) {
        problems.push(`lib/ is missing a jar starting with ${prefix}`);
      }
    }
    const strays = names.filter((n) => n.endsWith(".jar") && !n.startsWith("lib/"));
    for (const stray of strays) {
      problems.push(`jar outside lib/: ${stray}`);
    }
    // A bundled copy of a class the host or another plugin provides is a different class at runtime: services are not
    // found and casts fail. JDBC drivers come from core's driver service in libShared, never from the plugin.
    for (const jar of jars) {
      const reason = providedElsewhere(basename(jar));
      if (reason) {
        problems.push(`lib/${basename(jar)} must not be bundled: ${reason}`);
      }
    }
  }

  if (manifest.frontend) {
    const entry = manifest.frontend.entryModule.replace(/^\.\//, "");
    if (!entries.has(entry)) {
      problems.push(`frontend.entryModule ${manifest.frontend.entryModule} is not in the archive`);
    }
  }
}

const shaPath = `${zipPath}.sha256`;
if (existsSync(shaPath)) {
  const expected = readFileSync(shaPath, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (expected !== actual) {
    problems.push(`sha256 mismatch: ${basename(shaPath)} says ${expected}, archive is ${actual}`);
  }
} else {
  problems.push(`${basename(shaPath)} is missing next to the archive (${dirname(zipPath)})`);
}

if (problems.length > 0) {
  console.error(`verify-package: ${basename(zipPath)} has ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(`verify-package: ${basename(zipPath)} OK (${names.length} entries)`);

/** Why a jar must not be in a plugin's lib/, or null when it may be. */
function providedElsewhere(jarName) {
  const provided = [
    [/^backend-(api|contract)-/, "Queryeer provides its plugin API (use provided scope)"],
    [/^backend-lib-queryengine-/, "Queryeer's built-in query engines provide it (use provided scope)"],
    [/^(mariadb-java-client|mysql-connector-j|postgresql|mssql-jdbc|sqlite-jdbc|ojdbc\d*|h2|duckdb_jdbc)-\d/, "JDBC drivers are installed by Queryeer's driver service into libShared"]
  ];
  return provided.find(([pattern]) => pattern.test(jarName))?.[1] ?? null;
}

/** The ZIP itself, or for a plugin folder the ZIP the packager writes for it: dist/<id>-<version>.zip. */
function packagePath(path) {
  const manifestPath = join(path, "plugin.json");
  if (!existsSync(manifestPath)) {
    return path;
  }
  const { id, version } = JSON.parse(readFileSync(manifestPath, "utf8"));
  return join(repoRoot, "dist", `${id}-${version}.zip`);
}

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exit(1);
}
