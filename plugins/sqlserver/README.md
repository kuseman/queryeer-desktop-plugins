# Queryeer SQL Server Plugin

A SQL Server dialect for Queryeer Desktop's built-in JDBC query engine, moved out of Queryeer's core. Plugin id `com.queryeer.jdbc.sqlserver`; it depends on `queryengine.jdbc` 0.24.0 or later, the first Queryeer without a built-in SQL Server dialect.

## What it adds

- **Connections** to SQL Server, in the JDBC engine's connection editor: host, port (1433 by default) or named instance, database, application name, encryption and certificate options, and the authentication:
  - SQL Server authentication, with the password stored in the security vault;
  - Windows native authentication (Windows only), Windows NTLM authentication, or Java Kerberos.
  - The dialect id stays `sqlserver`, so connections made with Queryeer's built-in dialect keep working.
- **The driver: Microsoft JDBC Driver for SQL Server** (`com.microsoft.sqlserver:mssql-jdbc`, the `.jre11` builds).
  - It is never bundled: the plugin registers it with `jdbcDrivers`, and Queryeer downloads it from Maven Central after you confirm.
  - On Windows, Queryeer also downloads the driver's native authentication library (`mssql-jdbc_auth-<version>.<arch>.dll`) from the driver's GitHub release into `libNative`. Windows native authentication needs it; its version must match the driver's, so the two are installed, updated and removed together.
  - A driver Queryeer installed while SQL Server was built in is kept: once you approve the plugin's driver, Queryeer manages it again.
  - Until it is installed, connecting fails with "No suitable driver".
- **Windows native authentication.** `plugin.json`'s `runtime.shared` section makes the driver's packages load parent-first and preloads the native library, so it binds to the one shared copy of the driver. Queryeer applies `runtime.shared` from installed plugins since 0.24.
- **Query plans:** Estimated Plan and the Actual Plan toggle. The backend runs each batch with `SET SHOWPLAN_XML ON` or `SET STATISTICS XML ON` and returns the plan as a graph that core draws.
  - **SQL Server Plan XML Output** (Settings → Query Engine → SQL Databases → SQL Server) also shows the plan XML as query output. The plugin copies the value you set while SQL Server was built in, once.
- **The database tree:** databases and their schemas, each with tables, views, procedures and triggers; tables and views with their columns, keys and indexes; and Security → Users.
- **Statements split on `GO`,** alone on its line, with an optional repeat count.
- **Templates:** "Procedure Definition to Text", "Procedure Definition to New Query", "Object Help" and "Select Top 100 Rows" tree actions, "Describe" and "Procedure Definition" symbol actions, and a "SQLServer Database" when-expression.
  - The symbol actions use `fn.sqlserver.identifier`, which Queryeer itself registers, so actions you made from the built-in templates keep working.

## Known gaps

- **Errors in a plan run** show no line in the file. SQL Server counts the line from the start of the failing batch, and mapping it to the file needs Queryeer 0.24's statement offsets, while 0.1.0 builds against 0.23. Ordinary query errors do show their line.

## Building

From the repository root (requires Java 25 and Node 20+; the container tests need Docker and are skipped without it):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run sqlserver:test` | Runs the frontend typecheck and tests, then the backend tests, including those against SQL Server 2022 in Testcontainers |
| `npm run sqlserver:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.jdbc.sqlserver-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.jdbc.sqlserver-<version>/` |
| `npm run sqlserver:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `sqlserver:package` once first |

- **Versions it builds against:** `backend-api`, `backend-contract`, and the `provided` JDBC foundation, at Queryeer 0.23.0 (`queryeer.backend.version` in `backend/pom.xml`). It bundles nothing else.
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **The changelog** is generated from the commits that touch `plugins/sqlserver`, as for the [MongoDB plugin](../mongodb/README.md#building), which also describes the development loop with `QUERYEER_DEV_PLUGINS`.
