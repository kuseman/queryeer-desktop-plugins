// Reads, checks or sets a plugin's version. It lives in three places that must agree:
//   plugins/<name>/plugin.json             "version" (the packager names the ZIP after it)
//   plugins/<name>/backend/pom.xml         the module's own <version> (the packager refuses a JAR with another version)
//   plugins/<name>/frontend/package.json   "version", and its entry in the root package-lock.json
//
//   node shared/scripts/plugin-version.mjs plugins/<name>                  prints the version; fails when the places disagree
//   node shared/scripts/plugin-version.mjs plugins/<name> --expect 1.2.3   also fails unless the version is 1.2.3
//   node shared/scripts/plugin-version.mjs plugins/<name> --set 1.2.3      writes 1.2.3 to every place
//
// Places a plugin does not have (no backend, no frontend) are skipped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const [pluginArg, option, value] = process.argv.slice(2);
if (!pluginArg || (option && !["--expect", "--set"].includes(option)) || (option && !value)) {
  fail("Usage: plugin-version.mjs plugins/<name> [--expect <version> | --set <version>]");
}
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (value && !SEMVER.test(value)) {
  fail(`${value} is not a version like 1.2.3 or 1.2.3-beta.1`);
}

const pluginDir = resolve(repoRoot, pluginArg);
const pluginPath = relative(repoRoot, pluginDir).replace(/\\/g, "/");
const places = [manifestPlace(), pomPlace(), packagePlace(), lockPlace()].filter(Boolean);

if (option === "--set") {
  for (const place of places) {
    place.write(value);
  }
  console.log(`Set ${pluginPath} to ${value}:`);
  for (const place of places) {
    console.log(`  ${place.name}`);
  }
}

const found = places.map((place) => ({ name: place.name, version: place.read() }));
const versions = new Set(found.map((place) => place.version));
if (versions.size !== 1) {
  fail(`${pluginPath} has different versions:\n${found.map((place) => `  ${place.name}: ${place.version}`).join("\n")}`);
}
const [version] = versions;
if (option === "--expect" && version !== value) {
  fail(`${pluginPath} is at ${version}, expected ${value}. Run the Create Plugin Release workflow so the version is committed before tagging.`);
}
if (option !== "--set") {
  console.log(version);
}

function manifestPlace() {
  const file = join(pluginDir, "plugin.json");
  if (!existsSync(file)) {
    fail(`${relative(repoRoot, file)} not found`);
  }
  return jsonPlace(file, (json) => json, "version");
}

function packagePlace() {
  const file = join(pluginDir, "frontend", "package.json");
  return existsSync(file) ? jsonPlace(file, (json) => json, "version") : undefined;
}

function lockPlace() {
  const file = join(repoRoot, "package-lock.json");
  const key = `${pluginPath}/frontend`;
  if (!existsSync(join(pluginDir, "frontend", "package.json")) || !existsSync(file)) {
    return undefined;
  }
  const place = jsonPlace(file, (json) => json.packages?.[key], "version");
  return { ...place, name: `${place.name} (${key})` };
}

/** A "version" field in a JSON file, written back with the file's own indentation and line endings. */
function jsonPlace(file, select, field) {
  const name = relative(repoRoot, file).replace(/\\/g, "/");
  const read = () => {
    const holder = select(JSON.parse(readFileSync(file, "utf8")));
    if (!holder || typeof holder[field] !== "string") {
      fail(`${name} has no "${field}"`);
    }
    return holder[field];
  };
  const write = (version) => {
    const text = readFileSync(file, "utf8");
    const json = JSON.parse(text);
    select(json)[field] = version;
    const indent = /^[ \t]+/m.exec(text)?.[0] ?? "  ";
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    writeFileSync(file, JSON.stringify(json, null, indent).replace(/\n/g, eol) + eol);
  };
  return { name, read, write };
}

/** The module's own <version>: the first one after </parent>, or after <artifactId> when there is no parent. */
function pomPlace() {
  const file = join(pluginDir, "backend", "pom.xml");
  if (!existsSync(file)) {
    return undefined;
  }
  const name = relative(repoRoot, file).replace(/\\/g, "/");
  const locate = (text) => {
    const start = text.includes("</parent>") ? text.indexOf("</parent>") : text.indexOf("<artifactId>");
    const match = /<version>([^<]+)<\/version>/.exec(text.slice(start));
    if (start < 0 || !match) {
      fail(`${name} has no project <version>`);
    }
    return { index: start + match.index, match };
  };
  return {
    name,
    read: () => locate(readFileSync(file, "utf8")).match[1].trim(),
    write: (version) => {
      const text = readFileSync(file, "utf8");
      const { index, match } = locate(text);
      writeFileSync(file, text.slice(0, index) + `<version>${version}</version>` + text.slice(index + match[0].length));
    }
  };
}

function fail(message) {
  console.error(`plugin-version: ${message}`);
  process.exit(1);
}
