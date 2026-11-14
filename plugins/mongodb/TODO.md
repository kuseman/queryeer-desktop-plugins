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
- [ ] **Filter** builder: rows of field · operator (by type) · typed value, AND/OR (next)
- [ ] Value suggestions for low-cardinality fields (capped `distinct`)
- [ ] Nested fields (`address.city`): sampling returns top-level fields only today
- [ ] Later, maybe: read hand-written finds back into the bar (needs a value parser)
- [x] Verified in Queryeer (2026-11-14): query bar and collection combobox

## 3. Grid cell actions

Through the public `tableOutputContextMenu`.

- [ ] "Filter by this value": adds `field: value` to the query bar filter
- [ ] "Copy as Extended JSON" for a cell, and "Copy document" for a row

## 4. Small polish

- [ ] **Connection colour**, like JDBC connections:
  - an optional `color` field in `connections.ts` (parse and serialize) and a colour input in `ConnectionsSettingsEditor.tsx`; the backend ignores unknown fields
  - applied to the read-only "connection | database" status label (`MongoStatusLabel` in `MongoConnectionView.tsx`) with `style={{ color }}`, as JDBC's `JdbcConnectionStatus.tsx` does
  - optionally, the editor tab coloured per connection with `context.layout.registerTabHeaderStyle`, keyed on `file.engineBinding.connectionId` (JDBC only colours the status label)
- [ ] Paste a `mongodb://` / `mongodb+srv://` URI in the connection editor to fill the fields (credentials go to the vault, not settings)
- [ ] Query templates in a new `.mongo` file (find, aggregate, count)
- [x] Changelog generated from this plugin's commits since each `mongodb/v*` tag (`shared/scripts/generate-changelog.mjs`), packaged into the backend JAR and registered with `context.changelogs()` so it shows in the About dialog

## 5. Shell syntax

- [ ] A second parser for `db.<collection>.find(...).sort(...).limit(...)`, `aggregate([...])`, `countDocuments`, `distinct`. It produces the same command documents as the JSON form, so the execute stage is unchanged. Text starting with `db.` is shell syntax.

## 6. Explain view

- [ ] A readable plan summary: winning plan stages (`IXSCAN`/`COLLSCAN`), documents and keys examined vs. returned, time
- [ ] Check whether the host's query-plan artifacts (used by SQL Server) can render it

## 7. Completion and validation in the editor

- [ ] Command and stage names, operators, and field names from the schema sample
- [ ] Blocked on core: API-GAPS.md F5 (language features for plugin languages)

## Out of scope for now

- Write support (insert, update, delete, edit in grid). The plugin is read-only by design.
