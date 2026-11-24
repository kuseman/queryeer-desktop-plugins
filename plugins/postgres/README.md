# Queryeer PostgreSQL Plugin

A PostgreSQL dialect for Queryeer Desktop's built-in JDBC query engine, moved out of Queryeer's core. Plugin id `com.queryeer.jdbc.postgres`; it depends on `queryengine.jdbc` 0.24.0 or later, the first Queryeer without a built-in PostgreSQL dialect, and on `queryengine.sql.parser`, which splits a script into statements.

## What it adds

- **Connections** to PostgreSQL servers, in the JDBC engine's connection editor: host, port (5432 by default), database, username, password (stored in the security vault) and SSL mode.
  - The dialect id stays `postgres`, so connections made with Queryeer's built-in dialect keep working.
- **The driver: pgJDBC** (`org.postgresql:postgresql`).
  - It is never bundled: the plugin registers it with `jdbcDrivers`, and Queryeer downloads it from Maven Central after you confirm.
  - Until it is installed, connecting fails with "No suitable driver".
- **Query plans:** Estimated Plan and the Actual Plan toggle. The backend runs `EXPLAIN (FORMAT JSON)`, with `ANALYZE` for the actual plan, and returns the plan as a graph that core draws.
- **The database tree:** databases and their schemas, each with tables, views, procedures and triggers; tables and views with their columns and indexes.
- **Templates:** a "Select Top 100 Rows" tree action, a "Describe" symbol action, and a "PostgreSQL Database" when-expression.

## Known gaps

- **A very large result runs Queryeer's backend out of memory.** pgJDBC reads a whole result into memory unless autocommit is off and a fetch size is set; Queryeer 0.24 sets the fetch size and adds `JdbcDialect.beginStatement` for the rest, which 0.1.0, built against 0.23, cannot use. 0.2.0 turns autocommit off for queries (`SELECT`/`WITH`), unless a transaction is already open.
- **Errors in a plan run** show no line in the file. PostgreSQL counts their position from the start of the failing `EXPLAIN` statement, and mapping it to the file needs Queryeer 0.24's statement offsets, while 0.1.0 builds against 0.23. Ordinary query errors do show their line.

## Building

From the repository root (requires Java 25 and Node 20+; the tests need no database):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run postgres:test` | Runs the frontend typecheck and tests, then the backend tests |
| `npm run postgres:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.jdbc.postgres-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.jdbc.postgres-<version>/` |
| `npm run postgres:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `postgres:package` once first |

- **Versions it builds against:** `backend-api`, `backend-contract`, and the `provided` JDBC foundation and SQL parser, at Queryeer 0.23.0 (`queryeer.backend.version` in `backend/pom.xml`).
- **Jackson 3** (`jackson-databind`) reads `EXPLAIN`'s JSON and is bundled in `lib/`: Queryeer does not offer its own Jackson to plugins. tree-sitter is a test dependency only; at runtime the parser comes from `queryengine.sql.parser`.
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **The changelog** is generated from the commits that touch `plugins/postgres`, as for the [MongoDB plugin](../mongodb/README.md#building), which also describes the development loop with `QUERYEER_DEV_PLUGINS`.
