# Queryeer Desktop Plugins

Verified plugins for [Queryeer Desktop](https://github.com/kuseman/queryeer-desktop), maintained by the Queryeer Desktop owner.

| Plugin | ID | Folder | Status |
|---|---|---|---|
| MongoDB | `com.queryeer.mongodb` | [`plugins/mongodb`](plugins/mongodb/README.md) | In design / scaffolding |

Each plugin is built, versioned and released independently. Queryeer discovers verified plugins through [`catalog/index.json`](#repository-and-releases), so users never need to add several repositories.

## Repository and Releases

Verified plugins live in one shared repository:

```text
queryeer-desktop-plugins/
  pom.xml               shared Maven parent; lists every plugin backend as a module
  package.json          npm workspaces (plugins/*/frontend) and scripts per plugin (<plugin>:test, :package, :smoke)
  mvnw, .mvn/           Maven wrapper
  plugins/
    mongodb/            plugin.json, backend/ (Maven module), frontend/ (npm workspace), README
    elasticsearch/      (planned)
  shared/
    schema/             vendored copy of Queryeer's plugin.json v1 schema
    scripts/            packaging, package verification, ZIP writer, Maven runner, changelog
  dist/                 build output (git-ignored)
  catalog/index.json    verified-plugin catalog read by Queryeer (planned)
  .github/CODEOWNERS    per-plugin ownership (planned)
```

Each plugin's README has a **Building** section, for example [MongoDB](plugins/mongodb/README.md#building). The packaging script writes ZIPs that are byte-for-byte reproducible:
- entries are sorted
- timestamps are fixed
- entry names always use forward slashes

The vendored schema in `shared/schema/` must be refreshed whenever Queryeer changes `plugin-schema/plugin.json.schema.v1.json`.

- **Versions:** each plugin is versioned independently, in its own `plugin.json` (SemVer).
- **Tags:** `<short-name>/v<semver>`, e.g. `mongodb/v0.1.0`.
- **Release assets:** `<plugin-id>-<version>.zip` plus `<plugin-id>-<version>.zip.sha256`, e.g. `com.queryeer.mongodb-0.1.0.zip`. Each tag gets its own GitHub Release; prereleases use GitHub's prerelease flag.
- **CI:** one workflow per plugin, filtered by path, so a change under `plugins/mongodb/**` builds and tests only MongoDB ([mongodb.yml](.github/workflows/mongodb.yml): typecheck, unit tests, Testcontainers tests, package and verify; the ZIP is uploaded as a build artifact). A tag push will build only the tagged plugin.
  - The plugin API comes from npm (`@queryeer/api`) and Maven Central (`backend-api`, `backend-contract`), so CI needs no Queryeer Desktop checkout.
- **Catalog:** the release workflow publishes the assets and then updates `catalog/index.json`. The catalog is served from a stable URL (GitHub Pages or a raw URL on `master`).
- **No "latest release" lookups:** GitHub tracks one latest release per repository, not per plugin, so clients never call `/releases/latest`. They read the catalog.

Catalog format:

```json
{
  "plugins": [
    {
      "id": "com.queryeer.mongodb",
      "name": "MongoDB",
      "version": "0.1.0",
      "url": "https://github.com/<owner>/queryeer-desktop-plugins/releases/download/mongodb/v0.1.0/com.queryeer.mongodb-0.1.0.zip",
      "sha256": "<hex>",
      "minApiVersion": "0.19.0",
      "prerelease": false
    }
  ]
}
```

- **Listing a plugin:** a reviewed pull request to the catalog. A third-party entry may point at a release asset in another repository.
- **Plugin issues:** they are labelled per plugin.

## GitHub Releases Follow-up

GitHub support belongs in Queryeer Desktop after local packaging has been proven. The intended flow is:

```text
catalog/index.json (verified plugins and their release URLs)
  -> GitHub release asset
  -> Queryeer downloads the ZIP and checks it against the catalog sha256
  -> existing staged ZIP installation pipeline
  -> managed local plugin directory
  -> normal frontend/backend plugin discovery
```

The catalog is the contract between Queryeer and plugin distribution. Queryeer reads only the catalog URL to find plugins and check for updates, and never calls the GitHub release API directly. GitHub hosts the release assets and records where each download came from. The installed plugin runtime should not depend on GitHub and should behave identically whether installed from:

- A local development folder
- A local ZIP
- A ZIP downloaded from a GitHub Release

The release asset conventions and the use of the catalog sha256 are settled above. Before automatic updates are introduced, Queryeer still needs to define:

- semantic-version comparison
- how `minApiVersion` is enforced (today `apiVersion` is not enforced during discovery)
- prerelease opt-in policy
- downgrade behaviour
- the catalog's own trust model, such as whether the catalog is signed

