# Queryeer Plugin API Gaps

Things found while building plugins in this repository that a third-party plugin cannot do, or can only do by copying host internals. Each entry says what is missing, where the host has it internally, what this repo does instead, and a suggested fix.

Found while building: MongoDB (`plugins/mongodb`). Last updated: 2026-11-14. References are to the Queryeer Desktop repository at commit `52bc815`.

Priority:
- **P1**: a real plugin needs it or has to duplicate meaningful code.
- **P2**: friction or inconsistency.
- **P3**: documentation only.

## Status

"Fixed in core" means the fix is in the Queryeer Desktop working tree after `52bc815`, reviewed on 2026-11-13 and not yet released. The MongoDB plugin already uses these fixes through its local `file:` link to `@queryeer/api`.

| Gap | Priority | Status |
|---|---|---|
| F1 List/detail settings editor | P1 | ✅ Fixed in core: `components.CollectionSettingsListEditor` and `components.useCollectionSettingsPersistence`. MongoDB uses them. |
| F2 Form primitives and styles | P1 | ✅ Fixed in core: stable theme variables documented in `DEVELOPMENT-PLUGIN.md`. MongoDB's CSS uses them. |
| F3 Open Settings at a setting | P2 | ✅ Fixed in core: `settings.open(settingId?)`. MongoDB's ⚙ action and empty state use it. |
| F4 One call to register a file type | P2 | Open |
| F5 Monaco language features | P2 | Partly fixed in core (`0b1819f`): `editorLanguages.registerLanguage({ id, aliases, monarch, configuration })`, a plugin-defined language without validation. Completion, hover and diagnostics are still open (needs design). |
| F6 Inconsistent `Disposable` returns | P2 | Open |
| F7 Late settings registration | P2 | ✅ Fixed in core: `registerSettings` refreshes by itself. |
| F8 ID helpers | P3 | Open |
| F9 `@queryeer/api` version | P3 | ✅ Handled by the release workflow: `create-release.yml` sets `@queryeer/api` to the release version, and since `e0eb735` also the examples' and `DEVELOPMENT-PLUGIN.md`'s ranges. The next release must be a **minor** one (0.19.0). |
| F10 `invoke` return shape | P3 | Open |
| F11 Plugin identity declared twice | P3 | Open |
| F13 Persistence hook drops a pending save | P2 | ✅ Fixed in core: the hook flushes pending items on unmount and always calls the latest `persist`. MongoDB's workaround removed. |
| F14 New-file list ignores plugin file types | P1 | ✅ Fixed in core: types the setting doesn't mention are appended as enabled, and per-type New commands are registered lazily when the File menu is built. Cause 3 (menu rebuild) was already handled: bootstrap rebuilds the menu after `host.start`. |
| F15 `settings.open(id)` ignored after a search | P2 | ✅ Fixed in core: a pending request first clears the search and resolves only against the unfiltered tree. |
| F16 Open a new query tab with text (and run it) | P1 | ✅ Fixed in core (`975690c`): `createUntitledFile({ initialContent })` and `queryEngines.execute({ fileId, text? })`. Follow-ups in `150ef9f`: run requests aimed at a file are neither lost nor run late. MongoDB still uses its workaround in `queryFiles.ts` until it moves to the new API. |
| F17 Engine-scoped header strip in the query editor | P1 | ✅ Fixed in core (not yet committed): `queryEngines.registerEditorHeaderItem({ id, engineId, title, order, render })`, collapsible per file. Host keybindings work inside it; `data-keybinding-scope="input"` is a local opt-out. |
| F18 JDBC sidebar rebinds other engines' files to `jdbc` | P1 | ✅ Fixed in core (not yet committed): a MIME type claimed by an engine is owned by it. `bindEngine` and `updateFile` reject foreign bindings (the existing binding is kept), restore/registration drops misbound ones, and the JDBC view/selector only act on SQL files. |
| F19 Editor group steals focus from portalled popups | P3 | ✅ Fixed in core (`7de8251`): the group only takes focus for targets inside its own DOM node. MongoDB's button options still work and can stay. |
| F20 Grid context menu doesn't name its file | P2 | ✅ Fixed in core (`226cb33`): `TableOutputContextMenuContext` has `fileId` and `engineId`, and `registerProvider` returns a `Disposable`. `when` expressions see them as `tableSelection.fileId` and `tableSelection.engineId`. |
| B1 File session on rebind | P1 | ✅ Fixed in core: `bindEngine` sends a binding-aware `file.change`. Deferred until the next edit when the host cannot resolve the text. |
| B2 Columns fixed at result-set start | P2 | Open (needs design) |
| B3 Warning severity | P2 | ✅ Fixed in core: `OutputSeverity.WARNING` / `"warning"` end to end. |
| B4 Runner working directory | P3 | ✅ Fixed in core: `queryeer.builtins.dir` / `QUERYEER_BUILTINS_DIR`. MongoDB's smoke test uses it. |
| D1 Developer plugin folders | P1 | Open |
| D2 Public backend restart | P1 | Open |
| D3 Jar locking on Windows | P2 | Open |
| D4 Watch mode for external plugins | P2 | Open |

## Frontend (`@queryeer/api`)

### F1 (P1): List/detail settings editor
- **Missing:** a list/detail editor for collections in settings (add, clone, delete, select, a detail pane, invalid markers, read-only mode).
- **Internal today:** `core.settings/CollectionSettingsListEditor` (`CollectionSettingsListEditor`, `useCollectionSettingsPersistence`). Every builtin connections editor uses it: JDBC, Payloadbuilder MongoDB, Elasticsearch, Kafka.
- **Workaround here:** `plugins/mongodb/frontend` has its own list/detail editor and debounced persistence.
- **Suggestion:** expose both on `PluginContext.components` (like `PasswordFieldInput`), with a typed props contract.

### F2 (P1): Settings form primitives and styles
- **Missing:** shared form components and styles for settings: field and label layout, text input, select, checkbox, error text, help text, buttons.
- **Internal today:** builtin editors use host CSS classes such as `payloadbuilder-catalog-input`, `payloadbuilder-settings-detail-grid` and `payloadbuilder-settings-error`. Those are private to one builtin plugin.
- **Workaround here:** the plugin ships its own CSS built on the theme variables `--border`, `--bg-0`, `--text-0`, `--text-1` and `--ui-font-size-sm`.
- **Suggestion:** expose a small set of form components on `PluginContext.components`. Alternatively, document a stable set of CSS classes and theme variables as part of the API. Today the theme variables are an undocumented contract.

### F3 (P2): Open Settings at a specific setting
- **Missing:** a public way to open Settings at a particular setting or section.
- **What exists:** the public command `core.settings.open` takes no arguments and opens the Settings home. `commands.executeCommand(commandId)` cannot pass arguments either.
- **Internal today:** builtins use the internal `getCoreSettingsService().openModalForSetting(settingId)`. Payloadbuilder's sidebar ⚙ action does this.
- **Workaround here:** the MongoDB view's ⚙ action runs `core.settings.open`, and the view tells the user to go to Query Engine → MongoDB.
- **Suggestion:** `context.settings.open(settingId?)`, or command arguments for `core.settings.open`.

Not a gap: engine-specific panels. They already work through `layout.registerView({ when: "activeFile?.mimeType == '…'" })`, with `render` receiving `activeFile`, exactly as JDBC's "SQL Databases" and Payloadbuilder's catalog views do. The MongoDB plugin's connection and database pickers use this.

### F4 (P2): One call to register a file type
- **Missing:** a single call to register a file type.
- **Internal today:** `core.files/mime-registration.ts` (`registerMimeTypeBundle`, `createExtensionMimeResolver`).
- **What plugins do instead:** call 6–7 separate methods:
  - `registerMimeResolver`
  - `capabilities.registerCapabilities`
  - `registerLabel`
  - `registerContentCategory`
  - `registerPreferredExtension`
  - `registerPreferredNewFileMimeType`
  - `mimeIcons.registerMimeIcon`
- **Also:** several of those are optional (`?`) on `MimeCapabilityRegistry`, so plugins have to null-check host methods that always exist in practice.
- **Suggestion:** `context.files.registerFileType(MimeTypeRegistration & { icon?, preferredForNew?, monacoLanguageId? })` returning a `Disposable`, and make the always-present methods non-optional.

### F5 (P2): Monaco language features beyond a MIME mapping
- **Today:** `editorLanguages.registerMimeType(mime, "json")` maps a file type to an existing Monaco language.
- **Missing:** a plugin cannot register a JSON schema, completion, hover or diagnostics for its language. Completion and hover are wired to `sql` only (`core.queryengine/sql-completion-language.ts`, `sql-hover-language.ts`).
- **Suggestion:** a language-features contribution backed by `queryEngines.invoke` actions, generalising the `sql.complete` / `sql.hover` / `sql.symbolAtPosition` actions to any engine and language.

- **Minimal slice, needed first:** MongoDB's shell syntax (`db.orders.find({...}).sort({...})`, TODO item 5) cannot live in a `json`-mapped editor: Monaco's JSON validation marks it as an error. Mapping to `javascript` doesn't work either, because a JSON command document at the start of a line parses as a block statement and is flagged too. A plugin needs to register its own language before any completion work:
  ```ts
  editorLanguages.registerLanguage({
    id: "mongodb",
    monarch,        // Monaco Monarch tokenizer
    configuration,  // brackets, comments, auto-closing pairs
  }): Disposable
  ```
  with no validation, then `registerMimeType(MIME, "mongodb")` as today. Completion and hover (above) can follow later.

### F6 (P2): Inconsistent `Disposable` returns
- **Return a `Disposable`:** `queryEngines.*`, `editorLanguages.*`, `capabilities.registerCapabilities`.
- **Return nothing:**
  - `settings.registerSettings`, `registerAdvancedRenderer`, `registerAdvancedValidator`
  - `files.registerMimeResolver`
  - `mimeIcons.registerMimeIcon`
  - `layout.registerToolbarAction`
  - `commands.registerCommand`
- **Consequence:** `deactivate` cannot clean up consistently.
- **Suggestion:** return a `Disposable` from every `register*`.

### F7 (P2): Late settings registration has no public refresh
- **Activate-time registration works:** settings registered during `activate` work because bootstrap calls `refreshSchemaFromRegistry()` and `syncRegistryModules()` after `host.start` (`renderer/shell/bootstrap.ts`).
- **The gap:** settings registered later (lazily) have no public way to refresh. Builtins call the internal `getCoreSettingsService().refreshSchemaFromRegistry()` themselves.
- **Suggestion:** have `settings.registerSettings` refresh by itself, or add `settings.refresh()`.

### F8 (P3): ID helpers
- **Internal today:** `generateConnectionId` (`core/utils/ids.ts`, which is `crypto.randomUUID()`).
- **Workaround here:** plugins use `crypto.randomUUID()` directly.
- **Suggestion:** document `crypto.randomUUID()` as the expected connection-ID format so plugin connections look like builtin ones.

### F9 (P3): `@queryeer/api` version
- **Mismatch:** in commit `52bc815`, `packages/api/package.json` is `0.18.0`, while `DEVELOPMENT-PLUGIN.md` and the examples require `^0.19.0` for the new APIs.
- **Fix:** bump it in the release, otherwise `^0.19.0` cannot resolve.
- **Resolved:** no manual bump is needed.
  - `create-release.yml` runs `npm version` for both `@queryeer/app` and `@queryeer/api`. The bump type defaults to `minor`, so the next release is 0.19.0.
  - Since `e0eb735`, the same release commit also sets the `@queryeer/api` ranges in `plugins-examples/*/package.json` (both peer and dev) and in the guide's snippets. The step fails if any range is missed.
  - **Watch for:** starting the release as a patch would publish the new APIs as 0.18.1, which `^0.19.0` doesn't match.

### F10 (P3): `invoke` return shape
- **Behaviour:** `context.queryEngines.invoke` resolves to the backend provider's return value. Over the raw stdio protocol, the same value arrives as `response.result.result`.
- **Fix:** worth one line in `DEVELOPMENT-PLUGIN.md` for people writing tests or tools against the protocol.

### F11 (P3): Plugin identity is declared twice
- **Duplication:** a full-stack plugin declares its identity in `plugin.json` (`id`, `name`, `version`) and again in the frontend `PluginModule.manifest`.
- **What the host checks:** that the IDs match (`plugins/discovery.ts`), but not the versions. The plugin's version also lives in the backend `pom.xml`.
- **Workaround here:** the packaging script checks that `pom.xml` and `plugin.json` agree. The frontend manifest version is maintained by hand.
- **Suggestion:** let the host fill the frontend manifest's `id`/`name`/`version` from `plugin.json` (it already overwrites `plugin.manifest` with the module manifest), so the frontend only declares `kind` and `dependencies`.

### F13 (P2): Persistence hook drops a pending save on unmount
- **Behaviour:** `useCollectionSettingsPersistence` clears its debounce timer on unmount instead of flushing it (`core.settings/CollectionSettingsListEditor.tsx`, the `useEffect` cleanup calls `clearTimer`).
- **Consequence:** an edit made less than `debounceMs` (300 ms) before the Settings view closes is never persisted. This affects every builtin editor using the hook too.
- **Workaround here (removed):** `ConnectionsSettingsEditor.tsx` tracked the pending value and wrote it in its own unmount cleanup until the fix landed in core.
- **Suggestion:** have the hook remember the last pending items and call `persist` with them on unmount.

### F14 (P1): New-file list ignores file types registered by plugins
`core.files` builds its New-file state in `activate`, before external plugins have registered their creatable MIME types (all references are to `core.files/plugin.tsx`). It affects every plugin that adds a file type, confirmed with MongoDB's `.mongo`.

1. **Missing from New lists:** `listConfiguredNewFileMimeTypeOptions` (141–172) only lists types present in the `core.files.mimeTypes` setting. The stored value, or the `defaultMimeTypes` captured at activation (251–268), never contains a plugin's type, so it is missing from the toolbar's New dropdown.
   - Workaround: untick and re-tick it under Settings → Files → Mimetype, which saves a list that includes it.
2. **File menu does nothing:** commands `core.files.new.fromMime.<mime>` are registered only for types known at activation (440–450). The File → New menu items point at those commands (622), so File → New → *plugin type* does nothing. The toolbar dropdown works because it calls `createNewFileFromMimeType` directly (511).
3. ~~**Menu never rebuilt:** the File menu is rebuilt only on settings changes (385–389), so it is not rebuilt after plugins register their types.~~ Not a bug: `bootstrap.ts` calls `host.rebuildMenu()` after `host.start()`, which re-evaluates `dynamicItems`.
- **Suggestion:**
  - treat creatable types the setting doesn't mention as enabled, and hide only types explicitly unticked
  - register the per-type commands lazily, or give menu items a direct handler
  - rebuild the menu once external plugins have started

### F15 (P2): `settings.open(settingId)` ignored when a search was active
- **Behaviour:** `SettingsModalHost.tsx` (66–79) resolves the requested setting in the current tree before the search is cleared. The search text (`queryInput`/`query`) stays in state after the modal closes.
- **Consequence:** if the previous visit used the search box, the requested setting is often not in the filtered tree. The lookup fails, the old section stays selected, and the request is discarded.
- **Confirmed:** after searching for "mime", MongoDB's "Add connection…" opened Mime types. The second click worked.
- **Scope:** every `openModalForSetting` caller is affected: JDBC drivers, Assistant, Explorer, Payloadbuilder catalogs, and now `settings.open` for plugins.
- **Suggestion:** when a request is pending and a search is active, clear the search and return. Resolve the target, and drop the request, only once the unfiltered tree is in place.

### F16 (P1): Open a new query tab with text, and optionally run it
- **Missing:** a public way to create a query tab with initial content and run it.
- **Internal today:** builtin tree and table actions (JDBC "new query and execute", table actions, Flow's new document) use:
  - `getEditorRegistryHost().applyRecoveredContent(fileId, text)` to seed the new tab
  - `getQueryEngineService().requestExecute({ textOverride, fileIdOverride })` to run it

  Neither is public. `createUntitledFile` only offers `cloneFromFileId`.
- **Workaround here** (`plugins/mongodb/frontend/src/queryFiles.ts`):
  1. create the file
  2. `bindEngine` and set editor state
  3. wait on `editors.onActiveEditorChanged` until the new tab's editor is active
  4. `editor.content.setContent(text)`
  5. wait a frame, then `commands.executeCommand("core.queryengine.execute")`

  This depends on timing (editor mount, command enablement) and on the new tab becoming active.
- **Suggestion:** `fileMediator.createUntitledFile({ ..., initialContent })` plus `queryEngines.execute({ fileId, text? })`. Or a single `queryEngines.openQuery({ mimeType, title, text, engineBinding, editorState, execute })`.
- **Fixed** in `975690c`, with follow-ups in `150ef9f`:
  - A request is no longer lost when the editor switches to the file while it is still starting another run. The request waits and runs once that start finishes.
  - A request aimed at a file that no editor shows expires after 10 seconds (`TARGETED_EXECUTE_REQUEST_TTL_MS`) instead of running much later. Expired requests are logged with `console.debug`.
  - An editor that defers a request holds it (`holdExecuteRequest`), which clears the expiry, so a slow start such as a vault unlock prompt doesn't drop it. Every path a request can take to the editor holds it: a file switch, a finished start, and the execute-request listener when the file is already shown.
  - If the editor leaves the file before taking a held request, it releases it (`releaseExecuteRequest`), which restarts the 10 seconds.
- **Older issue, fixed in `5b1c8d8`:** an untargeted run request that the active editor turns down, because it is still starting a run, is now dropped instead of staying queued. Untargeted requests also get the 10-second limit as a backstop.
- **Plugin side:** MongoDB isn't affected, because it runs either a tab it just created or the active tab, where no other run is starting.

### F17 (P1): Engine-scoped header strip in the query editor
- **Missing:** a place for a query engine to render UI at the top of its query editor, between the tab strip and the text.
- **Available today, and why each falls short:**
  - `queryEngines.registerEditorStatusItem`: engine-scoped and per file, but it is the status strip at the bottom, sized for labels.
  - `layout.registerToolbarAction`: can be limited to a MIME type with `when`, but it only offers actions, selects and menus, with no text inputs, and it sits in the global toolbar rather than the editor.
  - `layout.registerEditor`: the plugin would have to rebuild the whole query editor, including execution, the results grid, progress and cancel. Those parts are not public.
- **Use cases:**
  - MongoDB query bar (Filter / Projection / Sort / Limit, paging), which today sits in the sidebar view (`MongoQueryBar.tsx`)
  - JDBC query parameters or a schema picker
  - an Elasticsearch index picker
- **Suggestion:** mirror the status-item API:
  ```ts
  queryEngines.registerEditorHeaderItem({
    id, engineId?, order?,
    render: (context: QueryEditorStatusItemContext) => ReactNode // { fileId, file, outputContext }
  }): Disposable
  ```
  - The query editor renders the contributions for the bound engine in a strip above Monaco, and no strip when none render anything.
  - The strip is horizontal and wraps when narrow.
  - It can be collapsed per file.
- **Plugin side:** `MongoQueryBar` already takes `{ context, file }` and owns its state, so moving it is a one-line mount change.

### F18 (P1): JDBC sidebar rebinds other engines' files to `jdbc`
- **Symptom:** after a restart, a `.mongo` tab ran into JDBC's "No connection is associated with this file…", although MongoDB's sidebar showed a connection and database. The workspace had saved the file as `engineBinding: { engineId: "jdbc" }` with no connection.
- **Cause** (`core.queryengine.jdbc`):
  1. `JdbcNavigationView` follows the active file through its own `fileMediator.onActiveFileChanged` subscription, independently of the view's `when: activeFile?.mimeType == 'application/sql'`.
  2. When the active file changes to a non-SQL file, the view can render once more before the `when` hides it. It mounts `JdbcConnectionSelector` (keyed by file id) for that file.
  3. The selector's mount effect (`JdbcConnectionSelector.tsx`, "Sync context metadata on mount") sees a `connectionId` that is not an enabled JDBC connection. It treats it as a removed connection and calls `fileMediator.bindEngine(fileId, "jdbc", undefined)`.
  4. Any query file bound to another engine with a connection is rebound to JDBC this way. The binding is persisted, so later executions go to the JDBC engine.
- **Fix, two levels:**
  1. **The bug:** `JdbcNavigationView` renders the selector only for SQL files (`mimeType == 'application/sql'`). The selector's mount effect only touches files whose `engineBinding.engineId` is `"jdbc"`; `syncJdbcFileMetadata` already checks this.
  2. **The invariant:** a file whose MIME type is claimed by a registered engine (`queryEngines.registerEngine({ mimeTypes })`) can only be bound to that engine. `fileMediator.bindEngine` rejects any other `engineId`, returning `undefined` and logging a warning naming the caller's engine. Restoring the workspace drops such a binding and falls back to the MIME owner. Then no engine, builtin or plugin, can capture another engine's files, and this class of bug can't come back. Files with no engine of their own, like plain text, keep free binding.
- **Related:** the query editor header (F17) and status bar pick the engine binding-first (`engineBinding.engineId ?? MIME owner`), so a misbound file also shows the wrong engine's items. With the invariant (level 2) the binding always matches the MIME owner, so they need no change.
- **Test:** switch from a SQL tab to a `.mongo` tab bound to `{ engineId: "mongodb", connectionId: "x" }` and assert the binding is unchanged. Also call `bindEngine(mongoFileId, "jdbc")` and assert it is rejected.
- **Plugin side:** no workaround. A plugin shouldn't have to police its files' bindings. To recover an affected tab today, Ctrl+click an action in the MongoDB explorer, which rebinds the current tab to MongoDB, or copy the text into a new MongoDB tab.

### F19 (P3): Editor group steals focus from portalled popups
- **Behaviour:** the editor group's `onMouseDownCapture={focusEditorGroupFromPointer}` (`renderer/shell/ShellApp.tsx:922`, defined at 800) moves focus to the editor group unless the target is an input, button or similar control.
- **Why plugins hit it:** React events from a portal bubble through the React tree, not the DOM tree. A popup that a header item (F17) or any editor contribution portals to `document.body`, for example so the text pane's `overflow: hidden` does not clip it, still runs this handler. A mousedown on a non-control element in the popup (a `div` list option) moves focus out of the plugin's input. The input's blur then closes the popup before the option's handler runs.
- **Workaround here:** the query bar's combobox options are `<button type="button" tabIndex={-1}>` with `onMouseDown` `preventDefault()`. `MongoQueryBar.test.tsx` wraps the bar in a copy of the host handler (`HostEditorGroup`) to keep this covered.
- **Suggestion:** ignore events whose target is outside the group's own DOM node: `if (!(event.currentTarget as Node).contains(event.target as Node)) return;`.

### F20 (P2): Grid context menu doesn't name its file
- **Missing:** `TableOutputContextMenuContext` has `resultSetIndex`, `columns`, `selection` and `cellValuesByRow`, but not the file whose results are shown. The grid has it: `TableGrid` receives `fileId` and builds the menu context without it (`core.queryengine.output.table/plugin.tsx:454`).
- **Use case:** MongoDB's "Filter by this value" (TODO item 3) adds a condition to the query bar of the file the grid belongs to. Using the active file instead is a guess that breaks with split editors or when focus is elsewhere.
- **Suggestion:** add `fileId?: string` (and, for convenience, the file's `engineId`) to `TableOutputContextMenuContext`. `registerProvider` should also return a `Disposable` (F6).
- **Fixed** in `226cb33`. `getItems` receives `fileId` and `engineId`, and `registerProvider` returns a `Disposable`. Disposing a stale registration doesn't remove a provider that replaced it.
- **`when` expressions:** provider, item and user table action `when` expressions see the same values as `tableSelection.fileId` and `tableSelection.engineId`, registered as when-expression variables, e.g. `when: "tableSelection.engineId == 'mongodb'"`.

## Backend (`backend-api` / protocol)

### B1 (P1): File session not updated on rebind
- **Behaviour:** `FileMediator.bindEngine` opens the backend file session only on the first bind (`core/plugin-runtime/FileMediator.ts`). Rebinding a file to another connection never reaches `FileSessionHandler`, so `FileSession.connectionId` goes stale.
- **Workaround here:** like JDBC, the connection travels in `engineState.connectionId` on every execution, and the file session is only a fallback.
- **Suggestion:** notify handlers on rebind, e.g. `onRebind(session)` or a close and reopen.

### B2 (P2): Columns fixed when a result set starts
- **Behaviour:** `resultSetStart` fixes the columns, and `chunkRows` rows are positional (`BACKEND_PROTOCOL.md` §6.1a). Schemaless engines (MongoDB, Elasticsearch) cannot add columns that first appear in later batches.
- **Workaround here:** a trailing `$extra` JSON column.
- **Suggestion:** a protocol event that appends columns to an open result set. This is the "C9" item from the core review.

### B3 (P2): No warning severity
- **Behaviour:** `OutputEvent` severity is `INFO` or `ERROR` only.
- **Where a warning fits:** results capped, a `$extra` column added, a best-effort `killOp` that failed.
- **Suggestion:** add `WARNING`.

### B4 (P3): Runner needs the core repo as working directory
- **Behaviour:** `BackendRunnerApp` finds builtin plugins relative to the working directory (`./plugins/builtin`), so a standalone run (tests, tools) has to use the core repo as `cwd`.
- **Workaround here:** `plugins/mongodb/scripts/smoke-backend.mjs` does that.
- **Suggestion:** a `-Dqueryeer.builtins.dir` system property, or resolve relative to the runner jar.

## Developer experience

How plugin development works today, from the Queryeer Desktop code (`DEVELOPMENT-PLUGIN.md` §8.1.1, §10.5):
- External plugins load once at startup, with no file watching.
- Frontend changes are picked up by **Reload Window**, which re-runs bootstrap and re-imports the external modules.
- Backend changes need a full app restart.

This repo's `npm run mongodb:dev` (`shared/scripts/dev-frontend.mjs`) narrows the frontend loop to "save, then Reload Window". The items below would close the rest of the gap.

### D1 (P1): Developer plugin folders
- **Today:** plugins are discovered only in the managed plugins directory (`%APPDATA%\queryeer-desktop\plugins`). A developer copies build output there, or links it.
- **Links break in dev mode:** in dev mode (`npm run dev`), Vite serves external modules through `/@fs/`. It resolves the real path of a junction or symlink, which falls outside `server.fs.allow` (§8.1.1), so linking a plugin's `dist/` folder into the plugins directory fails there.
- **Suggestion:** a setting or launch flag (e.g. `QUERYEER_DEV_PLUGIN_DIRS`) listing plugin folders to load in place. Add those folders to Vite's `fs.allow` in dev mode and to the backend's plugin discovery.

### D2 (P1): Public "Restart backend" command
- **Today:** backend plugin jars load once per JVM, and a window reload does not restart the backend, so every backend change needs a full app restart.
- **Internal today:** core already restarts the backend internally for JDBC driver changes (`appShell.restartBackendForJdbcDrivers`).
- **Suggestion:** a public command, e.g. `core.backend.restart`, that restarts the JVM and re-runs plugin discovery. For external plugins it should come with a frontend window reload, so both halves of a plugin are always the same version.

### D3 (P2): Jar locking on Windows
- **Today:** the backend loads plugin jars in place (`URLClassLoader` over `<plugins>/<id>/lib/*.jar`). On Windows those files stay locked while Queryeer runs. Rebuilding or recopying a plugin into its installed folder fails until the app exits. The installer already has to defer upgrades to restart because of this.
- **Suggestion:** copy each external plugin's jars to a per-run temporary directory before loading ("shadow copy"). Then the installed folder stays writable, and D2 can pick up new jars.

### D4 (P2): Watch mode for external plugins
- **Today:** nothing notices when an external plugin's files change.
- **Suggestion:** in dev mode (or behind a setting), have the main process watch developer plugin folders (D1) and:
  - reload the window when a frontend bundle changes
  - offer a backend restart (D2) when `lib/*.jar` changes

  Together with `esbuild --watch` on the plugin side, that is hot reload for external plugins in practice.
