// Builds the plugin catalog (catalog/list.json) from GitHub Releases. See specs/plugin-catalog.md.
//
// buildCatalog takes the releases and a download function, so it runs without the network in tests;
// generate-catalog.mjs is the command that fetches them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { readZip } from "./zip.mjs";

export const CATALOG_SCHEMA_VERSION = 1;

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TAG = /^([a-z0-9-]+)\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

let validators;

/**
 * @param {object} options
 * @param {string} options.repository e.g. "https://github.com/kuseman/queryeer-desktop-plugins"
 * @param {object[]} options.releases GitHub release objects (tag_name, draft, prerelease, published_at, html_url, assets)
 * @param {(url: string) => Promise<Buffer>} options.download
 * @param {object | null} [options.previous] the catalog published before, whose entries are reused
 * @param {Date} [options.now]
 * @returns {Promise<{ catalog: object, warnings: string[], reused: number, downloaded: number }>}
 */
export async function buildCatalog({ repository, releases, download, previous = null, now = new Date() }) {
  const warnings = [];
  const previousByUrl = previousVersionsByUrl(previous, warnings);
  const plugins = new Map();
  let reused = 0;
  let downloaded = 0;

  for (const release of releases) {
    if (release.draft) {
      continue;
    }
    const tag = TAG.exec(release.tag_name ?? "");
    if (!tag) {
      warnings.push(`${release.tag_name}: skipped, not a <short-name>/v<version> tag`);
      continue;
    }
    const version = tag[2];
    const assets = release.assets ?? [];
    const zips = assets.filter((asset) => asset.name.endsWith(`-${version}.zip`));
    if (zips.length !== 1) {
      warnings.push(`${release.tag_name}: skipped, it has ${zips.length} assets named *-${version}.zip, expected one`);
      continue;
    }
    const [zip] = zips;
    const shaAsset = assets.find((asset) => asset.name === `${zip.name}.sha256`);
    if (!shaAsset) {
      warnings.push(`${release.tag_name}: skipped, ${zip.name}.sha256 is missing`);
      continue;
    }

    const expectedSha256 = parseSha256File((await download(shaAsset.browser_download_url)).toString("utf8"), shaAsset.name);
    const releaseFields = {
      prerelease: Boolean(release.prerelease),
      ...(release.published_at ? { publishedAt: release.published_at } : {}),
      url: zip.browser_download_url,
      sha256: expectedSha256,
      size: zip.size,
      ...(release.html_url ? { releaseNotesUrl: release.html_url } : {})
    };

    let entry;
    const earlier = previousByUrl.get(zip.browser_download_url);
    if (earlier && earlier.sha256 === expectedSha256 && earlier.size === zip.size && earlier.version === version) {
      entry = { version, ...releaseFields, manifest: earlier.manifest };
      reused++;
    } else {
      const buffer = await download(zip.browser_download_url);
      downloaded++;
      const actual = createHash("sha256").update(buffer).digest("hex");
      if (actual !== expectedSha256) {
        throw new Error(`${release.tag_name}: ${zip.name} has sha256 ${actual}, but ${shaAsset.name} says ${expectedSha256}`);
      }
      entry = { version, ...releaseFields, size: buffer.length, manifest: readManifest(buffer, release.tag_name) };
    }

    const { manifest } = entry;
    const problems = [];
    if (manifest.version !== version) {
      problems.push(`plugin.json has version ${manifest.version}, the tag ${version}`);
    }
    if (zip.name !== `${manifest.id}-${version}.zip`) {
      problems.push(`the ZIP is named ${zip.name}, but plugin.json makes it ${manifest.id}-${manifest.version}.zip`);
    }
    if (problems.length > 0) {
      throw new Error(`${release.tag_name}: ${problems.join("; ")}`);
    }

    const plugin = plugins.get(manifest.id) ?? { id: manifest.id, versions: [] };
    if (plugin.versions.some((existing) => existing.version === version)) {
      throw new Error(`${release.tag_name}: ${manifest.id} ${version} is released twice`);
    }
    plugin.versions.push(entry);
    plugins.set(manifest.id, plugin);
  }

  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    plugins: [...plugins.values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map((plugin) => {
        const versions = plugin.versions.sort((a, b) => compareVersions(b.version, a.version));
        const named = (versions.find((entry) => !entry.prerelease) ?? versions[0]).manifest;
        return {
          id: plugin.id,
          name: named.name,
          ...(named.description ? { description: named.description } : {}),
          repository,
          versions
        };
      })
  };

  const problems = validateCatalog(catalog);
  if (problems.length > 0) {
    throw new Error(`The catalog is invalid:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  }
  return { catalog, warnings, reused, downloaded };
}

/** Schema problems in a catalog, empty when it is valid. */
export function validateCatalog(catalog) {
  const { catalog: validate } = getValidators();
  return validate(catalog) ? [] : validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
}

/** SemVer precedence: negative when a is older than b. Build metadata is not supported (no plugin uses it). */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i] - right.core[i];
    }
  }
  // A version without prerelease ranks above the same version with one
  if (!left.pre || !right.pre) {
    return (left.pre ? -1 : 0) - (right.pre ? -1 : 0);
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) {
        return Number(x) - Number(y);
      }
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return compareText(x, y);
    }
  }
  return 0;
}

function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`${version} is not a version like 1.2.3 or 1.2.3-beta.1`);
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseSha256File(text, name) {
  const sha256 = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new Error(`${name} does not start with a sha256`);
  }
  return sha256;
}

function readManifest(buffer, tag) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    throw new Error(`${tag}: the ZIP can't be read: ${error.message}`);
  }
  const data = entries.get("plugin.json");
  if (!data) {
    throw new Error(`${tag}: plugin.json is not at the ZIP's root`);
  }
  let manifest;
  try {
    manifest = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(`${tag}: plugin.json is not JSON: ${error.message}`);
  }
  const { manifest: validate } = getValidators();
  if (!validate(manifest)) {
    const problems = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new Error(`${tag}: plugin.json is invalid: ${problems.join("; ")}`);
  }
  const { $schema, ...rest } = manifest;
  return rest;
}

function previousVersionsByUrl(previous, warnings) {
  const byUrl = new Map();
  if (!previous) {
    return byUrl;
  }
  if (previous.schemaVersion !== CATALOG_SCHEMA_VERSION || validateCatalog(previous).length > 0) {
    warnings.push("The published catalog is not a valid format 1 catalog; every ZIP is downloaded again");
    return byUrl;
  }
  for (const plugin of previous.plugins) {
    for (const version of plugin.versions) {
      byUrl.set(version.url, version);
    }
  }
  return byUrl;
}

function getValidators() {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const load = (name) => JSON.parse(readFileSync(join(repoRoot, "shared", "schema", name), "utf8"));
    validators = {
      manifest: ajv.compile(load("plugin.json.schema.v1.json")),
      catalog: ajv.compile(load("catalog.schema.v1.json"))
    };
  }
  return validators;
}
