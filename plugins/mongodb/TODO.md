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
- [ ] Later, maybe: embedded fields inside arrays (`items.sku`) and more than one level down
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
