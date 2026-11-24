// node --test shared/scripts/catalog.test.mjs
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCatalog, compareVersions, validateCatalog } from "./catalog.mjs";
import { createZip } from "./zip.mjs";

const REPOSITORY = "https://github.com/owner/plugins";
const NOW = new Date("2026-11-24T12:00:00.000Z");

/** A release of a plugin whose ZIP holds the given manifest, and the downloads it serves. */
function release(shortName, manifest, { prerelease = false, zipName, sha256, extraManifest = {} } = {}) {
  const fullManifest = { $schema: "../../shared/schema/plugin.json.schema.v1.json", schemaVersion: 1, name: "Plugin", backend: { entrypointClass: "x.Plugin" }, ...manifest, ...extraManifest };
  const zip = createZip([{ name: "plugin.json", data: Buffer.from(JSON.stringify(fullManifest)) }]);
  const tag = `${shortName}/v${manifest.version}`;
  const name = zipName ?? `${manifest.id}-${manifest.version}.zip`;
  const base = `https://github.com/owner/plugins/releases/download/${tag}`;
  const hash = sha256 ?? createHash("sha256").update(zip).digest("hex");
  return {
    release: {
      tag_name: tag,
      draft: false,
      prerelease,
      published_at: "2026-11-20T09:00:00Z",
      html_url: `https://github.com/owner/plugins/releases/tag/${tag}`,
      assets: [
        { name, size: zip.length, browser_download_url: `${base}/${name}` },
        { name: `${name}.sha256`, size: 80, browser_download_url: `${base}/${name}.sha256` }
      ]
    },
    files: {
      [`${base}/${name}`]: zip,
      [`${base}/${name}.sha256`]: Buffer.from(`${hash}  ${name}\n`)
    }
  };
}

function build(releases, previous = null) {
  const files = Object.assign({}, ...releases.map((entry) => entry.files));
  const requested = [];
  const download = async (url) => {
    requested.push(url);
    if (!files[url]) {
      throw new Error(`unexpected download ${url}`);
    }
    return files[url];
  };
  return buildCatalog({ repository: REPOSITORY, releases: releases.map((entry) => entry.release), download, previous, now: NOW }).then(
    (result) => ({ ...result, requested })
  );
}

describe("buildCatalog", () => {
  test("lists each plugin with its versions newest first and the manifest without $schema", async () => {
    const { catalog, warnings } = await build([
      release("mongodb", { id: "com.queryeer.mongodb", version: "0.2.0", name: "MongoDB old" }),
      release("mongodb", { id: "com.queryeer.mongodb", version: "0.10.0", name: "MongoDB", description: "Mongo" }),
      release("mongodb", { id: "com.queryeer.mongodb", version: "0.11.0-beta.1", name: "MongoDB beta" }, { prerelease: true }),
      release("kafka", { id: "com.queryeer.kafka", version: "0.1.0", name: "Kafka" })
    ]);

    assert.deepEqual(warnings, []);
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.generatedAt, "2026-11-24T12:00:00.000Z");
    assert.deepEqual(catalog.plugins.map((plugin) => plugin.id), ["com.queryeer.kafka", "com.queryeer.mongodb"]);

    const mongodb = catalog.plugins[1];
    assert.deepEqual(mongodb.versions.map((entry) => entry.version), ["0.11.0-beta.1", "0.10.0", "0.2.0"]);
    // Named after the newest stable version, not the prerelease
    assert.equal(mongodb.name, "MongoDB");
    assert.equal(mongodb.description, "Mongo");
    assert.equal(mongodb.repository, REPOSITORY);

    const [beta, stable] = mongodb.versions;
    assert.equal(beta.prerelease, true);
    assert.equal(stable.prerelease, false);
    assert.equal(stable.url, "https://github.com/owner/plugins/releases/download/mongodb/v0.10.0/com.queryeer.mongodb-0.10.0.zip");
    assert.match(stable.sha256, /^[0-9a-f]{64}$/);
    assert.equal(stable.releaseNotesUrl, "https://github.com/owner/plugins/releases/tag/mongodb/v0.10.0");
    assert.equal(stable.publishedAt, "2026-11-20T09:00:00Z");
    assert.deepEqual(stable.manifest, {
      schemaVersion: 1,
      name: "MongoDB",
      backend: { entrypointClass: "x.Plugin" },
      id: "com.queryeer.mongodb",
      version: "0.10.0",
      description: "Mongo"
    });
    assert.deepEqual(validateCatalog(catalog), []);
  });

  test("names a plugin after its newest version when it has no stable one", async () => {
    const { catalog } = await build([release("es", { id: "com.queryeer.es", version: "1.0.0-rc.1", name: "ES rc" }, { prerelease: true })]);

    assert.equal(catalog.plugins[0].name, "ES rc");
  });

  test("keeps the compatibility fields of the manifest", async () => {
    const dependencies = [{ id: "queryengine.jdbc", version: ">=0.20.0 <1.0.0" }];
    const { catalog } = await build([
      release("mysql", { id: "com.queryeer.jdbc.mysql", version: "0.1.0" }, {
        extraManifest: {
          dependencies,
          requiredCapabilities: ["queryengine.jdbc.connection"],
          backend: { entrypointClass: "x.Plugin", minJavaVersion: "25" },
          frontend: { entryModule: "./frontend/dist/index.js", moduleFormat: "esm", apiVersion: ">=0.20.0 <1.0.0" }
        }
      })
    ]);

    const { manifest } = catalog.plugins[0].versions[0];
    assert.deepEqual(manifest.dependencies, dependencies);
    assert.equal(manifest.frontend.apiVersion, ">=0.20.0 <1.0.0");
    assert.equal(manifest.backend.minJavaVersion, "25");
  });

  test("skips drafts and releases that are not plugin releases, with a warning for the latter", async () => {
    const draft = release("kafka", { id: "com.queryeer.kafka", version: "0.2.0" });
    draft.release.draft = true;
    const otherTag = release("kafka", { id: "com.queryeer.kafka", version: "0.3.0" });
    otherTag.release.tag_name = "v0.3.0";
    const noChecksum = release("kafka", { id: "com.queryeer.kafka", version: "0.4.0" });
    noChecksum.release.assets.pop();

    const { catalog, warnings } = await build([draft, otherTag, noChecksum, release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" })]);

    assert.deepEqual(catalog.plugins[0].versions.map((entry) => entry.version), ["0.1.0"]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /^v0\.3\.0: skipped/);
    assert.match(warnings[1], /^kafka\/v0\.4\.0: skipped, com\.queryeer\.kafka-0\.4\.0\.zip\.sha256 is missing/);
  });

  test("reuses a published entry with the same URL, sha256 and size without downloading the ZIP", async () => {
    const first = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" });
    const { catalog: previous } = await build([first]);

    const second = release("kafka", { id: "com.queryeer.kafka", version: "0.2.0" });
    const { catalog, reused, downloaded, requested } = await build([second, first], previous);

    assert.equal(reused, 1);
    assert.equal(downloaded, 1);
    assert.ok(!requested.includes(first.release.assets[0].browser_download_url));
    assert.deepEqual(catalog.plugins[0].versions[1], previous.plugins[0].versions[0]);
  });

  test("downloads the ZIP again when the published entry's sha256 differs", async () => {
    const first = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" });
    const { catalog: previous } = await build([first]);
    previous.plugins[0].versions[0].sha256 = "0".repeat(64);

    const { reused, downloaded } = await build([first], previous);

    assert.equal(reused, 0);
    assert.equal(downloaded, 1);
  });

  test("ignores a published catalog that is not format 1", async () => {
    const { downloaded, warnings } = await build([release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" })], { schemaVersion: 2, plugins: [] });

    assert.equal(downloaded, 1);
    assert.match(warnings[0], /not a valid format 1 catalog/);
  });

  test("fails when a ZIP does not match its .sha256 file", async () => {
    await assert.rejects(build([release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" }, { sha256: "a".repeat(64) })]), /has sha256 [0-9a-f]{64}, but com\.queryeer\.kafka-0\.1\.0\.zip\.sha256 says a{64}/);
  });

  test("fails when plugin.json's version differs from the tag", async () => {
    const mismatch = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" }, { extraManifest: { version: "0.1.1" } });

    await assert.rejects(build([mismatch]), /kafka\/v0\.1\.0: plugin\.json has version 0\.1\.1, the tag 0\.1\.0/);
  });

  test("fails when the ZIP is not named after plugin.json's id", async () => {
    const misnamed = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" }, { zipName: "kafka-0.1.0.zip" });

    await assert.rejects(build([misnamed]), /the ZIP is named kafka-0\.1\.0\.zip, but plugin\.json makes it com\.queryeer\.kafka-0\.1\.0\.zip/);
  });

  test("fails when plugin.json is invalid", async () => {
    const invalid = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" }, { extraManifest: { schemaVersion: 2 } });

    await assert.rejects(build([invalid]), /kafka\/v0\.1\.0: plugin\.json is invalid/);
  });

  test("fails when one plugin version is released twice", async () => {
    const one = release("kafka", { id: "com.queryeer.kafka", version: "0.1.0" });
    const two = release("kafka-again", { id: "com.queryeer.kafka", version: "0.1.0" });

    await assert.rejects(build([one, two]), /com\.queryeer\.kafka 0\.1\.0 is released twice/);
  });
});

describe("compareVersions", () => {
  test("orders by SemVer precedence", () => {
    const ordered = ["0.1.0", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "0.10.0", "1.0.0"];
    const shuffled = [...ordered].reverse();

    assert.deepEqual(shuffled.sort(compareVersions), ordered);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  test("rejects a version that is not SemVer", () => {
    assert.throws(() => compareVersions("1.2", "1.2.0"), /1\.2 is not a version/);
  });
});
