# Plan: engines contribute their own payloadbuilder catalogs

Status: plan, 2026-11-19, for Queryeer 0.21. All decisions in §5 are taken.

## 1. Goal

The plugin that owns a kind of connection also owns the payloadbuilder catalog for it. Payloadbuilder knows no engine.

- MongoDB, Kafka and JDBC connections are defined once and used both by their own engine and by payloadbuilder. Today payloadbuilder keeps a second list of Mongo, Kafka and Elasticsearch connections.
- Payloadbuilder works without any of them. A catalog appears when the plugin that provides it is installed.
- The MongoDB plugin works with or without payloadbuilder, as one installable plugin.

Agreed with the user on 2026-11-19 (hand-off notes). This plan works out the details.

**How it fits [`v1-milestone.md`](v1-milestone.md):** it is a Phase 0 item, done in core before the moves. Phase 4 then moves payloadbuilder without the Mongo, Kafka and JDBC catalogs inside it, and Phase 1 moves the JDBC family together with its catalog. It also settles part of §5: the payloadbuilder foundation leaves the shared layer.

## 2. Today

**Backend.**
- `queryengine.payloadbuilder` builds all catalogs itself (`PayloadbuilderCatalogProviderRegistry.defaults`): JDBC, Elasticsearch, Kafka, MongoDB, filesystem, HTTP.
- It depends on `queryengine.jdbc` for two reasons:
  - the JDBC catalog, through `JdbcRuntimeService` and `JdbcSqlEditorServices`;
  - its own SQL editor support, through the SQL parser (`PayloadbuilderSqlSemanticHandler`, `TreeSitterSqlParseFunction`), which `queryengine.jdbc` bundles and exports.
- The implementations come from one upstream jar, `se.kuseman.payloadbuilder:payloadbuilder-catalog` 1.14.0. It holds every catalog package (`es`, `fs`, `http`, `jdbc`, `kafka`, `mongodb`) and pulls in `mongodb-driver-sync`, `kafka-clients` and `httpclient5`.
- External plugins can already add catalogs:
  - The SPI is `PayloadbuilderCatalogProviderContributor`.
  - A plugin gets the registry with `context.services().get(PayloadbuilderCatalogProviderRegistry.class)` and calls `registerContributor`, with a hard dependency on `queryengine.payloadbuilder`.
- The SPI and `se.kuseman.payloadbuilder.api.` sit in the shared layer: `queryengine.runtime.payloadbuilder-foundation`, with parent-first packages.

**Frontend.**
- One built-in plugin per catalog: `core.queryengine.payloadbuilder.{jdbc,mongodb,kafka,elasticsearch,http,filesystem}`.
- Each registers a `PayloadbuilderCatalogContribution`:
  - `renderPanel` is the per-alias panel, with its connection picker;
  - `filterPersistedProperties` and `resolveRuntimeProperties` say what a file stores, for example `{ connectionId }`.
- Each catalog plugin reads its own connection settings: the Mongo panel lists `core.queryengine.payloadbuilder.mongodb.connections`.
- External plugins already have the public equivalent: `context.payloadbuilderCatalog.registerContribution(...)` in `@queryeer/api`.

**So most of the API exists.** This answers the open question from the hand-off ("how payloadbuilder's UI lists catalog connections"): the contribution's own panel does, so the owning plugin shows its own connections. What is missing:
- a way to depend on payloadbuilder without requiring it;
- payloadbuilder's foundation as an export instead of the shared layer;
- the SQL parser outside `queryengine.jdbc`;
- a home for each catalog's implementation outside payloadbuilder.

## 3. Design

### 3.1 Optional dependencies (core)

A dependency entry gets `"optional": true`:

```json
"dependencies": [
  { "id": "queryengine.payloadbuilder", "version": ">=0.21.0 <1.0.0", "optional": true }
]
```

One list rather than a separate `optionalDependencies`. Version ranges, the schema and the docs then cover both kinds the same way.

**When the dependency is loaded, it behaves like a required dependency:**
- it activates first;
- its exports are visible;
- its version range is checked.

**When it isn't loaded,** because it is missing, skipped, failed or in a cycle:
- the plugin still loads;
- the dependency's exports aren't visible;
- `context.services().get(...)` returns null for its services.

**When the range doesn't match, the dependency is treated as absent** (decided, §5). The plugin loads, with a warning naming the range: "Optional dependency queryengine.payloadbuilder ^0.21.0 not used: 0.22.0 is installed". On a `-SNAPSHOT` dependency the range isn't enforced, as for required dependencies.

**Where it is implemented:**
- `PluginValidation.planActivation`: an optional dependency never produces a skip reason. When present, it adds an ordering edge (`topologicalSort`). The cycle check counts that edge only when the dependency is present.
- `PluginClassLoaderFactory`: exports come from optional dependencies that are present, and never from ones that aren't loaded. `publishExports` already runs after discovery has settled which plugins are kept. It also has to know which ones validation then skipped, so that a skipped plugin's exports aren't visible. Check whether that is already true for required dependencies; their dependents are skipped too, so it never mattered.
- The schema (`plugin.json.schema.v1.json`), `PluginManifestValidation`, and `DEVELOPMENT-PLUGIN.md` §3.3.
- The frontend has no counterpart to build. Catalog contributions go through `context.payloadbuilderCatalog`, which core provides whether or not payloadbuilder is active. A contribution without payloadbuilder is inert.

**Pattern for the plugin's code.** Classes that refer to the optional dependency's types must be loaded only when it is present:

```java
public void activate(BackendPluginContext context, PluginDescriptor descriptor)
{
    // ... the plugin's own engine ...
    if (context.services().get(PayloadbuilderCatalogProviderRegistry.class) != null)
    {
        MongoPayloadbuilderCatalog.register(context, connections); // the only class that imports payloadbuilder types
    }
}
```

The `services().get` call names a payloadbuilder type itself. So the check has to sit inside the holder class too, or use a class-name lookup (`services().find("...")`). **Decided (§5):** a small helper in `backend-api` for this, for example `context.optionalDependency("queryengine.payloadbuilder")` returning whether it is active, so plugins never touch the type before they know.

### 3.2 Payloadbuilder's foundation becomes an export (core)

- `queryengine.payloadbuilder` bundles `backend-lib-queryengine-payloadbuilder-foundation` and `payloadbuilder-api`, and exports `com.queryeer.backend.queryengine.payloadbuilder.` and `se.kuseman.payloadbuilder.api.`.
- `queryengine.runtime.payloadbuilder-foundation` is removed, as the JDBC and parser runtime plugins were in 0.20.0.
- `se.kuseman.payloadbuilder.api.` in the export is the engine's own API: catalogs implement `Catalog` and get an `IQuerySession`. So §5 rule 2 (no third-party types in an exported API) doesn't apply; this is the API.
- **Who breaks:** plugins that use the SPI without declaring `queryengine.payloadbuilder`. Plugins that declare it keep working. It goes into the 0.21 upgrade notes, like §11 of `DEVELOPMENT-PLUGIN.md` for 0.20.

### 3.3 The SQL parser becomes its own built-in plugin (core)

- New built-in plugin `queryengine.sql.parser`:
  - it bundles `backend-lib-queryengine-sql-parser` and tree-sitter;
  - it exports `com.queryeer.backend.queryengine.sql.parser.`;
  - tree-sitter stays private, as today.
- `queryengine.jdbc` and `queryengine.payloadbuilder` both depend on it. `queryengine.jdbc` stops bundling and exporting the parser.
- **Who breaks:** external plugins that use the parser through `queryengine.jdbc`. Exports aren't passed on, so they have to add `queryengine.sql.parser`. The MySQL dialect doesn't use the parser. Upgrade notes.
- **Check:** tree-sitter loads its native library from the jar. That must keep working from the new plugin's class loader. The JDBC plugin does the same today, so it should.

### 3.4 Where each catalog's implementation lives

Each catalog contributor needs its package from `payloadbuilder-catalog`. **Decided 2026-11-19: split the artifact upstream first,** in a payloadbuilder release. After that, `payloadbuilder-catalog` is no longer published, or only as a POM that depends on all the parts.

The catalogs don't refer to each other (checked on 1.15.0-SNAPSHOT). The details are in payloadbuilder's `documentation/catalog-split.md`:
- `payloadbuilder-catalog-{es,fs,http,jdbc,kafka,mongodb}`, each with only its own libraries;
- `payloadbuilder-catalog-common` for the three shared root-package classes, with httpclient5 optional so the Mongo and JDBC catalogs don't pull it in.
- Package names stay the same. Common jars bundled by several plugins don't clash, since each copy is private to its plugin's class loader.

Then:
- payloadbuilder bundles `catalog-fs`, `catalog-http` and, until Elasticsearch moves, `catalog-es`;
- the JDBC bridge bundles `catalog-jdbc`;
- the MongoDB plugin bundles `catalog-mongodb`;
- `com.queryeer.kafka` bundles `catalog-kafka`.

The alternative was bundling the whole jar with exclusions in every contributor; it duplicates the jar and needs exclusion lists.

**For the built-in JDBC catalog** (decided: the bridge, §5):
- **Bridge:** a small built-in backend plugin `queryengine.payloadbuilder.jdbc` that requires both `queryengine.jdbc` and `queryengine.payloadbuilder`. It mirrors the frontend's existing `core.queryengine.payloadbuilder.jdbc`. No optional dependency and no lazy-class pattern are needed. It is skipped when either side is missing.
- **In `queryengine.jdbc`:** with an optional dependency on payloadbuilder, as the external plugins will do.

Either way, payloadbuilder loses its dependency on `queryengine.jdbc`. Recommendation: the bridge for built-ins, since it costs nothing and moves to this repository with the JDBC family in Phase 1 as it is. Optional dependencies are for external plugins, where users install one ZIP.

### 3.5 MongoDB (this repository)

**Backend.**
- `plugin.json` declares payloadbuilder as an optional dependency.
- On activation, when payloadbuilder is there, the plugin registers a contributor with catalog id `mongodb`. That is the same id as today, so existing payloadbuilder files keep their catalog configuration.
- The contributor reads `com.queryeer.mongodb.connections` and maps a connection to the catalog's properties:
  - the connection string, built by the plugin's `MongoConnectionSettings.connectionString()`;
  - user name, password and auth database. The password goes through `configService.materializeSecrets`.
- **The plugin owns the client version.** It declares `mongodb-driver-sync` directly, so Maven bundles the plugin's version, as one copy. `payloadbuilder-catalog-mongodb` declares the driver too, for standalone payloadbuilder users, but the plugin's version wins. A driver fix then ships with a plugin release, without waiting for payloadbuilder.
  - **Guard against drift:** a Testcontainers test runs a payloadbuilder query through the plugin's `mongodb` catalog with the plugin's driver. A major version change of the driver moves both sides together.
  - The same applies to `com.queryeer.kafka` and `kafka-clients`. JDBC has no client to own: drivers come from the driver service.

**Frontend.**
- `context.payloadbuilderCatalog.registerContribution({ catalogId: "mongodb", ... })`, with a panel that lists the plugin's connections and stores `{ connectionId }`.

**Core.**
- Core removes the backend `MongoCatalogProvider` and the frontend `core.queryengine.payloadbuilder.mongodb` in the same core release that the MongoDB plugin release supporting this targets. Release notes: install the MongoDB plugin to keep the `mongodb` catalog.

**No migration** (decided 2026-11-20). The built-in Mongo catalog's connections (`core.queryengine.payloadbuilder.mongodb`) were used by hardly anyone, so the plugin doesn't copy them: users add their connections in the plugin. Files that used the `mongodb` catalog keep their alias, but the `connectionId` must be picked again. If a migration is wanted later after all, core 0.21 has what it needs: `settings.runOnce`, `readModuleValues`, `setValue` and `appShell.copySecret` (DEVELOPMENT-PLUGIN.md §7.7.1).

**Taking over the catalog while core still ships it.** Core 0.21 lets a plugin's catalog replace the built-in one with the same id (backend and frontend), so the plugin can ship before core drops its built-in catalog.

### 3.6 JDBC (core, then Phase 1)

- The JDBC catalog code moves out of `backend-plugin-payloadbuilder`. The bridge (§3.4) holds `JdbcCatalogProvider` and `PayloadbuilderJdbcSqlEditorServices`.
- Nothing migrates: JDBC connections are already shared.

### 3.7 Kafka (new plugin in this repository, after MongoDB)

- `com.queryeer.kafka`:
  - it holds the Kafka connections (its own settings module);
  - it registers the `kafka` catalog;
  - at first it requires payloadbuilder, since the catalog is all it does;
  - later it gets a lightweight Kafka browser (topics, consumer groups, messages), and the dependency becomes optional.
- Migration of `core.queryengine.payloadbuilder.kafka.connections`: open; decide when the plugin is built (MongoDB skipped it, §3.5). If it migrates, use `settings.runOnce` and `appShell.copySecret` (never share a `secretRef`).
- Core removes `KafkaCatalogProvider` and `core.queryengine.payloadbuilder.kafka` in the release this plugin targets.
- Elasticsearch can follow the same way later. Filesystem and HTTP have no connections and stay with payloadbuilder.

## 4. Order and exit criteria

0. **Payloadbuilder: release the split catalog artifacts** (§3.4). Core's payloadbuilder plugin switches to them, with no change in behaviour.
1. **Core: optional dependencies, payloadbuilder foundation as an export, the SQL parser plugin** (§3.1–3.3).
   - Exit: a test plugin pair, where the optional dependency is present (ordered after it, exports visible, service found) or absent (loads, no exports, null service).
   - Exit: payloadbuilder runs with `queryengine.jdbc` removed. With the bridge, the JDBC catalog disappears and nothing else does.
   - Exit: the MySQL dialect still loads.
2. **Core: the JDBC bridge** (§3.6). Exit: the JDBC catalog works as before, from the bridge.
3. **MongoDB plugin release, then the core release that drops the built-in Mongo catalog** (§3.5).
   - Exit: a file using the `mongodb` catalog works after picking a connection from the plugin's connections.
   - Exit: the MongoDB plugin still works with payloadbuilder absent.
4. **`com.queryeer.kafka`, then core drops the built-in Kafka catalog** (§3.7).

Steps 1 and 2 go into 0.21 together. They don't wait for the payloadbuilder release: until it is out, the bridge bundles the combined `payloadbuilder-catalog` 1.14.0 and switches to `payloadbuilder-catalog-jdbc` afterwards. Steps 3 and 4 each need their plugin released before the core release that drops the built-in catalog, so users can switch in one update.

## 5. Decisions

| # | Question | Recommendation |
|---|---|---|
| 1 | How catalog implementations reach the contributing plugin (§3.4) | **Decided 2026-11-19:** split `payloadbuilder-catalog` upstream first |
| 2 | Built-in JDBC catalog: a bridge plugin or an optional dependency in `queryengine.jdbc` (§3.4) | **Decided 2026-11-19:** a bridge plugin, `queryengine.payloadbuilder.jdbc` |
| 3 | An optional dependency whose range doesn't match: treat it as absent, or skip the plugin (§3.1) | **Decided 2026-11-19:** absent, with a warning |
| 4 | A helper so plugins can test for an optional dependency without touching its types (§3.1) | **Decided 2026-11-19:** yes, in `backend-api` |
| 5 | The SQL parser plugin's id | **Decided 2026-11-19:** `queryengine.sql.parser` |
