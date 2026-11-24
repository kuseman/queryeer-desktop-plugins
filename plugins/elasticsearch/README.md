# Queryeer Elasticsearch Plugin

Elasticsearch connections for Queryeer Desktop, and payloadbuilder's `elasticsearch` catalog over them. Plugin id `com.queryeer.elasticsearch`. Needs Queryeer 0.23 for its own backend actions (`context.actions()` / `context.backend.invoke`) and `settings.copySecrets`.

## What it adds

- **Connections** in Settings → Query Engine → Elasticsearch (also the command **Manage Elasticsearch Connections**):
  - endpoint (`https://host:9200`) and authentication: none, or basic with a username and a password;
  - **Trust certificate**: accepts any server certificate and host name, e.g. a cluster with a self-signed certificate;
  - connect and read timeouts in milliseconds; empty uses payloadbuilder's defaults (500 ms and 15 s);
  - passwords are kept in the Queryeer vault, never in settings;
  - **Test connection** shows the cluster's name and Elasticsearch version, also for a connection that isn't saved yet.
- **The `elasticsearch` payloadbuilder catalog**, when payloadbuilder is installed (an optional dependency). It replaces Queryeer's built-in one.
  - The catalog panel picks the connection and, optionally, an index: free text, so a pattern such as `logs-*` works too. **Reload indices** (or the field's ▾) lists the cluster's aliases, data streams and indices as suggestions; hidden ones (`.security`, ...) are left out. A pattern filters them as Elasticsearch would read it, and the field says how many indices it matches.
  - Tables: `es#_doc` (with the panel's index) and the other tables and functions of payloadbuilder's es catalog.
  - Table completion and hover come from the catalog's system tables.
- **Backend actions** of the plugin itself, not of payloadbuilder: `indices.list` and `connection.test`. They use the JDK's HTTP client and work without payloadbuilder.

## Moving from Queryeer's built-in connections

On its first start the plugin copies Queryeer's own Elasticsearch connections (`core.queryengine.payloadbuilder.elasticsearch.connections`) into its settings, once per installation:

- **Connection ids stay the same**, so files that use the `elasticsearch` catalog keep their connection: nothing to pick again.
- **Each password gets its own vault entry.** Editing the plugin's connection never changes Queryeer's, and the copy works while the vault is locked.
- **A password stored as plain text** (only possible by editing the settings JSON by hand) is not copied. That connection is migrated without it; enter the password again.
- Queryeer's own settings are left as they are, so uninstalling the plugin brings the built-in catalog back with its connections. Edits made after the migration are not synced between the two.

## Building

From the repository root (requires Java 25, Node 20+, and Docker for the Testcontainers tests):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run elasticsearch:test` | Runs the frontend typecheck and tests, then the backend tests (unit tests, and an Elasticsearch 8 container with HTTPS and basic authentication for the actions and a payloadbuilder query through the catalog) |
| `npm run elasticsearch:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.elasticsearch-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.elasticsearch-<version>/` |
| `npm run elasticsearch:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `elasticsearch:package` once first |

- **Versions it builds against:** `backend-api` and the payloadbuilder foundation 0.23.0 from Maven Central (its own `queryeer.backend.version` in `backend/pom.xml`), and the root `pom.xml`'s `payloadbuilder.version` for the bundled `payloadbuilder-catalog-es`.
- **Bundled:** the catalog and its libraries (httpclient5, Jackson, mustache). The plugin's own actions read Elasticsearch's answers with that Jackson.
- **`@queryeer/api` 0.23.0** from npm.
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **Development loop:** as for the [MongoDB plugin](../mongodb/README.md#building), with `QUERYEER_DEV_PLUGINS` pointing at the unpacked folder.
