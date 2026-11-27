# Plugin catalog

Status: format 1, implemented 2026-11-24. The catalog is published from this repository; Queryeer Desktop's release reads it from 0.24 to pick the plugins it bundles.

The catalog is one JSON file that lists every released plugin version with where to download it and its sha256. It is the contract between plugin distribution and its readers:

- **Queryeer Desktop's release** reads it to pick the plugins it bundles (queryeer-desktop#228): the newest compatible version of each bundled plugin, downloaded and checked at release time.
- **Queryeer** reads it later to list plugins and offer updates (the marketplace, [v1 milestone](v1-milestone.md) Phase 2).

Readers never call GitHub's release API and never use `/releases/latest`, which GitHub keeps per repository, not per plugin.

## Where it is

```text
https://kuseman.github.io/queryeer-desktop-plugins/catalog/list.json
```

- **GitHub Pages, deployed by Actions:** nothing is committed. Each deploy builds the catalog again from this repository's GitHub Releases, so it always matches what is released, and a failed deploy is repaired by the next.
- **When:** [release-plugin.yml](../.github/workflows/release-plugin.yml) starts [publish-catalog.yml](../.github/workflows/publish-catalog.yml) on `master` after it publishes a release. Run it by hand to rebuild.
  - A dispatch rather than a job in the release workflow: the release runs on its tag, and the `github-pages` environment deploys only from `master`.
- **One-time setup:** Settings → Pages → Build and deployment → Source: **GitHub Actions**.

## Format

[`shared/schema/catalog.schema.v1.json`](../shared/schema/catalog.schema.v1.json) validates it. An example with one plugin:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T12:00:00.000Z",
  "plugins": [
    {
      "id": "com.queryeer.mongodb",
      "name": "MongoDB",
      "description": "MongoDB query engine and payloadbuilder catalog",
      "repository": "https://github.com/kuseman/queryeer-desktop-plugins",
      "versions": [
        {
          "version": "0.3.0",
          "prerelease": false,
          "publishedAt": "2026-11-20T09:12:44Z",
          "url": "https://github.com/kuseman/queryeer-desktop-plugins/releases/download/mongodb/v0.3.0/com.queryeer.mongodb-0.3.0.zip",
          "sha256": "<64 hex characters>",
          "size": 4211533,
          "releaseNotesUrl": "https://github.com/kuseman/queryeer-desktop-plugins/releases/tag/mongodb/v0.3.0",
          "manifest": { "schemaVersion": 1, "id": "com.queryeer.mongodb", "name": "MongoDB", "version": "0.3.0", "...": "..." }
        }
      ]
    }
  ]
}
```

- `plugins` is sorted by `id`. Each plugin's `versions` are sorted newest first by SemVer and include prereleases. Every released version stays listed, so a reader can choose an older compatible version or roll back.
- A plugin's `name` and `description` are its newest stable version's, or the newest version's when it has no stable one.
- `manifest` is the `plugin.json` inside that version's ZIP, without `$schema`.
  - Compatibility is read from it, without downloading the ZIP: `dependencies` (with version ranges), `requiredCapabilities`, `frontend.apiVersion`, `backend.minJavaVersion`.
  - A reader evaluates it with the same rules as an installed plugin's manifest, so the two never disagree. That is why the catalog has no `minApiVersion` of its own, unlike the first draft in the README.
- `sha256` is the ZIP's, in lowercase hex, and `size` its length in bytes.
- **Compatible changes** within format 1 only add optional fields. Readers ignore fields they don't know. A reader that finds a higher `schemaVersion` treats the catalog as unavailable rather than guessing.

## How it is built

[`generate-catalog.mjs`](../shared/scripts/generate-catalog.mjs), with the rules in [`catalog.mjs`](../shared/scripts/catalog.mjs):

1. It lists the repository's GitHub Releases. Drafts are skipped. A tag that is not `<short-name>/v<semver>`, or a release without exactly one `<id>-<version>.zip` and its `.sha256`, is skipped with a warning: it is not a plugin release.
2. For each plugin release, it reads the `.sha256` asset.
   - When the published catalog already lists that ZIP URL with the same sha256 and size, its entry is reused: a release's assets never change, because the release workflow refuses a tag that already has a release.
   - Otherwise it downloads the ZIP, hashes it, and reads and validates its `plugin.json` against the vendored manifest schema.
3. **It fails, and publishes nothing,** when:
   - a ZIP's hash differs from its `.sha256` asset;
   - `plugin.json` is missing or invalid;
   - the ZIP's name, the manifest's id and version, and the tag's version disagree;
   - two releases carry the same plugin id and version.

   These mean a release was changed after publishing or by hand. Fix the release; don't work around it in the generator.
4. It validates its output against the catalog schema and writes `dist/pages/catalog/list.json`.

Run it locally with `npm run catalog:generate`. It needs no token for a public repository; with `GITHUB_TOKEN` set it uses it for the API calls. `npm run catalog:test` runs its tests.

## How readers use it

### Queryeer Desktop's release (bundling)

Implemented by `queryeer-desktop/packages/app/scripts/bundle-plugins.mjs`, for the ids in `packages/app/bundled-plugins.json`:

1. Read the catalog. Fail the release when it can't be read or its `schemaVersion` is unknown.
2. For each bundled plugin id, take the newest version that:
   - is not a prerelease
   - is compatible with the app being released, by its `manifest`: `frontend.apiVersion` and the version ranges of required dependencies against the release version (a dependency on another bundled plugin against the version chosen for it), and `backend.minJavaVersion` against the Java the release ships. `requiredCapabilities` aren't checked.

   A plugin that isn't in the catalog or has no compatible version fails the release, so release a plugin before the core release that bundles it.
3. Download the ZIP from `url` and check it against `sha256` and `size`; fail the release on a mismatch.
4. Write the ZIPs and `bundled-plugins.lock.json` (`{ "schemaVersion": 1, "plugins": [{ "id", "version", "file", "sha256", "url" }] }`, `file` being the ZIP's name next to the lock), which ship with the release. One job of the release picks them, and every platform build copies that bundle, so all platforms ship the same versions. The recover workflows republish the release's installers and never pick again.
5. A bundled plugin can only use core API that was already released, because core publishes its Maven and npm API in the same release run. A plugin that needs new core API is bundled from the next core release on.

### Queryeer (updates and the marketplace, later)

The same steps without the release: offer the newest compatible version that is newer than the installed one. The README's open questions still apply: prerelease opt-in, rollback and downgrades, and the catalog's trust model.

## Trust

- The catalog is served over HTTPS from this repository's Pages site, and each ZIP is checked against the catalog's sha256 before it is used. Someone who can change this repository's releases or Pages can change both, so the catalog is only as trusted as the repository.
- Signing is not designed yet (README, "GitHub Releases Follow-up"). Format 1 leaves room for it: a signature can be a separate file next to `list.json`, or an added field.

## Not in format 1

- **Third-party plugins:** every entry is built from this repository's releases. A reviewed list of third-party entries, each pointing at a release asset in its own repository, can be merged in later; `repository` is per plugin for that reason.
- **Icons, categories and other marketplace fields:** they come with the marketplace, as optional fields.
