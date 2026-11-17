# Plan: Queryeer 1.0.0, a small core and everything else as plugins

Status: plan, 2026-11-16. Decisions marked **Open** are not taken yet.

## 1. Goal

Strip Queryeer Desktop down to a core that hosts plugins, and move every query engine, dialect, foundation library and catalog into this repository. Plugins then ship on their own schedule, without a desktop release.

**1.0.0 means a promise about the core's contract:** the frontend plugin API (`@queryeer/api`), the backend plugin API (`backend-api`, `backend-contract`), the protocol between them, and the plugin manifest. It is proven by at least one engine family that lives entirely outside core, with no access to internals.

1.0.0 does not have to wait until everything has moved. Once the contract is complete, moving the rest is ordinary plugin work in this repository.

## 2. What core holds today

### Backend (`queryeer-backend`, manifests in `plugins/builtin`)

| Plugin id | Depends on | Uses `runtime.shared` |
|---|---|---|
| `queryengine.runtime.jdbc-foundation` | | parent-first packages, native libraries, shared jars |
| `queryengine.runtime.sql-parser` | | parent-first packages, native libraries, shared jars |
| `queryengine.runtime.payloadbuilder-foundation` | | parent-first packages, native libraries, shared jars |
| `queryengine.jdbc` | jdbc-foundation, sql-parser | |
| `queryengine.jdbc.dialect.postgres` | `queryengine.jdbc` | parent-first `org.postgresql.`, `postgresql-*.jar` |
| `queryengine.jdbc.dialect.sqlite` | `queryengine.jdbc` | parent-first `org.sqlite.`, `sqlite-jdbc-*.jar` |
| `queryengine.jdbc.dialect.sqlserver` | `queryengine.jdbc` | parent-first `com.microsoft.sqlserver.jdbc.`, auth DLLs, `mssql-jdbc-*.jar` |
| `queryengine.payloadbuilder` | `queryengine.jdbc` | |

The order follows from the dependencies: **payloadbuilder depends on JDBC, so JDBC moves first.**

All of them load from build folders in the core repository through `backend.classpath`. The shared runtime design is in core's `queryeer-backend/SHARED_RUNTIME_PLUGINS.md`.

### Frontend (`packages/app/src/plugins`)

| Plugin | Lines (without tests) | Notes |
|---|---|---|
| `core.queryengine` | 6,200 | the query editor, execution and results host: **stays in core** |
| `core.queryengine.output.table` / `.text` / `.file` | 2,500 / 400 / 35 | result output: **stays in core** (renders every engine's results) |
| `core.queryengine.jdbc` | 6,000 | moves; includes driver management UI |
| `core.queryengine.jdbc.postgres` / `.sqlite` / `.sqlserver` | 250 / 260 / 540 | move |
| `core.queryengine.payloadbuilder` | 2,800 | moves |
| `core.queryengine.payloadbuilder.*` (elasticsearch, filesystem, http, jdbc, kafka, mongodb) | 44 to 750 each | move |

Internals the moving frontend plugins use instead of `@queryeer/api`:
- `core/utils/ids` (4 uses)
- `renderer/shell/backend-status-service` (2)
- `renderer/components/ContextMenuSurface` (2)
- `renderer/shell/file-entity-utils` (1)
- `core/plugin-runtime/FileRegistry` (1)
- `core/plugin-runtime/ExtensionRegistry` (1)
- `window.appShell`: `openExternal`, `openPath`, `getAppDir`, `showDialogOpen`, `platform`

JDBC driver management goes through Electron's main process: `jdbc-driver-management-service.ts`, `PluginHost`, `main/index.ts`, `restartBackendForJdbcDrivers`.

The MongoDB plugin found more internals that built-in engines use. They are listed in [`API-GAPS.md`](../API-GAPS.md) (F16 `requestExecute` / `applyRecoveredContent`, D2 backend restart, and others).

### What an external plugin cannot do today

These are the hard blockers. Everything else is API surface.

1. **Share classes with other plugins.** In `backend-runner`, each plugin has its own class loader, and all of them have one shared class loader as parent (`PluginClassLoaderFactory`). A plugin never sees another plugin's classes, whatever `dependencies` says.
   - Built-in dialects see `JdbcRuntimeService` only because the `jdbc-foundation` runtime plugin puts its jar in the shared loader and marks `com.queryeer.backend.queryengine.jdbc.` parent-first.
   - The runner collects those contributions from built-in manifests only (`loadBuiltinManifests` → `PluginRuntimeContributionCollector`).
   - This repository's package check rejects `runtime`, and the packager rejects `backend.classpath`.
   - **But an external dialect does see them today (verified 2026-11-17).** `BackendRunnerModule` builds one `PluginClassLoaderFactory` for every plugin, external ones included, with the built-ins' shared classpath and parent-first prefixes. The MySQL dialect's smoke test (`npm run mysql:smoke`) runs the packaged plugin in core's real runner: compiled against `jdbc-foundation` with `provided` scope, it activates, gets `JdbcRuntimeService` from `services()`, registers its dialect, and runs a query through the JDBC engine against MySQL 8.4, with the driver only in `<appDir>/libShared`.
   - It works by accident: nothing declares the dependency, nothing checks its version, and it works only because the built-in JDBC classes sit in the shared layer, which §5 limits to drivers and native libraries. So this is not a blocker for the pilot, but it still is one for 1.0.0 (0.1, 0.2).
   - With its own copy of `jdbc-foundation` bundled, `services().get(JdbcRuntimeService.class)` finds nothing, because the registry looks up by class, and two copies are different classes.
2. **Have its JDBC drivers managed.** Most of the driver infrastructure exists and is public; one allowlist keeps external plugins out of it.
   - **What already works:**
     - Registration is public API in `@queryeer/api` 0.19.0: `context.jdbcDrivers.registerDriver(...)` (`JdbcDriverExtension`), with `dialectId`, `groupId`, `artifactId`, `driverClassName`, `compatibleVersionRegex`, `downloadPageUrl` and `companionArtifacts`.
     - The main process (`main/jdbc-drivers/jdbc-driver-artifact-service.ts`):
       - update checks through Maven Central's `maven-metadata.xml`, skipping snapshots and prereleases
       - downloads from Maven Central only, verified against its `.sha256` (or `.sha1`) checksum, with a size limit and a check that the jar contains `driverClassName`
       - staged installs with an inventory, update, disable and restore, and companion artifacts such as the SQL Server auth DLL in `libNative`
       - the driver settings UI, and the backend restart after a change
     - Every jar in `<appDir>/libShared` is in the shared class loader, the parent of every plugin class loader. A dialect that only compiles against its driver finds it through normal delegation, and `DriverManager.isDriverAllowed` passes.
   - **The gap:** the service manages only the contributions in its hardcoded `TRUSTED_CONTRIBUTIONS` list (`isTrusted`): Postgres, SQL Server and SQLite. An external plugin's registered driver is listed, and a jar dropped into `libShared` by hand is detected, but `managementAvailable` is false; check, install, update, remove and restore are refused ("Automatic management is not available for this contribution").
   - Smaller hardcoded spots:
     - the runner's `SharedLibraryLoader.KNOWN_JDBC_DRIVERS` (Postgres, SQL Server, SQLite), used to pick the newest of several versions of a driver in `libShared`; another driver's jar still loads, but duplicates are not resolved
     - the artifact service only recognises SQL Server auth DLLs as native files in `libNative` (`mssql-jdbc_auth*` / `sqljdbc_auth`)
3. **Depend on a version of another plugin.** `dependencies` is a list of ids, with no version ranges.
4. **Be developed quickly.** D1 to D4 in `API-GAPS.md`: no developer plugin folders, no public backend restart, jars locked on Windows, no watch mode. They are tolerable for one plugin; with every engine moved out, they are the development loop.

## 3. What stays in core

The application shell, editor, files and workspace, settings, themes, commands, menus, layout, notifications, the query editor host and result outputs (`core.queryengine`, `output.*`), `core.graph`, the plugin runtime and installer, and on the backend `backend-core`, `backend-runner`, `backend-transport-stdio`, `backend-api` and `backend-contract`.

**Open:** `core.flow`, `core.assistant`, `core.expressions` and `core.explorer`: core features or plugins? Suggested rule: core keeps what has no meaning without the shell, or what several plugins build on. An explorer tree that every engine adds to stays; a feature for one engine moves.

## 4. Phases

Each phase ends with exit criteria, not a date.

### Phase 0: the contract in core

Work in Queryeer Desktop. Nothing moves yet.

**Start: a MariaDB/MySQL dialect in this repository.** A new dialect, built here against core's working tree, finds the gaps one at a time instead of designing every Phase 0 item up front. Each gap goes into `API-GAPS.md` and is fixed in core, the way the MongoDB plugin drove 0.19.0.
- One `mysql` dialect for MySQL and MariaDB, with its driver registered through `context.jdbcDrivers` and managed by core (0.3), never bundled. The user downloads it, so its licence (LGPL) doesn't matter to the plugin.
- Order:
  1. ✅ Backend only: a minimal dialect that registers with `JdbcRuntimeService`, tested against `mysql` and `mariadb` Testcontainers, and a smoke test in core's real runner. It settled §2 item 1: an external dialect sees the JDBC classes today, by accident of the shared layer.
     - One `mysql` dialect serves both servers, with MariaDB Connector/J, which supports both (MySQL Connector/J does not support MariaDB). One dialect means one driver, which is what core's driver registry allows.
  2. The dialect itself (schema browsing, the executor), modelled on `SqliteDialect`.
  3. The frontend. The SQLite dialect's frontend imports `registerJdbcDialect`, `jdbc-settings`, `initJdbcFileBinding`, `PasswordFieldInput` and the JDBC CSS from core internals; each becomes an API gap.
  4. Release through this repository's release workflows, after the core release it needs.
- **Building against core's working tree.** As the MongoDB plugin did before 0.19.0, but for this plugin only, so MongoDB keeps building against the published API and stays releasable:
  - backend: the plugin's own `pom.xml` sets `queryeer.backend.version` to core's `-SNAPSHOT` (0.20.0-SNAPSHOT today), resolved from the local Maven repository after `mvnw install` in core
  - frontend: `@queryeer/api` as a `file:` link to core's `packages/api` (built with `npm run build` there)
  - CI: none for this plugin until core publishes the version it needs. CI has no core checkout, and a `file:` link that is missing there could break the root `npm ci` that MongoDB's workflow runs. Keep the plugin's frontend out of the root `workspaces` until then (list workspaces explicitly instead of `plugins/*/frontend`).
  - When core releases: switch both to the published versions in one commit, like `d2f01ff` did for MongoDB, add the plugin's CI workflow, and update the `API-GAPS.md` statuses.
- Exit: the dialect works in Queryeer, installed as a ZIP, with no import from core internals and no bundled driver.

**0.1 Classes shared through dependencies.** The model is decided in §5: exported packages, seen through declared dependencies.
- **Manifest:** `backend.exports` lists package prefixes. A plugin may only export packages that are in its own jars.
- **Runner:**
  - A plugin's class loader asks the class loaders of its declared dependencies for their exported packages, before looking in its own jars.
  - Cycles in dependencies are refused.
  - A class missing from a dependency's exports fails with an error naming both plugins and the package.
- **Shared layer:** only for what is genuinely process-wide: JDBC drivers and native libraries.
  - JDBC drivers reach it only through the driver service (0.3): a plugin registers a driver, core downloads it into `libShared` and its native companions into `libNative`. A plugin never puts its own jars there, and needs no `parentFirstPackagePrefixes` for drivers, because it never bundles a copy.
  - Native libraries (e.g. the SQL Server auth DLL) still need a rule: the same driver service with a native artifact, or `runtime.shared` from catalog-verified plugins only. Decision #2.
  - Built-in `runtime.shared` contributions stay until the JDBC family moves; everything else is refused, with a log message saying why.
- Exit:
  - an external test pair: a plugin that exports an API, and one that depends on it and uses a service through `services()`
  - the SQL Server dialect loads as an external ZIP, and integrated authentication still works (the acceptance case in `SHARED_RUNTIME_PLUGINS.md`)

**0.2 Versioned dependencies and activation order.**
- `dependencies` takes `{ id, version }` with a SemVer range. A plain id string keeps working.
- The runner and the frontend refuse a plugin whose dependency is missing or out of range. They say why in the plugin list ("needs JDBC ≥ 0.4, 0.3.2 installed") instead of skipping it silently.
- **Plugins activate in dependency order,** so a service is registered before a dependent asks for it. Check whether the runner orders by dependency today. Exports (0.1) need this either way.
- Exit: a test plugin pair, where the right version loads and the wrong version shows the reason.

**0.3 Managed drivers for external plugins.** Decided: drivers are never bundled. Plugins compile against them (`provided`) and register them with `context.jdbcDrivers.registerDriver(...)`, which already exists; core downloads them into `libShared`, which is the shared class loader. The download, verification and management infrastructure exists (§2 item 2). What is left:
- **Replace the `TRUSTED_CONTRIBUTIONS` allowlist** with a rule for external contributions (decision #7). The rule only decides which plugins may make core fetch an artifact into the shared layer; how it is fetched and verified stays as it is.
- **Several drivers per dialect.** The registry (`JdbcDriverRegistryHost`) keeps one driver per `dialectId`: a second registration by the same plugin replaces the first, and one by another plugin is refused. Not needed for the pilot: its one `mysql` dialect uses one driver, MariaDB Connector/J, for both servers. A dialect that wants a choice of drivers would need a registry change.
- **Runner:** `SharedLibraryLoader` takes the driver classes from the registered drivers instead of `KNOWN_JDBC_DRIVERS`, so it can pick the newest of several versions of any driver. That needs the main process to pass the registered drivers to the backend, e.g. in its start configuration.
- **Native companions:** recognise native files from the companion declaration (`expectedFileExtension`, the archive entry) instead of the SQL Server DLL names.
- Exit: the MariaDB/MySQL dialect's drivers can be checked, installed, updated and removed from the driver settings, and load in the backend, with no change to core's lists.

**0.4 Close the API gaps the move needs.**
- Every internal listed in §2 is either public in `@queryeer/api` or no longer needed.
- `API-GAPS.md` has no open P1.
- Exit: the moving plugins compile against `@queryeer/api` alone. A lint rule in core forbids imports from `core/` and `renderer/` in plugin folders, which also keeps future core plugins honest.

**0.5 The development loop.** D1 (developer plugin folders) and D2 (public backend restart) are required. D3 (shadow-copied jars) and D4 (watch mode) are strongly suggested.
- Exit: change a dialect in this repository, rebuild, restart the backend from the command palette, and see the change without quitting the app.

### Phase 1: move the JDBC family

The JDBC family is `jdbc-foundation`, `sql-parser`, `queryengine.jdbc`, the three dialects, and their frontends.

- **Why first:** it is the most used, payloadbuilder depends on it, and it exercises every Phase 0 item: exported APIs, the shared layer for drivers and native libraries, and versioned dependencies.
- **In this repository:**
  - `plugins/jdbc`, `plugins/jdbc-postgres`, `plugins/jdbc-sqlite`, `plugins/jdbc-sqlserver`
  - the JDBC API as an exported, published artifact (§5, §6)
  - one CI workflow per plugin, like `mongodb.yml`
- Core's copies are deleted in the same core release that starts bundling the external ones (Phase 2), so there is never a build with both or neither.
- Exit: the JDBC family runs from installed ZIPs with core holding no JDBC code, and core's tests pass without it.

### Phase 2: distribution

Without engines in core, a fresh install needs plugins from somewhere.

- **Bundled first-run plugins:**
  - the installer carries a pinned set of plugin ZIPs and installs them on first run, unless a newer version is already installed
  - after that they update on their own
  - offline and proxied corporate installs work, because nothing is downloaded on first run
- **The catalog** (`catalog/index.json`, already designed in the root README): Queryeer reads it to list verified plugins and offer updates.
  - The release workflow updates it after publishing (TODO §8, "Later").
- **Decisions the README lists as open:**
  - update checks and how they are shown
  - prerelease opt-in
  - rollback
  - the catalog's trust model (signing)

  The trust model also feeds Phase 0.1 (a).
- Exit: a clean machine without network access installs Queryeer and can run a JDBC query, and with network access it is offered a newer JDBC plugin.

### Phase 3: 1.0.0

Phase 1 and 2 done means the contract is complete. Then:
- **A compatibility policy:**
  - The API follows SemVer.
  - Removals only in a major version, after at least one minor version with a deprecation warning.
  - `apiVersion` in `plugin.json` is the range a plugin needs.
- **Tests:**
  - core runs contract tests against the protocol (`protocol-fixtures`) instead of against real engines
  - this repository tests its plugins against a pinned core version and against the newest one
- `DEVELOPMENT-PLUGIN.md` covers everything a third party needs, using only public API.
- Release Queryeer 1.0.0.

### Phase 4: the rest

Payloadbuilder engine, foundation and catalogs (elasticsearch, filesystem, http, jdbc, kafka, mongodb), and any feature §3 decided to move. Plugin releases from this repository, with no core release needed, unless something new turns up missing from the API. That is the point of the milestone.

## 5. Sharing code between plugins

Foundations are code that other plugins build on: the JDBC foundation, the SQL parser, the payloadbuilder foundation, and the JDBC dialect SPI.

### Decision (2026-11-16): APIs are exported through dependencies

**How a plugin uses another plugin's API**, taking a JDBC dialect or a third-party plugin as the example:
1. The JDBC plugin publishes its API to Maven Central as its own artifact (e.g. `jdbc-api`).
2. The JDBC plugin exports the API's packages in its `plugin.json` (`backend.exports`).
3. At activation, the JDBC plugin registers the implementation through the plugin context: `services().register(JdbcRuntimeService.class, …)`.
4. The dialect compiles against `jdbc-api` with `provided` scope and does not bundle it.
5. The dialect declares the dependency in `plugin.json`: `{ "id": "queryengine.jdbc", "version": "^1.2" }`.
6. At runtime, the dialect's class loader gets the API classes from the JDBC plugin's class loader, and `services().get(JdbcRuntimeService.class)` returns the JDBC plugin's instance.

There is one copy of each API class, owned by the plugin that exports it, and only plugins that declare the dependency can see it.

**The shared layer** (`runtime.shared`, the parent of every plugin class loader) is kept only for what is process-wide by nature:
- **Native libraries:** a native library can be loaded by only one class loader in the process, e.g. the SQL Server auth DLL.
- **JDBC drivers:** `DriverManager` only returns drivers visible to the caller's class loader. Drivers are never bundled: plugins register them, and the driver service downloads them into `libShared` (Phase 0.3).

Plugins never put their own jars in the shared layer. How native libraries get there is open (decision #2).

### Why not a shared layer for everything

Today's built-in foundations sit in the shared layer, above all plugins. For built-in plugins that works, and it is the simpler runner. The two models were weighed against each other, and exports win for a contract that third parties build on:
- **Third-party APIs need no trust decision.** A shared-layer foundation changes the whole process, so each one needs a trust decision. With exports, any plugin can offer an API to its dependents, since it can only export its own packages. A third-party plugin can publish an API that other third-party plugins build on.
- **Leaks stay local.** Everything in the shared layer, including a foundation's own libraries, is visible to every plugin, and conflicts grow with the ecosystem. IntelliJ's large shared platform layer is why its plugins cannot choose their own versions of the libraries it bundles. Eclipse moved to OSGi for this reason.
- **Versions are checked per dependency.** A plugin sees an API only through a version-checked dependency, so the runner can say exactly why something did not load. In a shared layer, everyone gets whatever version is installed.
- **Nothing is visible by accident.** A plugin that forgets to declare a dependency fails at once in development, instead of working because the classes happened to be in the shared layer.
- **Timing.** The choice is part of the 1.0.0 contract (what `dependencies` means and where classes come from), and changing it after 1.0 breaks every plugin.

**What it costs:**
- **A more complex runner:**
  - a graph of class loaders
  - cycle detection
  - activation in dependency order
  - clear errors when a class is not visible

  Class-loading bugs are harder to debug than one flat layer.
- **Re-exports:** if an exported API exposes types from another plugin's API, dependents need those visible too. OSGi and IntelliJ both grew a "re-export" flag. Avoid it for 1.0.0 by keeping other plugins' types out of exported APIs; add re-exports only if a real case needs them.

If the ecosystem were to stay first-party, the shared layer would be enough. Third-party plugins and a catalog are the direction, so the runner cost is paid before 1.0.0.

### Rules for an exported API

1. **Export an API, not the implementation.** Today's `jdbc-foundation` also holds implementation, such as `JdbcDriverLoader`. Split it: a small API artifact with interfaces and value types, and the implementation private inside the plugin. Only the API has to stay stable; everything else can change.
2. **No third-party types in the API.** If the API returns a parser or a connection-pool type, dependents need that library visible too, and a dependent that bundles another version of it gets a class that does not match. JDK types (`java.sql.Connection`) are fine.
3. **One version number for the API artifact and the plugin.** Release `jdbc-api` 1.2.0 with the JDBC plugin 1.2.0. Then the Maven version a dependent compiles against and the range it declares in `plugin.json` are the same number.
4. **SemVer for the API.** Within a major version, an exported API only grows. Removals follow the deprecation policy (Phase 3).
5. **Guard against bundling.** This repository's package check refuses a ZIP whose `lib/` contains a jar it should only reference through a dependency, e.g. `jdbc-api-*.jar` inside a dialect. That turns a confusing runtime failure into a build error.
6. **The frontend follows the same pattern.** A dialect's frontend registers with the JDBC frontend, today through the internal `ExtensionRegistry`. The equivalent is:
   - a types-only npm package (`@queryeer-plugins/jdbc-api`) to compile against
   - an object the JDBC plugin offers through the frontend plugin context, found by the dependent through its declared dependency

   This needs a public plugin-to-plugin service API in `@queryeer/api` (part of Phase 0.4).

## 6. Publishing from this repository

Each exported API is published to Maven Central (backend) and npm (frontend types), together with its plugin's ZIP.

**What this repository needs for Maven publishing:**
- Central credentials and a GPG key as secrets, and the `release.yml` publishing steps from core: a dry run, refusing duplicate uploads, and recovery.
- A "prepare for next development iteration" step for the `pom.xml` of whatever is published to Maven. The root README already says so. Plugins that only ship ZIPs keep working without it.
- An API artifact shares its plugin's tag (`jdbc/v1.2.0` releases the JDBC plugin ZIP and `jdbc-api` 1.2.0 together), following rule 3 above.
- Order inside a release: publish the API to Central first, then the plugin's GitHub Release. Dependent plugins are released afterwards, built against the published API.
- The `0-SNAPSHOT` root POM becomes a problem once anything is published, because a published POM must not name a SNAPSHOT parent. Either give the root POM a real released version, or flatten published POMs (`flatten-maven-plugin`).

Also needed here:
- `.github/CODEOWNERS` per plugin (planned in the README)
- a CI workflow per plugin, or one reusable workflow called with the plugin name
- the generic `test` / `package` / `verify <plugin>` scripts that `TODO.md` deferred until a second plugin

## 7. Risks

- **Moving before the contract is complete.** Each workaround in a moved plugin hides an API gap, and freezing the API with that gap makes it permanent. Phase 0 exists to prevent this.
- **The trust model.** The shared layer and native libraries affect every plugin in the process. Keep the shared layer to drivers from the driver service and native libraries (§5), and do not weaken Phase 0.1's guard to save time.
- **Class-loading bugs.** The export model is harder to debug than one flat layer. Invest in the error messages (which plugin, which package, which dependency is missing) and in runner tests with real plugin pairs.
- **Two places to change.** For the duration of Phase 1, a JDBC bug might need a fix in core or here, depending on where the code lives at the time. Keep that window short: move a family in one go.
- **Version skew.** Users will run combinations nobody tested. Versioned dependencies (0.2) and testing against a pinned and the newest core (Phase 3) are the mitigation.
- **Core changes still need desktop releases.** Phase 0 is all core work. The faster release speed arrives after it, not during it.

## 8. Decisions

Taken:

| Date | Decision | Where |
|---|---|---|
| 2026-11-16 | Plugins share APIs by exporting packages to plugins that declare a dependency; the shared layer is only for drivers and native libraries | §5 |
| 2026-11-17 | JDBC drivers are never bundled: plugins compile against them, register them through the existing `jdbcDrivers` API, and core downloads them into the shared class loader | 0.3 |
| 2026-11-17 | Phase 0 starts with a MariaDB/MySQL dialect in this repository, built against core's working tree; the gaps it finds are fixed in core | Phase 0 |

Open:

| # | Decision | Suggested |
|---|---|---|
| 1 | Which features besides engines leave core (§3) | Only engines, catalogs and foundations for 1.0.0; revisit the rest after |
| 2 | How native libraries that are not a driver's companion reach the shared layer from external plugins (0.1); drivers and their companions are #7 | Through the driver service, which already installs companion native libraries (`companionArtifacts`, `libNative`), so no plugin ships into the shared layer; otherwise catalog-verified plugins only |
| 3 | Whether the JDBC API is exported by `queryengine.jdbc` itself or by a separate foundation plugin | By `queryengine.jdbc` itself: fewer plugins to install and version, unless several engines need the foundation without JDBC |
| 4 | Root POM version once something is published (§6) | Flatten published POMs; keep the `0-SNAPSHOT` aggregator |
| 5 | Bundled plugin set in the installer (Phase 2) | JDBC family, then payloadbuilder once moved; MongoDB optional |
| 6 | Plugin ids after the move | Keep today's ids (`queryengine.jdbc`, …) so settings and saved connections carry over; plugins from this repository are `com.queryeer.*` today, so decide whether moved ones are renamed with a migration or keep their ids |
| 7 | Which external driver registrations core manages, replacing `TRUSTED_CONTRIBUTIONS` (0.3) | Any registered driver, after the user confirms its first install in a dialog that shows the coordinates and the owning plugin. Central only, the checksum and the driver-class check already guard the download. Alternatives: catalog-verified plugins only (third-party dialects without a catalog entry fall back to a manual `libShared` jar), or the allowlist as data from the catalog |
