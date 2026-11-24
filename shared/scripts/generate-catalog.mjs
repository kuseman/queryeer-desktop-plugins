// Builds the plugin catalog from this repository's GitHub Releases. See specs/plugin-catalog.md.
//
//   node shared/scripts/generate-catalog.mjs [--repo <owner/name>] [--previous <url | file>] [--out <file>]
//
//   --repo      defaults to GITHUB_REPOSITORY, then to kuseman/queryeer-desktop-plugins
//   --previous  the catalog published before; its entries are reused, so unchanged ZIPs are not downloaded again.
//               A missing or unreadable one only means every ZIP is downloaded.
//   --out       defaults to dist/pages/catalog/list.json
//
// GITHUB_TOKEN, when set, authenticates the API calls (a public repository works without it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "./catalog.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const options = parseArgs(process.argv.slice(2));
const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "kuseman/queryeer-desktop-plugins";
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  fail(`--repo ${repo} is not <owner>/<name>`);
}
const outPath = resolve(repoRoot, options.out ?? "dist/pages/catalog/list.json");
const token = process.env.GITHUB_TOKEN;

try {
  const releases = await listReleases();
  const previous = options.previous ? await readPrevious(options.previous) : null;
  const { catalog, warnings, reused, downloaded } = await buildCatalog({
    repository: `https://github.com/${repo}`,
    releases,
    download,
    previous
  });
  for (const warning of warnings) {
    console.warn(process.env.GITHUB_ACTIONS ? `::warning::${warning}` : `warning: ${warning}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

  console.log(`Wrote ${relative(repoRoot, outPath).replace(/\\/g, "/")}: ${downloaded} ZIPs downloaded, ${reused} reused`);
  for (const plugin of catalog.plugins) {
    console.log(`  ${plugin.id}: ${plugin.versions.map((entry) => entry.version + (entry.prerelease ? " (prerelease)" : "")).join(", ")}`);
  }
} catch (error) {
  fail(error.message);
}

async function listReleases() {
  const releases = [];
  for (let page = 1; ; page++) {
    const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    });
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) {
      return releases;
    }
  }
}

async function download(url) {
  // Release asset URLs redirect to a storage host; the token stays with the API calls
  const response = await request(url, { Accept: "application/octet-stream" });
  return Buffer.from(await response.arrayBuffer());
}

async function readPrevious(source) {
  try {
    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source, { headers: { "User-Agent": "queryeer-plugin-catalog" } });
      if (response.status === 404) {
        console.log(`No catalog at ${source} yet; every ZIP is downloaded`);
        return null;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    }
    const path = resolve(source);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch (error) {
    console.warn(`warning: the published catalog can't be read (${error.message}); every ZIP is downloaded`);
    return null;
  }
}

async function request(url, headers) {
  const response = await fetch(url, { headers: { "User-Agent": "queryeer-plugin-catalog", ...headers } });
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return response;
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const name = { "--repo": "repo", "--previous": "previous", "--out": "out" }[args[i]];
    if (!name || args[i + 1] === undefined) {
      fail("Usage: generate-catalog.mjs [--repo <owner/name>] [--previous <url | file>] [--out <file>]");
    }
    parsed[name] = args[++i];
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
