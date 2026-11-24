# Queryeer SQLite Plugin

A SQLite dialect for Queryeer Desktop's built-in JDBC query engine, moved out of Queryeer's core. Plugin id `com.queryeer.jdbc.sqlite`; it depends on `queryengine.jdbc` 0.24.0 or later, the first Queryeer without a built-in SQLite dialect.

## What it adds

- **Connections** to SQLite database files, in the JDBC engine's connection editor:
  - properties `filePath` (required, with a browse button) and an optional encryption `password`, stored in the security vault.
  - The dialect id stays `sqlite`, so connections made with Queryeer's built-in dialect keep working.
- **The driver: xerial's sqlite-jdbc,** which carries SQLite's native library.
  - It is never bundled: the plugin registers it with `jdbcDrivers`, and Queryeer downloads it from Maven Central after you confirm.
  - Until it is installed, connecting fails with "No suitable driver".
- **The database tree:** Tables and Views from `sqlite_master`, each table with its columns (primary and foreign keys from `PRAGMA table_info` and `foreign_key_list`) and indexes.
- **SQLite's file type:** files ending in `.sqlite`, `.sqlite3`, `.db`, `.db3`, `.s3db` or `.sl3` are labelled "SQLite Database".
- **Opening a database file** shows a screen that creates a connection to it and opens a query file on it, as Queryeer's built-in dialect did. When a connection to the file exists, the query file opens right away.
  - It writes the JDBC engine's connections setting, `core.queryengine.jdbc.connections`, which core documents as the contract for this until `@queryeer/jdbc-api` exists (DEVELOPMENT-PLUGIN.md §7.12.1).

## Building

From the repository root (requires Java 25 and Node 20+; the tests need no Docker, they use SQLite files):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run sqlite:test` | Runs the frontend typecheck and tests, then the backend tests |
| `npm run sqlite:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.jdbc.sqlite-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.jdbc.sqlite-<version>/` |
| `npm run sqlite:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `sqlite:package` once first |

- **Versions it builds against:** as the [MySQL plugin](../mysql/README.md#building): `backend-api`, `backend-contract` and the `provided` JDBC foundation at the root `pom.xml`'s `queryeer.backend.version`. The driver is a test dependency only (`sqlite.jdbc.version` in `backend/pom.xml`).
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **The changelog** is generated from the commits that touch `plugins/sqlite`, as for the [MongoDB plugin](../mongodb/README.md#building), which also describes the development loop with `QUERYEER_DEV_PLUGINS`.
