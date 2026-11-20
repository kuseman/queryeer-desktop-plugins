# MongoDB Plugin TODO

Polish roadmap, in priority order, agreed on 2026-11-13. Tick items off as they land. Larger deferred features are under **Deferred** in the [README](README.md#deferred).

**Guiding principle:** borrow Compass's ideas, not its architecture. UI tools write the command (`find`/`aggregate`) into a `.mongo` editor and run it through the normal engine. Queries stay visible, editable and saveable, and the backend barely changes.

## 1. Explorer tree (done 2026-11-13)

In the MongoDB sidebar view, below the connection and database pickers.

- [x] Tree: databases → collections (with estimated document counts, views marked) → indexes, loaded lazily per level
- [x] Backend `invoke` actions `mongodb.collections` and `mongodb.indexes`, covered by Testcontainers tests
- [x] Collection actions open a **new** `.mongo` file per action, bound to the connection and database, and run it. Clicking the name means Browse; ⋯ shows all actions:
  - **Browse**: `find`, limit 50
  - **Sample**: `$sample`, 20 documents
  - **Count**
  - **Schema**: the field frequency and types query over a 1,000-document sample
  - **Indexes**: `listIndexes`
- [x] Refresh per database. Caches are keyed by connection and cleared when connection settings change.
- [x] Verified in Queryeer (2026-11-13): the new tab gets its text and runs.
- [x] Collection children grouped into folders, like JDBC's Columns / Indexes:
  - **Fields**: sampled from up to 1,000 documents with a 10-second server limit, showing types and how often each field occurs. `_id` comes first, then the most common. Each field has a ⋯ **Distinct values** action.
  - **Indexes**: views have none.
  - Each folder has its own ↻.
- [x] Database children grouped into folders: **Collections**, plus **Views** and **System** when there are any, each with a count. Collections opens automatically the first time a database is expanded.
  - Time-series collections get a "time series" badge, with time, meta field and granularity in the tooltip. Their estimated count is shown too.
  - GridFS buckets (`X.files` + `X.chunks`) become one node "X" with a "GridFS" badge. Actions run on `X.files`.
  - Views show their source collection and pipeline in the tooltip.
  - `system.*` goes under System (profile, views, js, time-series buckets).
- [x] **Validator** row under collections that have validation rules (`$jsonSchema` or query operators, from `listCollections` options). The tooltip shows the rules plus level and action. A badge marks non-default enforcement such as "warn" or "moderate". Clicking shows the collection definition (`listCollections` filtered by name).
- [x] ⋯ on a database: **Stats** (`dbStats`, sizes in bytes) and, when `system.profile` exists, **Slowest queries**: `find` on `system.profile`, sorted by `millis`, top 50, with op, namespace, plan summary, keys/docs examined, returned and the command. Also in `system.profile`'s own ⋯ menu.
- [x] Verified in Queryeer (2026-11-13): Fields/Indexes folders, Ctrl+click reuse with undo, expansion kept across tab switches.
- [x] Ctrl+click (⌘+click on macOS) on a collection or action runs the query in the current MongoDB tab instead of a new one. The text is replaced as one undoable edit and the tab is rebound to the target connection and database. Falls back to a new tab when the active editor is not a MongoDB file.

## 2. Query bar

Redesigned 2026-11-13. Plain Filter/Projection/Sort text fields duplicated the editor, so the bar is now schema-aware builders writing one way into the editor.

- [x] Lives in the query editor's header strip (`queryEngines.registerEditorHeaderItem`, API-GAPS.md F17), collapsible per file with the title "Query"
- [x] **One way, live:** every change writes a `find` into the editor at once, so the editor always shows what Run or F5 executes. The bar never parses the editor (`queryBarModel.ts`).
- [x] **Hand-edit lock:** the bar keeps its state and the exact text it last wrote per file (editor state `com.queryeer.mongodb.queryBar`).
  - Editor text that differs from that text means it was edited by hand: the bar steps aside and offers "Take over again". Ctrl+Z undoes the takeover.
  - An empty editor counts as owned.
  - A command the bar didn't write offers "Use the query bar", with the collection prefilled from it.
- [x] Explorer Browse seeds the bar, so a browsed tab starts with the bar on
- [x] Collection picker, suggested from the explorer's cache (loaded on demand)
- [x] **Fields** builder: sampled fields with types, "Show only checked" or "Hide checked", search, Clear, ↻ to sample again
- [x] **Sort** builder: add fields in order, flip ↑/↓, remove
- [x] Limit (20/50/100/500/1000/none), ◀ / ▶ paging with a range label, Run
- [x] Popovers are portalled to `document.body`, because the editor's text pane clips overflow
- [x] **Filter** builder: rows of field · operator · value type · value, matching all (AND) or any (OR)
  - The value type starts from the field's sampled types and can be changed (text, number, decimal, date, ObjectId, true/false, null). Values are written as Extended JSON (`$date`, `$oid`, `$numberDecimal`, `$numberLong` beyond 2^53).
  - Operators per type: = ≠ > ≥ < ≤, is one of / is none of (comma-separated; quotes keep a comma), contains (ignores case), starts with, matches regex, exists, is missing
  - AND stays one flat document, with ranges on one field merged (`{ total: { $gte: 10, $lt: 20 } }`), falling back to `$and`. Invalid rows stay in the bar, marked, and are left out of the query.
  - "Other field…" takes a typed path such as `address.city`
  - Picking a field sampled only as documents or arrays continues as typing below it (`payload.source.`), focused, so deeper paths can be written; leaving without typing more keeps the field and returns to the list. "Other field…" on such a field starts below it too.
  - Value text applies on blur or Enter, not per keystroke, so the editor's undo history stays usable. Enter also runs.
- [x] Embedded fields one level down (`payload.orderId`, `address.city`) in the field sample, in the same aggregation
  - Shown under their parent in the explorer, and with the parent dimmed in the query bar's lists
  - At most 200 per parent, so map-like documents (IDs or dates as keys) do not flood the lists. Keys that dot notation cannot address (with `.` or a leading `$`) are left out.
  - Checking a field in Fields unchecks its parent or its own fields, since MongoDB rejects both in one projection (path collision)
  - A field sampled only as embedded documents (at any level, e.g. `payload` or `payload.source`) offers only exists / is missing in Filter, and Sort leaves out fields sampled only as documents or arrays. Fields and the explorer list everything. Arrays stay in Filter, since `{ "tags": "a" }` matches any element.
- [x] Value suggestions in filter rows (text and number fields; comparisons and is one of / is none of)
  - A list under the value input when the field has at most 50 distinct values. For lists, each suggestion adds one more value to what is typed.
  - Collections up to 100,000 documents are read in full ($group, 2 s limit). Larger ones read a random sample of 1,000 documents, because a full scan rarely finishes in time; the row then says so in visible text ("Other values may exist"). Views and time-series collections are always read in full.
  - Not for `_id`, dates, ObjectIds, or contains / starts with / regex
- [x] Array fields: conditions are typed from the sampled element types (`categoryIds = 181` compares numbers)
- [ ] Later, maybe: embedded fields inside arrays (`items.sku`) and more than one level down. Waiting, to keep the bar uncluttered (2026-11-15):
  - Conditions on fields of the same array element need one `$elemMatch`; separate conditions may each match a different element (seen on real data: `activation` arrays with `salesBrand`/`market`/`active`). The bar would group such conditions into one `$elemMatch`, labelled as matching the same element.
  - Sampling would go a few levels deep through documents and arrays of documents, capped; value suggestions would unwind each array on the path.
  - Until then: the "find with $elemMatch" template, JSON and shell
- [ ] Later, maybe: read hand-written finds back into the bar (needs a value parser)
- [x] Verified in Queryeer (2026-11-14): query bar and collection combobox

## 3. Grid cell actions

Through the public `tableOutputContextMenu`.

- [x] **Filter: field = value** and **Exclude: field ≠ value** on selected cells. Several values in one column become is one of / is none of, and several columns add one condition each (Filter only). The condition is added to the query bar's filter with AND, and the query runs.
  - Only when the query bar wrote what the editor holds (never over hand edits), and not when the filter matches any of several conditions, which one more condition would change
  - Types come from the column, and from the field sample for what the grid cannot tell apart: an ObjectId arrives as hex text, so a 24-hex value is an ObjectId only in a field sampled as one
- [x] **Copy value as Extended JSON** for one cell (relaxed: `{"$oid": …}`, `{"$date": …}`, `{"$numberDecimal": …}`; embedded documents as the server wrote them)
- [x] **Copy document(s) as Extended JSON** for the selected rows: fetched again by `_id` (`mongodb.documents`), so the copy is the whole document, not just the shown fields. When that is not possible (no `_id` column, an aggregation's output), it is rebuilt from the cells, leaving out null cells.
- [ ] Large cells (over 16 KB) have no "Copy value": plugins only get a preview (API-GAPS.md F21)

## 4. Small polish

- [x] **Connection colour**, like JDBC connections: an optional `#rrggbb` `color` per connection (swatch and clear in the connection editor; the backend ignores it), shown on the "connection | database" status label and as an accent bar on the connection's tabs (`layout.registerTabHeaderStyle`, own `qmongo-tab-accent` class matching JDBC's)
- [x] Warn when an empty result comes from a collection that does not exist (MongoDB returns nothing instead of an error), with a "Did you mean" for names up to 2 edits away. One `listCollections`, only after empty find / aggregate / count / distinct results.
- [x] **Fill from connection string**: paste a `mongodb://` / `mongodb+srv://` string in the connection editor to fill hosts, SRV, username, authentication database (driver rules: `authSource`, else the path database, else `admin`), default database, TLS flags and the remaining options. The string is applied at once and not kept. A password in it is left out with a note to type it into Password: plugins cannot write to the vault (API-GAPS.md F23).
- [x] **Templates** menu in the query bar (also while it is off): find, aggregate, count and distinct on the current collection, replacing the editor text (Ctrl+Z undoes). Not as new-file content: any text in a new file would turn the query bar off.
  - Each as a JSON command and as a shell statement (`countDocuments` in shell form); collection names that are not dotted identifiers use `db.getCollection("…")`. `ShellParserTest.shellTemplatesMatchTheirJsonTwins` checks that both forms run the same command.
- [x] Changelog generated from this plugin's commits since each `mongodb/v*` tag (`shared/scripts/generate-changelog.mjs`), packaged into the backend JAR and registered with `context.changelogs()` so it shows in the About dialog

## 5. Shell syntax

- [x] `ShellParser`: mongosh statements (`db.<collection>.find(...).sort(...).limit(...)`, `findOne`, `aggregate`, `countDocuments`, `estimatedDocumentCount`, `count`, `distinct`, `getIndexes`, `stats`, `explain`, `getCollection`, `getSiblingDB`, `runCommand`, `adminCommand`, ...) translated to the same command documents as the JSON form; see the README's Query Language. Mixed freely with JSON documents in one file: each statement is recognised by how it starts (`{` / `[` or `db.`).
  - Values go through the Java driver's JSON reader (unquoted keys, single quotes, trailing commas, shell helpers); `new Date("...")` is rewritten to `ISODate`
  - Comments now work anywhere outside strings, also inside documents (before, a `/* */` inside a document was silently read as a regular expression)
  - Not JavaScript: variables, functions and cursor iteration are rejected with a message saying so; writes are rejected by name
  - Tests: `ShellParserTest` (statement table, values, errors with positions), `ShellParserMongoshTest` (each statement compared with the command real mongosh sends, via the profiler, in Testcontainers), and end-to-end runs in `BaseMongoContainerTest` (on 7.0, 8.0 and 8.3)
- [x] `mongodb` editor language (Monarch): highlights both forms (keys, `$operators`, method names, shell helpers, regular expressions, comments)
- [x] `guessCollection` reads shell statements too, so "Use the query bar" and the grid actions know the collection
- [ ] Maybe: an option for the query bar to write shell syntax instead of JSON
- [ ] Maybe: show the command a shell statement was sent as (info message), e.g. when learning or debugging
- [x] Outline for `.mongo` files (`mongoOutline.ts`): one entry per statement in either form ("find orders", "count campaign-variantsku", "runCommand dbStats"), with ranges for jumping to it
- [ ] `@outline-pattern` sections (`// @outline-pattern: /\/\/##(.*)/`): blocked on core, API-GAPS.md F24. Core registers its custom-pattern outline only for its own MIME types; once it covers text types registered by plugins, it combines with the statement outline without changes here.

## 6. Explain view

- [x] Uses the host's plan support, which is generic underneath the JDBC buttons: a run's `intent` (`plan.estimated` / `plan.actual`) plus a `plan` graph artifact, which the host shows in the Plan output (as for Postgres and SQL Server)
- [x] **Estimated Plan** and **Actual Plan** toolbar buttons for MongoDB files (`planActions.ts`), same titles and places as JDBC's. The intent is set through the engine's execution context provider; the host's execute command is used, so a selection is respected.
  - Estimated: `explain` with `queryPlanner`, nothing is executed
  - Actual (a toggle per file): `explain` with `executionStats`; the query runs on the server, but only the plan with its counts comes back, like Postgres's `EXPLAIN ANALYZE`
  - Statements without a plan (`listIndexes`, `dbStats`, ...) are listed in the output
- [x] Plan graph (`ExplainGraph.java`): one node per stage, edges carrying the documents passed on; nodes coloured by their share of the documents and keys examined; `COLLSCAN` always flagged; index, bounds, filter, sort and counts per node; returned / examined / time and rejected plans in the summary
  - Classic plans (`executionStages` drawn as is), slot-based (SBE) plans (`winningPlan.queryPlan`, with counts mapped from engine stages by `planNodeId`, leaf counters only so nothing is counted twice), aggregations split into `$cursor` + later stages, and sharded plans
  - Tests: `ExplainGraphTest` on explain replies captured from MongoDB 8.3 (SBE `$group` and `$lookup`, classic index + sort), explain replies from 7.0 (classic `$group`/`$lookup` pipeline stages, a `$lookup` collection scan), container tests on 7.0, 8.0 and 8.3 for both buttons
- [x] An `explain` written by hand (`db.orders.find().explain()`) shows its reply as rows, as before, and also as a graph in the Plan output
- [ ] Maybe: rejected plans as their own graphs, to compare

## 7. Completion and validation in the editor

- [ ] Command and stage names, operators, and field names from the schema sample
- [ ] Blocked on core: API-GAPS.md F5 (language features for plugin languages)

## 8. Releasing (done: 0.1.0, then 0.2.0 on 2026-11-19)

Core's two-step pattern (`create-release.yml` + `release.yml`), per plugin and without snapshots. Shared by every plugin in the repository.

- [x] **`create-plugin-release.yml`** (`workflow_dispatch`), 2026-11-16
  - Inputs: `plugin` (choice, `mongodb` for now) and `increment` (patch / minor / major)
  - Version: latest `<plugin>/v*` tag plus the increment. With no tag yet, `plugin.json`'s version as is, so the first release is 0.1.0.
  - Sets the version in the three places that must agree: `plugins/<plugin>/plugin.json`, the backend `pom.xml` (the packager refuses a JAR whose version differs from `plugin.json`) and the frontend `package.json`. Done by `shared/scripts/plugin-version.mjs`, which CI also runs to check they agree.
  - Commits `release(<plugin>): v<version>`, tags `<plugin>/v<version>` and pushes; needs `RELEASE_TOKEN` to push to the protected branch, as in core. The changelog already skips `release:` commits.
  - No `-SNAPSHOT` / "prepare for next development iteration" commit: only the ZIP is published, not Maven artifacts, so the version stays at the last release in between, and the changelog lists newer commits under "Unreleased"
  - Only from the default branch
- [x] **`release-plugin.yml`** (on push of a `*/v*` tag), 2026-11-16
  - Reads the plugin from the tag; builds and tests only that plugin (same steps as `mongodb.yml`)
  - Fails when the tag's version differs from `plugin.json`, and refuses to publish a tag twice (an existing GitHub Release for the tag)
  - GitHub Release for the tag with `<id>-<version>.zip` and `.zip.sha256`, release notes from that version's changelog section (the generator needs an option to print one section), `make_latest: false` (GitHub keeps one "latest" per repository; clients read the catalog)
  - `workflow_dispatch` with `dry_run` that builds and checks without publishing, like core
- [x] Before the first release
  - [x] `mongodb:verify` no longer hard-codes `0.1.0`: `verify-package.mjs` takes the plugin folder and reads the ZIP name from `plugin.json`. Generic `test` / `package` / `verify <plugin>` scripts can wait for a second plugin; the release workflow runs `<plugin>:test` and `<plugin>:package`.
  - [x] Repository secret `RELEASE_TOKEN`: a token that may push to the protected `master` and push tags (contents: write). Its tag push is what starts `release-plugin.yml`.
  - [x] Merge `feature/mongodb` to `master`
  - [x] Dry run: Actions → Release Plugin → Run workflow (`mongodb`, dry run), then check the ZIP and release notes in the run's artifacts
  - [x] Actions → Create Plugin Release → `mongodb`. The first release used `plugin.json`'s 0.1.0.
- [ ] Each release: build with `clean`. `copy-dependencies` doesn't empty `target/lib`, so a dependency upgrade otherwise leaves the old jar next to the new one (seen with payloadbuilder 1.15 → 1.16). CI builds from a fresh checkout and isn't affected.
- [ ] Later: update `catalog/index.json` from the release workflow, once Queryeer reads a catalog (see the root README's Repository and Releases)

## 9. Live cluster overview (blocked on core)

A dashboard tab opened from a connection in the explorer: operations per second, latencies, connections, network, WiredTiger cache, queues, replication lag and the slowest current operations, polled every few seconds. Panels and metrics are in [`specs/core-timeseries.md`](../../specs/core-timeseries.md) §8.

- [ ] Blocked on core: API-GAPS.md F25 (charts and live dashboards). No plugin-drawn charts meanwhile.
- [ ] Once core has it: a backend `serverStatusSample` invoke action (`serverStatus`, `replSetGetStatus` on a replica set, `currentOp` for the table), and an explorer "Overview" action that opens the dashboard
- [ ] Maybe before then: a one-off "Server status" in the explorer that runs `serverStatus` into the grid

## 10. PayloadBuilder catalog (0.3.0, needs Queryeer 0.21)

The plugin serves payloadbuilder's `mongodb` catalog from its own connections, replacing Queryeer's built-in one. Plan: [`specs/engine-catalogs.md`](../../specs/engine-catalogs.md) §3.5; how it works: the README's [PayloadBuilder catalog](README.md#payloadbuilder-catalog).

- [x] Optional dependency on `queryengine.payloadbuilder` / `core.queryengine.payloadbuilder`; the plugin loads and works without it (2026-11-20)
- [x] Backend: `PayloadbuilderMongoCatalog` through `DependencyExtension.whenDependencyActive`, bundling `payloadbuilder-catalog-mongodb` with the plugin's driver; a container test runs a payloadbuilder query through it
- [x] Frontend: catalog panel listing the plugin's connections, storing `{ connectionId }`
- [x] Verified in Queryeer (2026-11-20), also with payloadbuilder's backend removed: the MongoDB engine keeps working
- [x] Connections that allow invalid TLS certificates: payloadbuilder 1.16's `tlsAllowInvalidCertificates` (API-GAPS.md P1)
- [x] No migration of the built-in catalog's connections (decided 2026-11-20): files keep their alias and pick a connection again
- [ ] Release 0.3.0. Release notes: replaces the built-in `mongodb` catalog, pick the connection again in existing files, no table/column completion yet
- [ ] Blocked on core 0.22: table and column completion (API-GAPS.md B5)
- [ ] Core 0.22: `whenDependencyActive` catches and logs failures itself. Drop the plugin's own try/catch once its minimum Queryeer version is 0.22.
- [ ] Core 0.22 removes the built-in Mongo catalog and its connection settings; its release notes point to this plugin

## Out of scope for now

- Write support (insert, update, delete, edit in grid). The plugin is read-only by design.
