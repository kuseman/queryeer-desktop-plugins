# Queryeer MongoDB Plugin

Native MongoDB query-engine support for Queryeer Desktop.

## Status

This repository is an initial scaffold. The design for the first milestone is agreed (see [Design](#design)). Implementation should begin by proving the complete local plugin lifecycle before adding GitHub Releases integration to Queryeer Desktop.

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
- Connection: `context.fileMediator.bindEngine(fileId, "mongodb", connectionId)`. The backend receives it through its `FileSessionHandler` file session.
- Database: the selected database is stored per file with `context.files.setEditorState`. It is attached to each execution as `engineState.database` through `context.queryEngines.registerExecutionContextProvider("mongodb", ...)`.
- `context.queryEngines.onQueryEvent("mongodb", ...)` reads `engineState` back from completed executions, so the UI stays in sync.
- Connection and database pickers are status items registered with `context.queryEngines.registerEditorStatusItem({ engineId: "mongodb", ... })`.
- Every registration returns a `Disposable`, which is disposed in `deactivate`.
- This is the same pattern the builtin JDBC engine uses.

### Query Language

- A query is one or more MongoDB `runCommand` documents in relaxed Extended JSON, e.g. `{ "find": "orders", "filter": { "status": "open" }, "limit": 50 }`.
- Several top-level documents in one file run in order, and each produces its own result set. Executing a selection runs only the selected text.
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
  - All other commands: the reply document becomes a single row.
- Columns are the top-level keys of the first batch, in first-seen order. Keys that first appear in later documents are collected in a trailing `$extra` JSON column, because Queryeer cannot add columns to a result set that has already started. Users can fix the column set with a projection.
- BSON type mapping:

  | BSON | Column type | Cell |
  |---|---|---|
  | int32 | `int` | number |
  | int64 | `long` | number |
  | double | `double` | number |
  | Decimal128 | `decimal` | string |
  | boolean | `boolean` | boolean |
  | date | `datetime` | ISO-8601 string |
  | string | `string` | string |
  | ObjectId | `string` | hex string |
  | embedded document | `object` | JSON (large value) |
  | array | `array` | JSON (large value) |
  | Binary, Timestamp, Regex, MinKey, MaxKey, ... | `string` | Extended JSON |

- A key whose values have different types within the first batch gets the `any` column type.
- Nested documents and arrays are sent as JSON large values through `LargeValueStore`, the same way Payloadbuilder sends them.

### Errors, Cancellation and Timeouts

- Invalid JSON fails as `VALIDATION`, with `line` and `column` in the error details. Commands not on the allowlist, and `$out`/`$merge` stages, also fail as `VALIDATION`.
- Driver and server errors are reported through `ErrorMessages`, with error codes from `BackendErrorCode`.
- Cancellation is cooperative. `cancel(queryExecutionId)`:
  1. sets a cancelled flag, which is checked between batches;
  2. closes the open cursor (`killCursors`);
  3. makes a best-effort `killOp` for the operation tagged `comment: "<queryExecutionId>"` (every command carries that tag), so a slow first batch also stops on the server;
  4. then reports `failed("CANCELLED")` immediately.
- The host's `options.timeoutMs` maps to the driver's client-side operation timeout (`timeoutMS`) and is reported as `TIMEOUT`.
- The provider is thread-safe: each execution runs on its own host thread, and `invoke` and `cancel` may arrive concurrently.

### Testing

- Backend: JUnit 5 with Testcontainers MongoDB. The tests use a `RecordingPublisher`, modelled on the one in the JDBC engine's tests, and cover:
  - command parsing
  - the allowlist
  - type mapping
  - `$extra` handling
  - multiple result sets
  - errors, cancellation and timeouts
- Frontend: Vitest with a mocked `PluginContext`.
- Packaging: a Docker-free test that checks the ZIP layout and that `plugin.json` validates against `plugin-schema/plugin.json.schema.v1.json`.
- Manual: install, restart, disable, upgrade and uninstall against Queryeer Desktop.

### Deferred

- A MongoDB explorer tree (databases → collections → indexes) as a plugin-owned view registered with `context.layout.registerView`, fed by `context.queryEngines.invoke`.
- Shell-style query syntax.
- Completion and hover for MongoDB commands.
- Write commands.
- Letting a started result set gain columns, which needs a protocol change in Queryeer.
- GitHub Releases distribution (see [GitHub Releases Follow-up](../../README.md#github-releases-follow-up)).

## Development Order

1. Inspect the current Queryeer plugin examples and public APIs.
2. Establish the repository build for the frontend and backend targets.
3. Add a valid root `plugin.json` and load a no-op plugin locally.
4. Register a minimal native MongoDB query engine.
5. Add connection configuration and credential handling through host APIs.
6. Implement one end-to-end query operation and standard result output.
7. Add focused tests for connection validation, execution, errors, and cancellation.
8. Produce and validate the installable ZIP.
9. Exercise installation and replacement against Queryeer Desktop.
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
