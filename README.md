# Queryeer Desktop Plugins

Verified plugins for [Queryeer Desktop](https://github.com/kuseman/queryeer-desktop), maintained by the Queryeer Desktop owner.

| Plugin | ID | Folder | Status |
|---|---|---|---|
| MongoDB | `com.queryeer.mongodb` | [`plugins/mongodb`](plugins/mongodb/README.md) | Released: native MongoDB query engine |
| MySQL and MariaDB | `com.queryeer.jdbc.mysql` | [`plugins/mysql`](plugins/mysql/README.md) | Released: dialect for Queryeer's JDBC engine |
| SQLite | `com.queryeer.jdbc.sqlite` | [`plugins/sqlite`](plugins/sqlite/README.md) | Released: dialect for Queryeer's JDBC engine, moved out of Queryeer's core (Queryeer 0.24) |
| PostgreSQL | `com.queryeer.jdbc.postgres` | [`plugins/postgres`](plugins/postgres/README.md) | In development: dialect with query plans for Queryeer's JDBC engine, moved out of Queryeer's core (Queryeer 0.24) |
| Kafka | `com.queryeer.kafka` | [`plugins/kafka`](plugins/kafka/README.md) | Released: connections and the payloadbuilder kafka catalog (Queryeer 0.23) |
| Elasticsearch | `com.queryeer.elasticsearch` | [`plugins/elasticsearch`](plugins/elasticsearch/README.md) | Released: connections and the payloadbuilder elasticsearch catalog, migrated from Queryeer's own (Queryeer 0.23) |

Every released version is listed in the [catalog](specs/plugin-catalog.md), `https://kuseman.github.io/queryeer-desktop-plugins/catalog/list.json`, and on the [Releases](../../releases) page.

Each plugin is built, versioned and released independently. Queryeer's release bundles plugins from the catalog, and Queryeer will discover verified plugins through it, so users never need to add several repositories.

## Repository and Releases

Verified plugins live in one shared repository:

```text
queryeer-desktop-plugins/
  pom.xml               shared Maven parent; lists every plugin backend as a module
  package.json          npm workspaces (plugins/*/frontend) and scripts per plugin (<plugin>:test, :package, :smoke)
  mvnw, .mvn/           Maven wrapper
  plugins/
    mongodb/            plugin.json, backend/ (Maven module), frontend/ (npm workspace), README
    mysql/              MySQL and MariaDB dialect for the JDBC engine; same layout
    sqlite/             SQLite dialect for the JDBC engine, moved out of core; same layout
    postgres/           PostgreSQL dialect with query plans for the JDBC engine, moved out of core; same layout
    kafka/              Kafka connections and the payloadbuilder kafka catalog; same layout
    elasticsearch/      Elasticsearch connections and the payloadbuilder elasticsearch catalog; same layout
  shared/
    schema/             vendored copy of Queryeer's plugin.json v1 schema, and the catalog's schema
    scripts/            packaging, package verification, ZIP writer, Maven runner, changelog, catalog generator
  dist/                 build output (git-ignored)
  .github/CODEOWNERS    per-plugin ownership (planned)
```

Each plugin's README has a **Building** section, for example [MongoDB](plugins/mongodb/README.md#building). The packaging script writes ZIPs that are byte-for-byte reproducible:
- entries are sorted
- timestamps are fixed
- entry names always use forward slashes

The vendored schema in `shared/schema/` must be refreshed whenever Queryeer changes `plugin-schema/plugin.json.schema.v1.json`.

- **Versions:** each plugin is versioned independently, in its own `plugin.json` (SemVer).
- **Ranges on Queryeer:** the plugins here accept every Queryeer from the one they need up to 1.0, e.g. `">=0.20.0 <1.0.0"` on `queryengine.jdbc` and in `frontend.apiVersion`, rather than `^0.20.0`, which would need a plugin release for each core minor version. They are maintained alongside core and run against each new core in development, where ranges aren't enforced anyway. The cost: a core change that breaks a plugin shows as a runtime error rather than a clean skip. So before a core release, build and test the plugins against it (`npm run <plugin>:test` with `queryeer.backend.version` and `@queryeer/api` bumped). Raise the lower bound when a plugin starts using something newer.
- **Tags:** `<short-name>/v<semver>`, e.g. `mongodb/v0.1.0`.
- **Release assets:** `<plugin-id>-<version>.zip` plus `<plugin-id>-<version>.zip.sha256`, e.g. `com.queryeer.mongodb-0.1.0.zip`. Each tag gets its own GitHub Release; prereleases use GitHub's prerelease flag.
- **CI:** one workflow per plugin, filtered by path, so a change under `plugins/mongodb/**` builds and tests only MongoDB ([mongodb.yml](.github/workflows/mongodb.yml), and [mysql.yml](.github/workflows/mysql.yml) for MySQL, [kafka.yml](.github/workflows/kafka.yml) for Kafka: typecheck, unit tests, Testcontainers tests, package and verify; the ZIP is uploaded as a build artifact). A tag push builds only the tagged plugin (see Releasing below).
  - The plugin API comes from npm (`@queryeer/api`) and Maven Central (`backend-api`, `backend-contract`), so CI needs no Queryeer Desktop checkout.
- **Releasing** works like Queryeer Desktop's, in two steps:
  1. **Create Plugin Release** ([create-plugin-release.yml](.github/workflows/create-plugin-release.yml), run by hand on `master`):
     - you pick the plugin and the version increment (minor, patch or major)
     - it sets the version in `plugin.json`, the backend `pom.xml` and the frontend `package.json` ([plugin-version.mjs](shared/scripts/plugin-version.mjs))
     - it commits `release(<plugin>): v<version>` and pushes the tag `<plugin>/v<version>`
     - A plugin's first release uses the version already in its `plugin.json`.
     - There is no `-SNAPSHOT` in between releases: the version stays at the last release, and the changelog lists newer commits as the next one. That holds only while releases publish nothing but the ZIP. A plugin that starts publishing to Maven needs core's "prepare for next development iteration" step for its `pom.xml`, so builds between releases never carry a version that is already published.
  2. **Release Plugin** ([release-plugin.yml](.github/workflows/release-plugin.yml), started by the tag):
     - checks that the tag matches the committed version
     - tests, packages and verifies that plugin only
     - publishes a GitHub Release with the ZIP, its `.sha256` file, and that version's changelog section as the release notes
     - It refuses a tag that already has a release.
     - A version like `1.2.0-beta.1` becomes a prerelease.
     - Run by hand, it is a dry run that keeps the ZIP and the notes as run artifacts.

  The first workflow needs a `RELEASE_TOKEN` secret: pushes made with the default `GITHUB_TOKEN` start no other workflows, and `master` is protected.
- **Catalog:** after publishing, the release workflow starts [publish-catalog.yml](.github/workflows/publish-catalog.yml), which builds `catalog/list.json` from the GitHub Releases and deploys it to GitHub Pages. The format, the checks and how readers use it are in [specs/plugin-catalog.md](specs/plugin-catalog.md).
- **No "latest release" lookups:** GitHub tracks one latest release per repository, not per plugin, so clients never call `/releases/latest`. They read the catalog.
- **Listing a plugin:** today every catalog entry comes from this repository's releases. Third-party entries, each pointing at a release asset in its own repository, are planned as a reviewed list merged into the catalog.
- **Plugin issues:** they are labelled per plugin.

## GitHub Releases Follow-up

GitHub support belongs in Queryeer Desktop after local packaging has been proven. The intended flow is:

```text
catalog/list.json (verified plugins and their release URLs)
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
- how the version ranges in a catalog entry's `manifest` are checked before offering it (core does not enforce `frontend.apiVersion` yet; 0.24 is proposed to)
- prerelease opt-in policy
- downgrade behaviour
- the catalog's own trust model, such as whether the catalog is signed

