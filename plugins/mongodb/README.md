# Queryeer MongoDB Plugin

Native MongoDB query-engine support for Queryeer Desktop.

## Status

The first-milestone design is agreed (see [Design](#design)).

**Backend: implemented and tested.** This covers the engine, connections, query language, results, errors, cancellation, timeouts and packaging.
- It is tested with unit tests, Testcontainers tests against `mongo:7.0`, and an end-to-end smoke test in Queryeer's real backend runner.

**Frontend: implemented, not yet run in the Queryeer app.** It covers:
- the `.mongo` file type
- engine registration
- the connections settings editor, with a **Test connection** button
- a **MongoDB** sidebar view for MongoDB files, with connection and database pickers, plus a read-only "connection | database" label in the query editor status bar
- the execution-context provider

It builds against the local core checkout's `@queryeer/api` through a `file:` dependency, until `@queryeer/api` 0.19.0 is published. Then change `plugins/mongodb/frontend/package.json` to `"@queryeer/api": "^0.19.0"`.

Missing host APIs found along the way are tracked in [API-GAPS.md](../../API-GAPS.md).

GitHub Releases integration in Queryeer Desktop comes after the complete local plugin lifecycle is proven.

The plugin depends on public plugin APIs added to Queryeer Desktop in `@queryeer/api` 0.19.0:

- `context.queryEngines`: engine registration, `invoke`, execution-context providers, query events and editor status items
- `context.editorLanguages`
- `context.settings.getValue` / `subscribe`
- `context.components.PasswordFieldInput`
- `jdk.naming.dns` in the packaged runtime

## Decisions

- MongoDB will be the first separately released native query-engine plugin.
- This plugin is unrelated to Queryeer's existing PayloadBuilder MongoDB catalog integration.
- The plugin lives outside the Queryeer Desktop core repository. It lives in the shared `queryeer-desktop-plugins` repository for verified plugins, owned by the Queryeer Desktop owner, at `plugins/mongodb/`. It was moved here from the retired standalone `queryeer-desktop-mongodb` repository before that repository had any commits.
- Each plugin in the shared repository is versioned and released independently, so users never need to add several repositories.
- A plugin is "verified" when it is listed in the shared catalog, not because of where its code is hosted. Third-party plugins can be listed while staying in their own repositories.
- It should use Queryeer's public frontend and backend plugin APIs rather than adding MongoDB-specific behavior to core.
- One distributable plugin package should contain all required frontend and backend targets.
- Local folder loading and local ZIP installation must work without GitHub.
- GitHub Releases will later be an optional distribution and update source, not a runtime requirement.
- Elasticsearch joins the same shared repository as `plugins/elasticsearch/`, reusing the shared build tooling and release conventions proven here.

## Initial Goal

Build a minimal end-to-end native MongoDB engine that can:

1. Be loaded by Queryeer from a local development folder.
2. Define and persist MongoDB connection settings using Queryeer APIs.
3. Connect through the official MongoDB Java driver.
4. Execute a deliberately limited initial query format.
5. Return results through Queryeer's standard output facilities.
6. Report errors and support cancellation where the host APIs permit it.
7. Be packaged as an installable ZIP with `plugin.json` at its root.
8. Be installed, enabled, disabled, upgraded, and uninstalled through Queryeer's existing plugin management flow.

Complete `mongosh` language compatibility is not an initial requirement. The first query syntax should be small, explicit, and testable, such as JSON commands or a constrained MongoDB operation format.

## Intended Package Shape

The exact paths should follow the Queryeer plugin manifest and packaging contracts, but the resulting archive is expected to resemble:

```text
plugin.json
frontend/
  index.js
lib/
  queryeer-mongodb-plugin.jar
  ...runtime dependencies
```

The package may contain both targets:

- A frontend target for query-engine registration, connection UI, editor integration, and explorer integration.
- A backend target for MongoDB connectivity and query execution.

Frontend and backend targets should be versioned and replaced atomically as one plugin package.

## Design

Agreed design for the first milestone. It targets the Queryeer plugin APIs in `@queryeer/api` `^0.19.0` and `backend-api` (Java 25).

### Identity and Packaging

- Plugin ID `com.queryeer.mongodb`, first version `0.1.0`. The frontend and backend targets use the same ID.
- Java package `com.queryeer.plugin.mongodb`, Maven artifact `queryeer-mongodb-plugin`.
- Backend: Maven, Java 25, `backend-api` and `backend-contract` in `provided` scope, `org.mongodb:mongodb-driver-sync` 5.x. Each plugin gets its own child-first classloader, so the plugin's driver does not conflict with the driver Payloadbuilder uses.
- Frontend: TypeScript bundled by esbuild into one ESM file (`--external:react --external:react-dom`).
- A `package.cjs` script, modelled on `plugins-examples/payloadbuilder-catalog`, builds the ZIP: `plugin.json`, `frontend/index.js` and `lib/*.jar`. The manifest has no `classpath` block; the loader picks up `lib/*.jar` by convention.
- Supported install paths are the Plugin Manager ZIP installer and a local development folder. A loose ZIP dropped into the plugins directory is not supported, because the backend cannot load the nested `lib/` jars from it.
- Changes take effect after a restart; there is no hot reload.
- The shared plugins repository uses the `master` branch and the same license as Queryeer Desktop.

### Connections

- The plugin has its own settings module and connection list. It does not share Payloadbuilder's `core.queryengine.payloadbuilder.mongodb` connections.
- Connections are edited in a plugin-owned advanced settings renderer, modelled on Payloadbuilder's `MongoConnectionsSettingsEditor`. It uses `context.components.PasswordFieldInput`, so the password lives in the host vault and settings store only a `{ secretRef }`.
- Connection fields: name, hosts (`host:port`, comma-separated), SRV toggle, username, password, auth database (default `admin`), TLS toggle, "allow invalid certificates", default database, and extra URI options (e.g. `replicaSet=rs0&readPreference=secondary`).
- The auth mechanism is negotiated by the driver (SCRAM). X.509, AWS, LDAP and Kerberos are out of scope. Kerberos would also fail anyway, because the packaged runtime lacks `java.security.jgss`.
- `mongodb+srv://` depends on `jdk.naming.dns`, which core now adds to the packaged jlink runtime.
- The backend reads the settings module with `ConfigService` and resolves the password with `materializeSecrets`. A locked vault surfaces as `SECURITY_SESSION_CLOSED` so the host's unlock flow runs.
- The backend caches one `MongoClient` per connection ID, created on first use. A cached client is rebuilt when that connection's settings change. All clients are closed in `deactivate()`.

### Query Files and Binding

- Query files use extension `.mongo` and MIME type `application/vnd.queryeer.mongodb`, registered with:
  - `context.files.registerMimeResolver`
  - `context.queryEngines.registerEngine({ engineId: "mongodb", mimeTypes: [...] })`
  - `context.editorLanguages.registerMimeType(mime, "json")`
- Connection: `context.fileMediator.bindEngine(fileId, "mongodb", connectionId)`.
  - The execution-context provider sends the bound connection with every execution as `engineState.connectionId`, as JDBC does.
  - That is the source the backend trusts. The host opens the backend file session only on the first bind, so a later rebind never reaches the `FileSessionHandler`.
  - The backend falls back to the file session's connection only when `engineState` has none.
- Database: the selected database is stored per file with `context.files.setEditorState`. It is attached to each execution as `engineState.database` through `context.queryEngines.registerExecutionContextProvider("mongodb", ...)`.
- Backend `invoke` actions:
  - `mongodb.databases`: lists database names.
  - `mongodb.ping`: returns `{ ok, version }`.
  - Both take `{ connectionId }` or `{ engineState }` in the payload. The host wraps the return value as `result.result`.
- `context.queryEngines.onQueryEvent("mongodb", ...)` is not used yet. The backend returns no `engineState` patch, because the frontend already owns the connection and database selection.
- Connection and database pickers live in a **MongoDB** sidebar view: `layout.registerView({ when: "activeFile?.mimeType == 'application/vnd.queryeer.mongodb'" })`. That is the same pattern as JDBC's "SQL Databases" view, and the explorer tree lives there too (see [TODO.md](TODO.md)). A read-only "connection | database" label goes in the query editor status bar through `context.queryEngines.registerEditorStatusItem({ engineId: "mongodb", ... })`, like JDBC's.
  - Database lists are cached per connection and fetched silently, so switching tabs never triggers a vault prompt. The refresh button fetches interactively.
- State, following the same split as JDBC:

  | State | Where it lives | Survives a restart? |
  |---|---|---|
  | A file's connection | `engineBinding` | Yes, saved in the workspace |
  | A file's selected database | `files.setEditorState` → `persistentViewState` | Yes, saved in the workspace |
  | Database, collection and index lists | Memory caches per connection | No, re-fetched |
  | Explorer expanded nodes | Memory store per connection | No |

  The expanded nodes outlive the sidebar view, which unmounts while a non-MongoDB tab is active, so switching tabs doesn't collapse the tree.
- Connection when nothing is bound: if exactly one connection is enabled, files use it. Otherwise the picker says "Select connection…" and execution fails with a `VALIDATION` error naming the problem.
- Settings live in module `com.queryeer.mongodb`, setting `com.queryeer.mongodb.connections`, under **Settings → Query Engine → MongoDB**.
  - The editor uses the host's `CollectionSettingsListEditor` and `useCollectionSettingsPersistence` (from `context.components`), with plugin-rendered detail fields. The sidebar view's ⚙ action and its "Add connection…" button open this setting directly with `context.settings.open("com.queryeer.mongodb.connections")`.
  - **Test connection** calls the backend action `mongodb.testConnection` with the unsaved connection. It returns `{ ok, version }` or `{ ok: false, message }`.
- Registrations that return a `Disposable` are disposed in `deactivate`. Several host `register*` methods return nothing yet (API-GAPS.md F6).
- This is the same pattern the builtin JDBC engine uses.

### Query Language

- A query is one or more MongoDB `runCommand` documents in relaxed Extended JSON, e.g. `{ "find": "orders", "filter": { "status": "open" }, "limit": 50 }`.
- Several top-level documents in one file run in order, and each produces its own result set. Executing a selection runs only the selected text.
- The documents may be separated by whitespace or commas, or wrapped in one JSON array.
- `//` and `/* */` comments are allowed between documents but not inside them.
- Shell helpers such as `ObjectId("...")` and `ISODate("...")` are accepted.
- Every command is validated before any of them runs, so a rejected command anywhere in the file means nothing executes.
- Which database a command runs against:
  1. The optional `"$db"` key in the document; the plugin removes it before sending the command.
  2. Otherwise the file's selected database (`engineState.database`).
  3. Otherwise the connection's default database.
- The implementation is split into a parse stage (text → `{ database, command }`) and an execute stage (command → cursor → rows). A shell-style parser for `db.orders.find(...)`, the syntax most MongoDB tools use, can be added later as a second parser that produces the same commands. Text starting with `{` or `[` is JSON; text starting with `db.` is shell syntax.
- Allowed commands are read-only: `find`, `aggregate`, `count`, `distinct`, `listDatabases`, `listCollections`, `listIndexes`, `dbStats`, `collStats`, `explain`, `ping`, `buildInfo`. An `aggregate` containing `$out` or `$merge` is rejected.

### Results

- Results stream to the client through `QueryPublisher`: `resultSetStart`, then `resultSetRows` batches, then `completed` or `failed`.
- How each reply becomes rows:
  - Cursor commands (`find`, `aggregate`, `list*`): one row per document, streamed with `getMore` until the cursor is exhausted or the query is cancelled. The host table applies its own display row limit, as it does for JDBC.
  - `distinct`: one row per value, in a single `value` column.
  - `listDatabases`: one row per database.
  - All other commands: the reply document becomes a single row, without `ok`, `$clusterTime` and `operationTime`.
- Columns are the top-level keys of the first non-empty batch, in first-seen order.
- Keys that first appear in later documents are collected in a trailing `$extra` JSON column, because Queryeer cannot add columns to a result set that has already started. Users can fix the column set with a projection.
- `$extra` is only added when the cursor has more batches. A result that fits in one batch has exactly its keys as columns.
- BSON type mapping:

  | BSON | Column type | Cell |
  |---|---|---|
  | int32 | `int` | number |
  | int64 | `long` | number |
  | double | `double` | number (NaN/Infinity as text) |
  | Decimal128 | `decimal` | `BigDecimal`, as Payloadbuilder sends decimals (NaN/Infinity as text) |
  | boolean | `boolean` | boolean |
  | date | `datetimeoffset` | UTC date-time. Stored as a UTC instant, so it is sent with an explicit offset |
  | string | `string` | string |
  | ObjectId | `string` | hex string |
  | embedded document | `object` | JSON (large value) |
  | array | `array` | JSON (large value) |
  | Binary, Timestamp, Regex, MinKey, MaxKey, ... | `string` | Extended JSON |

- A key whose values have different types within the first batch gets the `any` column type.
- A later value that contradicts its column's type is sent as text, so the grid never receives a cell that disagrees with its column.
- Nested documents and arrays are sent as JSON large values through `LargeValueStore`, the same way Payloadbuilder sends them.

### Errors, Cancellation and Timeouts

- Invalid JSON fails as `VALIDATION`, with `line` and `column` in the error details. Commands not on the allowlist, and `$out`/`$merge` stages, also fail as `VALIDATION`.
- Driver and server errors are reported through `ErrorMessages`, with error codes from `BackendErrorCode`.
- Cancellation is cooperative. `cancel(queryExecutionId)`:
  1. sets a cancelled flag, which is checked between batches;
  2. closes the open cursor (`killCursors`);
  3. makes a best-effort `killOp` for the operation tagged `comment: "<queryExecutionId>"`, so a slow first batch also stops on the server. Every command carries that tag, including `getMore`, unless the user set their own `comment`;
  4. then reports `failed("CANCELLED")` immediately.
- The host's `options.timeoutMs` is enforced in two ways, and both report `TIMEOUT`:
  - The initial command uses the driver's client-side operation timeout (`timeoutMS`).
  - A watchdog fires at the deadline, reports `TIMEOUT` and stops the execution the same way cancel does. It is needed because the server rejects `maxTimeMS` on `getMore`, and a `getMore` without `batchSize` can fetch the rest of a cursor in one long call.
- Minimum server version is MongoDB 4.4, because of `comment` on all commands, including `getMore`. The tests run against MongoDB 7.0.
- The provider is thread-safe: each execution runs on its own host thread, and `invoke` and `cancel` may arrive concurrently.

### Testing

- Backend: JUnit 5, plus Testcontainers (`mongo:7.0`) tests that are skipped when Docker is not available. The tests use a `RecordingPublisher`, modelled on the one in the JDBC engine's tests, and cover:
  - command parsing and positions
  - the allowlist, including `$out`/`$merge` anywhere
  - type mapping
  - `$extra` handling
  - multiple result sets
  - database resolution
  - server errors
  - a locked vault
  - cancellation (both while streaming and with `killOp` of a slow server operation)
  - timeouts (on the initial command and across batches)
- Packaging (`shared/scripts/verify-package.mjs`, no Docker needed) checks:
  - `plugin.json` is at the archive root and valid against the vendored schema
  - the file name, entry names, `lib/` jars and the sha256
- End to end (`npm run mongodb:smoke`): runs the packaged plugin in Queryeer's real backend runner over the stdio protocol, against a throwaway MongoDB container. It needs a local Queryeer Desktop checkout with the backend built.
- Frontend: Vitest covers connection parsing, validation and serialisation, plus connection and database resolution for executions, along with a TypeScript typecheck against `@queryeer/api`. The React components have no DOM tests yet.
- Manual: install, restart, disable, upgrade and uninstall against Queryeer Desktop.

### Building

From the repository root (requires Java 25, Node 20+, and Docker for the Testcontainers and smoke tests):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspace (`plugins/*/frontend`), including `@queryeer/api` from npm |
| `npm run mongodb:test` | Runs the frontend typecheck and tests, then the backend tests |
| `npm run mongodb:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.mongodb-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.mongodb-<version>/` |
| `npm run mongodb:dev` | Frontend watch mode. Rebuilds on save, copies the bundle into the installed plugin, and installs `dist/…` first if it isn't installed. Then use **Reload Window** in Queryeer. Set `QUERYEER_PLUGINS_DIR` to use another plugins directory |
| `npm run mongodb:smoke` | Runs the end-to-end check in Queryeer's backend runner. Set `QUERYEER_DESKTOP_DIR` if the core checkout is not at `../queryeer-desktop/development` |

The plugin API comes from public registries: `@queryeer/api` from npm and `backend-api` / `backend-contract` from Maven Central, both 0.19.0. No Queryeer Desktop checkout is needed to build or test; only `mongodb:smoke` uses one.

The plugin version lives in three places (API-GAPS.md F11):
- `plugins/mongodb/plugin.json`
- the `<version>` in `plugins/mongodb/backend/pom.xml`
- `manifest.version` in `frontend/src/plugin.tsx`

The packaging script checks only the first two.

To try the plugin in Queryeer:
- either install `dist/com.queryeer.mongodb-<version>.zip` from **Tools → Plugins**,
- or copy the folder `dist/com.queryeer.mongodb-<version>/` into Queryeer's managed plugins directory (`%APPDATA%\queryeer-desktop\plugins` on Windows).

Then restart Queryeer.

**Development loop.** Queryeer has no hot reload for external plugins: it loads them once at startup and doesn't watch files.

| Change | How to pick it up |
|---|---|
| Frontend | Keep `npm run mongodb:dev` running and use **Reload Window** after saving. No app restart needed. |
| Backend | Use the Testcontainers tests and `npm run mongodb:smoke`. They need no app. To try a backend change in Queryeer: re-run `npm run mongodb:package`, quit Queryeer (Windows locks the plugin jars), replace the installed folder, and start Queryeer again. |

What core could add to shorten this is listed under "Developer experience" in [API-GAPS.md](../../API-GAPS.md) (D1–D4).

If npm blocks esbuild's install script (`npm warn install-scripts`), the build still works because the platform binary comes from esbuild's optional dependency. `npm install-scripts approve esbuild` silences the warning.

### Deferred

- Shell-style query syntax.
- Completion and hover for MongoDB commands.
- Write commands.
- Letting a started result set gain columns, which needs a protocol change in Queryeer.
- GitHub Releases distribution (see [GitHub Releases Follow-up](../../README.md#github-releases-follow-up)).

## Development Order

1. ✅ Inspect the current Queryeer plugin examples and public APIs.
2. ✅ Backend and frontend builds. The frontend uses a `file:` link to the local `@queryeer/api` until 0.19.0 is published.
3. ✅ Add a valid root `plugin.json`. The plugin loads and activates in the real backend runner.
4. ✅ Engine registered on both the backend and the frontend.
5. ✅ Connection settings, vault-resolved passwords, settings editor with Test connection, and the MongoDB sidebar view with connection and database pickers.
6. ✅ End-to-end execution and standard result output (backend protocol).
7. ✅ Focused tests for connections, execution, errors, cancellation and timeouts.
8. ✅ Produce and validate the installable ZIP, which now includes the frontend.
9. Exercise the frontend, installation and replacement in Queryeer Desktop (manual; next).
10. Add the release workflow and the plugin's first catalog entry (see [Repository and Releases](../../README.md#repository-and-releases)).

## Queryeer Host APIs

The Queryeer core plugin context now exposes the generic capabilities needed by this plugin:

```ts
context.queryEngines.registerEngine({
  engineId: "mongodb",
  mimeTypes: ["application/vnd.queryeer.mongodb"]
});

context.queryEngines.registerExecutionContextProvider("mongodb", ({ fileId }) => ({
  engineState: { database: /* from context.files.getEditorState(fileId, ...) */ undefined }
}));
context.queryEngines.onQueryEvent("mongodb", (event, execution) => { /* sync engineState */ });

await context.queryEngines.invoke({
  engineId: "mongodb",
  action: "mongodb.databases"
});

context.queryEngines.registerEditorStatusItem({ id: "...", engineId: "mongodb", render: ... });
context.fileMediator.bindEngine(fileId, "mongodb", connectionId);
context.settings.getValue(...);
context.settings.subscribe(...);
context.editorLanguages.registerMimeType("application/vnd.queryeer.mongodb", "json");
context.components.PasswordFieldInput;
```

The backend provider must register the matching `mongodb` engine ID through the Java `BackendPluginContext.queryEngines()` registry. The frontend should invoke the backend only through `context.queryEngines.invoke`, which keeps Queryeer's backend-health checks and vault-unlock retry.

All registrations return a `Disposable`, and settings subscriptions return a cleanup function. Release them in `deactivate()`. `settings.getValue` returns `undefined` until the settings service is ready, so read settings needed at activation from a `settings.subscribe` callback.

The packaged Java runtime includes `jdk.naming.dns`, allowing the MongoDB driver to resolve `mongodb+srv` records. This still needs an end-to-end packaged-runtime test with the plugin.

## First-Milestone Acceptance Criteria

- A clean checkout can build the complete plugin package.
- Queryeer can load the plugin locally without changes specific to MongoDB in core.
- A user can configure a MongoDB connection and execute the initial supported query format.
- Results and failures are presented through Queryeer's normal engine/output contracts.
- The generated ZIP installs through Queryeer's existing local plugin installer.
- Plugin state survives a Queryeer restart.
- Disable, upgrade, and uninstall behavior has been exercised.
- Automated tests cover the main execution path and package structure.

## Related Source

The Queryeer Desktop development repository is expected locally at:

```text
C:\Projects\github\queryeer-desktop\development
```

Relevant starting references there include `DEVELOPMENT-PLUGIN.md`, `plugins-examples/`, the plugin schema under `plugin-schema/`, and the public contracts under `queryeer-desktop/packages/api/` and `queryeer-backend/backend-api/`.
