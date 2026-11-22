# Queryeer MySQL and MariaDB Plugin

A MySQL and MariaDB dialect for Queryeer Desktop's built-in JDBC query engine. Plugin id `com.queryeer.jdbc.mysql`; it depends on `queryengine.jdbc`.

## What it adds

- **Connections** to MySQL and MariaDB servers, in the JDBC engine's connection editor:
  - properties `host` (required), `port` (default 3306), `database`, `sslMode` (`disable`, `trust`, `verify-ca`, `verify-full`), `username` and `password`.
  - Without `sslMode`, the driver encrypts and verifies the server certificate:
    - MariaDB 11.4 and later pass with the certificate they generate themselves (with a password set).
    - MySQL with its self-signed certificate needs `trust`.
- **The driver: MariaDB Connector/J,** which serves both servers (MySQL Connector/J doesn't support MariaDB).
  - It is never bundled, because it is LGPL and core owns the shared library folder.
  - The plugin registers it with `jdbcDrivers`, and Queryeer downloads it from Maven Central after you confirm.
  - Until it is installed, connecting fails with "No suitable driver".
- **The database tree.**
  - MySQL and MariaDB have no catalogs, and what they call a database is `information_schema`'s `table_schema`.
  - So the tree lists databases from `information_schema.schemata`, with Tables, Views, Procedures and Triggers directly under each database (`MySqlSchemaResolvers`).
- **Tree actions:** **Select Top 100 Rows** (tables and views) and **Show Create Statement** (tables, views, procedures and triggers).
- **Symbol action:** **Describe** on a table or view in a MySQL file lists its columns from `information_schema.columns`.
- **Query execution** through the JDBC engine's executor. Statement splitting and MySQL-specific value mapping come later.

## Tested servers

Testcontainers tests run the dialect against MySQL 8.4 (`mysql:8.4.13`) and MariaDB 11.8 (`mariadb:11.8.9`), next to unit tests of the dialect. The driver is a test dependency only (`mariadb.driver.version` in `backend/pom.xml`).

## Building

From the repository root (requires Java 25, Node 20+, and Docker for the Testcontainers and smoke tests):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run mysql:test` | Runs the frontend typecheck and tests, then the backend tests |
| `npm run mysql:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.jdbc.mysql-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.jdbc.mysql-<version>/` |
| `npm run mysql:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `mysql:package` once first |
| `npm run mysql:smoke` | Runs the end-to-end check in Queryeer's backend runner (`scripts/smoke-backend.mjs`). Set `QUERYEER_DESKTOP_DIR` if the core checkout is not at `../queryeer-desktop/development` |

- **Versions it builds against:** the backend builds against `backend-api`, `backend-contract` and `backend-lib-queryengine-jdbc-foundation` at the root `pom.xml`'s `queryeer.backend.version`. The JDBC foundation is `provided`: Queryeer's built-in JDBC plugin supplies it at runtime.
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **The changelog** is generated from the commits that touch `plugins/mysql`, as for the [MongoDB plugin](../mongodb/README.md#building), which also describes the development loop with `QUERYEER_DEV_PLUGINS`.
