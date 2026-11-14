import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { EditorHandle } from "@queryeer/api/editor/EditorCapability";
import { readSelectedDatabase, resolveConnection } from "./binding.js";
import { parseConnections } from "./connections.js";
import { CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, QUERY_BAR_STATE_KEY } from "./constants.js";
import { badgeFor, describeEntry, groupCollections } from "./collectionGroups.js";
import { collectionsOf, fieldsOf, formatCount, refreshFields, subscribeExplorer, valuesOf, type FieldInfo, type FieldValues } from "./MongoExplorer.js";
import {
  LIMIT_CHOICES,
  OPERATOR_LABELS,
  CHOOSABLE_VALUE_TYPES,
  VALUE_TYPE_LABELS,
  addSortKey,
  clauseFor,
  filterSummary,
  isSortable,
  newCondition,
  operatorsFor,
  suggestsValues,
  takesValue,
  valueOptions,
  valueTypeFor,
  withFilter,
  withValueType,
  clearProjection,
  flipSortKey,
  initialState,
  isOwned,
  page,
  projectionSummary,
  rangeLabel,
  readStored,
  removeSortKey,
  sortSummary,
  textFor,
  toggleProjectionField,
  withCollection,
  withLimit,
  withProjectionMode,
  guessCollection,
  type BarState,
  type Condition,
  type StoredBar
} from "./queryBarModel.js";
import { commandText, templateCommand, TEMPLATES } from "./queries.js";
import { writeToFile } from "./queryFiles.js";

type Popover = "filter" | "fields" | "sort" | "templates";

const POPOVER_WIDTH = 320;
const FILTER_WIDTH = 600;
const COMBOBOX_WIDTH = 300;

/**
 * The MongoDB query bar, in the query editor's header strip (`queryEngines.registerEditorHeaderItem`).
 *
 * One way: every change writes a `find` into the editor right away, so the editor always shows what Run (or F5)
 * executes. The bar never parses the editor. If the text no longer matches what the bar last wrote, the user has
 * edited by hand and the bar steps aside until they take over again.
 */
export function MongoQueryBar({ context, fileId }: { context: PluginContext; fileId: string }): JSX.Element {
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const unsubscribeFiles = context.files.subscribe(rerender);
    const unsubscribeSettings = context.settings.subscribe(rerender);
    const unsubscribeExplorer = subscribeExplorer(rerender);
    return () => {
      unsubscribeFiles();
      unsubscribeSettings();
      unsubscribeExplorer();
    };
  }, [context, rerender]);

  const editorText = useEditorText(context, fileId);
  const [open, setOpen] = useState<Popover | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const file = context.files.getFile(fileId);
  const connection = resolveConnection(file, parseConnections(context.settings.getValue(CONNECTIONS_SETTING_ID)));
  const selected = readSelectedDatabase(context.files.getEditorState(fileId, DATABASE_STATE_KEY));
  const database = (connection && selected?.connectionId === connection.connectionId ? selected.database : "") || connection?.defaultDatabase || "";
  const stored = readStored(context.files.getEditorState(fileId, QUERY_BAR_STATE_KEY));
  const state = stored?.state ?? initialState();
  // Unknown until this file's editor has been active once; assume owned so the bar is usable straight away
  const owned = editorText === undefined || isOwned(editorText, stored);

  const apply = async (next: BarState, execute = false): Promise<void> => {
    const text = textFor(next);
    const record: StoredBar = { state: next, written: text };
    context.files.setEditorState(fileId, QUERY_BAR_STATE_KEY, record);
    rerender();
    const written = await writeToFile(context, fileId, text, execute && text !== "");
    setNotice(written ? undefined : "Click into this tab's editor, then try again.");
  };

  if (!connection) {
    return <div className="qmongo-qb"><span className="qmongo-muted">No MongoDB connection. Pick one in the MongoDB view.</span></div>;
  }

  const templates = (collection: string): JSX.Element => (
    <TemplatesMenu collection={collection} open={open === "templates"} onToggle={() => setOpen(open === "templates" ? undefined : "templates")}
      onClose={() => setOpen(undefined)}
      onPick={(text) => void writeToFile(context, fileId, text, false).then((written) => setNotice(written ? undefined : "Click into this tab's editor, then try again."))} />
  );

  if (!owned) {
    const takeOver = stored?.state ?? initialState(guessCollection(editorText ?? ""));
    return (
      <div className="qmongo-qb">
        <span className="qmongo-muted">
          {stored ? "Edited by hand, so the query bar is off for this tab." : "The editor holds a command the query bar did not write."}
        </span>
        <button type="button" className="qmongo-button" title="Replace the editor text with the query bar's find (Ctrl+Z undoes)"
          onClick={() => void apply(takeOver)}>
          {stored ? "Take over again" : "Use the query bar"}
        </button>
        {templates(guessCollection(editorText ?? "") || takeOver.collection)}
        {notice && <span className="qmongo-error">{notice}</span>}
      </div>
    );
  }

  const hasCollection = state.collection !== "";
  const toggle = (popover: Popover): void => setOpen(open === popover ? undefined : popover);
  const previous = page(state, -1);
  const next = page(state, 1);

  return (
    <div className="qmongo-qb">
      <CollectionInput context={context} connectionId={connection.connectionId} database={database} value={state.collection}
        onCommit={(collection) => void apply(withCollection(state, collection))} />

      <Chip label="Filter" value={filterSummary(state.filter)} open={open === "filter"} disabled={!hasCollection} width={FILTER_WIDTH}
        onToggle={() => toggle("filter")} onClose={() => setOpen(undefined)}>
        <FilterPopover context={context} connectionId={connection.connectionId} database={database} state={state}
          onChange={(s, run) => void apply(s, run)} />
      </Chip>

      <Chip label="Fields" value={projectionSummary(state.projection)} open={open === "fields"} disabled={!hasCollection}
        onToggle={() => toggle("fields")} onClose={() => setOpen(undefined)}>
        <FieldsPopover context={context} connectionId={connection.connectionId} database={database} state={state} onChange={(s) => void apply(s)} />
      </Chip>

      <Chip label="Sort" value={sortSummary(state.sort)} open={open === "sort"} disabled={!hasCollection}
        onToggle={() => toggle("sort")} onClose={() => setOpen(undefined)}>
        <SortPopover context={context} connectionId={connection.connectionId} database={database} state={state} onChange={(s) => void apply(s)} />
      </Chip>

      <label className="qmongo-qb-field">
        <span className="qmongo-qb-label">Limit</span>
        <select className="qmongo-input qmongo-qb-limit" value={state.limit} disabled={!hasCollection}
          onChange={(e) => void apply(withLimit(state, Number(e.target.value)))}>
          {[...new Set([...LIMIT_CHOICES, state.limit])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>{n.toLocaleString()}</option>
          ))}
          <option value={0}>No limit</option>
        </select>
      </label>

      <span className="qmongo-qb-pager">
        <button type="button" className="qmongo-button" aria-label="Previous page" title="Previous page"
          disabled={!hasCollection || !previous || state.skip === 0} onClick={() => previous && void apply(previous, true)}>◀</button>
        <span className="qmongo-muted qmongo-qb-range">{hasCollection ? rangeLabel(state) : ""}</span>
        <button type="button" className="qmongo-button" aria-label="Next page" title="Next page"
          disabled={!hasCollection || !next} onClick={() => next && void apply(next, true)}>▶</button>
      </span>

      <button type="button" className="qmongo-button qmongo-button-primary" disabled={!hasCollection} title="Run the query (F5)"
        onClick={() => void apply(state, true)}>
        Run
      </button>
      {templates(state.collection)}
      {notice && <span className="qmongo-error">{notice}</span>}
    </div>
  );
}

/** The "Templates" menu: replaces the editor text with a command to edit by hand (Ctrl+Z undoes), which turns the bar off for the tab. */
function TemplatesMenu({ collection, open, onToggle, onClose, onPick }: {
  collection: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (text: string) => void;
}): JSX.Element {
  return (
    <Chip label="Templates" value="" open={open} disabled={false} onToggle={onToggle} onClose={onClose}>
      <div className="qmongo-qb-builder" role="menu" aria-label="Templates">
        <div className="qmongo-muted">Replaces the editor text with a command to edit by hand{collection ? ` on ${collection}` : ""} (Ctrl+Z undoes).</div>
        {TEMPLATES.map((template) => (
          <button key={template.id} type="button" role="menuitem" className="qmongo-qb-option" title={template.title}
            onClick={() => {
              onClose();
              onPick(commandText(templateCommand(template.id, collection)));
            }}>
            <span className="qmongo-qb-item-name">{template.label}</span>
            <span className="qmongo-muted">{template.title}</span>
          </button>
        ))}
      </div>
    </Chip>
  );
}

/** The text of this file's editor, following edits; undefined until that editor has been active. */
function useEditorText(context: PluginContext, fileId: string): string | undefined {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    let subscription: { dispose(): void } | undefined;
    const attach = (editor: EditorHandle | null): void => {
      if (!editor || editor.fileId !== fileId || !editor.content) {
        return; // another file's editor: keep the last known text of ours
      }
      subscription?.dispose();
      setText(editor.content.getContent());
      subscription = editor.versionedTextEdit?.onDidChangeVersion(() => setText(editor.content?.getContent()));
    };
    attach(context.editors.getActiveEditor());
    const active = context.editors.onActiveEditorChanged(attach);
    return () => {
      active.dispose();
      subscription?.dispose();
    };
  }, [context, fileId]);
  return text;
}


/**
 * Collection combobox. Opening it lists every collection and view (system collections left out); typing filters.
 * A native <datalist> was not used: browsers filter it by the current value, so a filled field showed only matches.
 */
function CollectionInput({ context, connectionId, database, value, onCommit }: {
  context: PluginContext;
  connectionId: string;
  database: string;
  value: string;
  onCommit: (collection: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);

  const collections = database ? collectionsOf(context, connectionId, database) : undefined;
  const groups = collections?.status === "loaded" ? groupCollections(collections.items) : undefined;
  const entries = groups ? [...groups.collections, ...groups.views] : [];
  const query = typed ? draft.trim().toLowerCase() : "";
  const shown = query ? entries.filter((entry) => entry.label.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) : entries;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  const show = (): void => {
    if (!open) {
      setOpen(true);
      setTyped(false);
      setHighlight(Math.max(0, entries.findIndex((entry) => entry.name === value)));
    }
  };
  const close = useCallback(() => setOpen(false), []);
  const commit = (name: string): void => {
    setOpen(false);
    setTyped(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    } else {
      setDraft(value);
    }
  };

  const status = !database
    ? "Pick a database in the MongoDB view."
    : collections?.status === "loading"
      ? "Loading collections…"
      : collections?.status === "error"
        ? `Could not list collections: ${collections.message}`
        : shown.length === 0
          ? (query ? "No match. Enter uses the name as typed." : "No collections.")
          : undefined;

  return (
    <span className="qmongo-qb-field" ref={anchorRef}>
      <span className="qmongo-qb-label">Collection</span>
      <input className="qmongo-input qmongo-qb-collection" role="combobox" aria-expanded={open} aria-autocomplete="list" value={draft}
        spellCheck={false} disabled={!database} placeholder={database ? "Choose…" : "Pick a database first"}
        title={database ? `Collections in ${database}` : "Pick a database in the MongoDB view"}
        onFocus={show}
        onClick={show}
        onChange={(e) => {
          setDraft(e.target.value);
          setTyped(true);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              show();
              return;
            }
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHighlight((index) => Math.min(Math.max(index + step, 0), Math.max(shown.length - 1, 0)));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(open && shown[highlight] ? shown[highlight].name : draft);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            setDraft(value);
            close();
          }
        }}
        onBlur={() => {
          // Leaving the field applies only an exact name; a half-typed one goes back to the current collection
          const exact = entries.find((entry) => entry.name === draft.trim() || entry.label === draft.trim());
          commit(exact ? exact.name : value);
        }} />
      <Popup anchorRef={anchorRef} open={open} onClose={close} width={COMBOBOX_WIDTH} label="Collections">
        <div ref={listRef} className="qmongo-qb-options" role="listbox">
          {shown.map((entry, index) => {
            const badge = badgeFor(entry);
            return (
              // A button, not a div: the host's editor group takes focus on mousedown unless the target is a control,
              // and portal events reach it through the React tree. Losing focus would blur the input and close the
              // list before this handler runs. preventDefault keeps focus in the input.
              <button type="button" tabIndex={-1} key={entry.name} data-index={index} role="option" aria-selected={index === highlight}
                className={`qmongo-qb-option${index === highlight ? " is-active" : ""}${entry.name === value ? " is-current" : ""}`}
                title={describeEntry(entry) || entry.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(entry.name);
                }}
                onMouseEnter={() => setHighlight(index)}>
                <span className="qmongo-qb-item-name">{entry.label}</span>
                {badge && <span className="qmongo-tree-badge">{badge}</span>}
                <span className="qmongo-tree-count">{formatCount(entry.info.count)}</span>
              </button>
            );
          })}
          {status && <div className="qmongo-muted qmongo-qb-option-status">{status}</div>}
        </div>
      </Popup>
    </span>
  );
}

/**
 * A popup under an anchor, portalled to document.body with fixed positioning: the query editor's text pane clips
 * overflow, which would cut a popup off when the editor area is short. Closes on outside click and window resize.
 */
function Popup({ anchorRef, open, onClose, width, label, children }: {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  width: number;
  label: string;
  children: ReactNode;
}): JSX.Element | null {
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPosition(undefined);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 8)) });
  }, [open, anchorRef, width]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        onClose();
      }
    };
    window.addEventListener("resize", onClose);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("resize", onClose);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !position) {
    return null;
  }
  return createPortal(
    <div ref={popupRef} className="qmongo-qb-popover" role="dialog" aria-label={label}
      style={{ top: position.top, left: position.left, width, maxHeight: `calc(100vh - ${position.top + 8}px)` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onClose();
        }
      }}>
      {children}
    </div>,
    document.body
  );
}

/** A summary chip that opens a builder popup. */
function Chip({ label, value, open, disabled, width = POPOVER_WIDTH, onToggle, onClose, children }: {
  label: string;
  value: string;
  open: boolean;
  disabled: boolean;
  width?: number;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <span className="qmongo-qb-chipwrap" ref={anchorRef}>
      <button type="button" className="qmongo-qb-chip" aria-expanded={open} disabled={disabled} onClick={onToggle} title={value ? `${label}: ${value}` : label}>
        <span className="qmongo-qb-label">{label}</span> <span className="qmongo-qb-chip-value">{value}</span> <span aria-hidden="true">▾</span>
      </button>
      <Popup anchorRef={anchorRef} open={open} onClose={onClose} width={width} label={label}>
        {children}
      </Popup>
    </span>
  );
}

type BuilderProps = {
  context: PluginContext;
  connectionId: string;
  database: string;
  state: BarState;
  /** `run` also executes the query, e.g. on Enter in a filter value. */
  onChange: (state: BarState, run?: boolean) => void;
};

/** Sampled fields of the bar's collection, with a small loading/error line and a ↻ to sample again. */
function useFields({ context, connectionId, database, state }: BuilderProps): { fields: FieldInfo[]; status: ReactNode; refresh: () => void } {
  const loadable = fieldsOf(context, connectionId, database, state.collection);
  const status = loadable.status === "loading"
    ? <div className="qmongo-muted">Sampling fields…</div>
    : loadable.status === "error"
      ? <div className="qmongo-error">Could not sample fields: {loadable.message}</div>
      : loadable.items.length === 0 ? <div className="qmongo-muted">No fields in the sample.</div> : null;
  return {
    fields: loadable.status === "loaded" ? loadable.items : [],
    status,
    refresh: () => refreshFields(context, connectionId, database, state.collection)
  };
}

function FieldsPopover(props: BuilderProps): JSX.Element {
  const { state, onChange } = props;
  const { fields, status, refresh } = useFields(props);
  const [search, setSearch] = useState("");
  const chosen = new Set(state.projection.fields);
  // Fields chosen earlier but missing from this sample stay listed, so they can be unchecked
  const names = [...new Set([...fields.map((field) => field.name), ...state.projection.fields])];
  const typesOf = new Map(fields.map((field) => [field.name, field.types.join(" | ")]));
  const parentOf = new Map(fields.map((field) => [field.name, field.parent]));
  const visible = names.filter((name) => name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="qmongo-qb-builder">
      <div className="qmongo-qb-builder-head">
        <label className="qmongo-check">
          <input type="radio" name="qmongo-qb-projection-mode" checked={state.projection.mode === "include"}
            onChange={() => onChange(withProjectionMode(state, "include"))} />
          Show only checked
        </label>
        <label className="qmongo-check">
          <input type="radio" name="qmongo-qb-projection-mode" checked={state.projection.mode === "exclude"}
            onChange={() => onChange(withProjectionMode(state, "exclude"))} />
          Hide checked
        </label>
        <button type="button" className="qmongo-button" disabled={chosen.size === 0} onClick={() => onChange(clearProjection(state))}>Clear</button>
        <button type="button" className="qmongo-button" title="Sample the collection again" onClick={refresh}>↻</button>
      </div>
      <input className="qmongo-input" placeholder="Search fields" value={search} spellCheck={false} autoFocus
        onChange={(e) => setSearch(e.target.value)} />
      {status}
      <div className="qmongo-qb-list" role="group" aria-label="Fields">
        {visible.map((name) => (
          <label key={name} className="qmongo-qb-item">
            <input type="checkbox" checked={chosen.has(name)} onChange={() => onChange(toggleProjectionField(state, name))} />
            <span className="qmongo-qb-item-name" title={name}><FieldName name={name} parent={parentOf.get(name)} /></span>
            <span className="qmongo-tree-type">{typesOf.get(name) ?? "not in sample"}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SortPopover(props: BuilderProps): JSX.Element {
  const { state, onChange } = props;
  const { fields, status } = useFields(props);
  // Whole documents and arrays are left out: sorting by them is legal but almost never meant
  const unused = fields.filter((field) => isSortable(field.types)).map((field) => field.name)
    .filter((name) => !state.sort.some((key) => key.field === name));

  return (
    <div className="qmongo-qb-builder">
      {state.sort.length === 0 && <div className="qmongo-muted">Not sorted: documents come back in natural order.</div>}
      {state.sort.map((key, index) => (
        <div key={key.field} className="qmongo-qb-item">
          <span className="qmongo-muted">{index + 1}.</span>
          <span className="qmongo-qb-item-name">{key.field}</span>
          <button type="button" className="qmongo-button" aria-label={`Sort ${key.field} ${key.direction === 1 ? "descending" : "ascending"}`}
            title="Flip direction" onClick={() => onChange(flipSortKey(state, key.field))}>
            {key.direction === 1 ? "↑ asc" : "↓ desc"}
          </button>
          <button type="button" className="qmongo-button" aria-label={`Remove ${key.field}`} onClick={() => onChange(removeSortKey(state, key.field))}>✕</button>
        </div>
      ))}
      {status}
      {unused.length > 0 && (
        <select className="qmongo-input" aria-label="Add sort field" value="" onChange={(e) => e.target.value && onChange(addSortKey(state, e.target.value))}>
          <option value="">Add sort field…</option>
          {unused.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      )}
    </div>
  );
}

const OTHER_FIELD = "\u0000other";

/**
 * Filter builder: rows of field · operator · value type · value, matched all (AND) or any (OR). The value type starts
 * from the field's sampled types and can be changed, e.g. for a field stored as both numbers and text.
 */
function FilterPopover(props: BuilderProps): JSX.Element {
  const { state, onChange } = props;
  const { fields, status } = useFields(props);
  const { combine, conditions } = state.filter;
  const typesOf = new Map(fields.map((field) => [field.name, field.types]));

  const update = (next: Condition[], run = false): void => onChange(withFilter(state, { combine, conditions: next }), run);
  const replace = (index: number, condition: Condition, run = false): void =>
    update(conditions.map((c, i) => (i === index ? condition : c)), run);
  const firstUnused = fields.find((field) => !conditions.some((c) => c.field === field.name));

  return (
    <div className="qmongo-qb-builder">
      <div className="qmongo-qb-builder-head">
        <span className="qmongo-qb-label">Match</span>
        <label className="qmongo-check">
          <input type="radio" name="qmongo-qb-filter-combine" checked={combine === "and"}
            onChange={() => onChange(withFilter(state, { combine: "and", conditions }))} />
          all conditions
        </label>
        <label className="qmongo-check">
          <input type="radio" name="qmongo-qb-filter-combine" checked={combine === "or"}
            onChange={() => onChange(withFilter(state, { combine: "or", conditions }))} />
          any condition
        </label>
        <button type="button" className="qmongo-button" disabled={conditions.length === 0}
          onClick={() => onChange(withFilter(state, { combine, conditions: [] }))}>Clear</button>
      </div>
      {conditions.length === 0 && <div className="qmongo-muted">No conditions: every document matches.</div>}
      {conditions.map((condition, index) => (
        <ConditionRow key={index} index={index} condition={condition} fieldNames={fields.map((field) => field.name)} typesOf={typesOf}
          values={suggestsValues(condition) ? valuesOf(props.context, props.connectionId, props.database, state.collection, condition.field) : NO_VALUES}
          onChange={(next, run) => replace(index, next, run)}
          onRemove={() => update(conditions.filter((_, i) => i !== index))} />
      ))}
      {status}
      <div>
        <button type="button" className="qmongo-button"
          onClick={() => update([...conditions, newCondition(firstUnused?.name ?? "", firstUnused?.types)])}>
          + Add condition
        </button>
      </div>
    </div>
  );
}

function ConditionRow({ index, condition, fieldNames, typesOf, values, onChange, onRemove }: {
  index: number;
  condition: Condition;
  fieldNames: string[];
  typesOf: Map<string, string[]>;
  /** The field's distinct values, empty when there are none to suggest. */
  values: FieldValues;
  onChange: (condition: Condition, run?: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  // Value text is applied on blur or Enter, not per keystroke, so typing does not flood the editor's undo history
  const [draft, setDraft] = useState(condition.value);
  useEffect(() => setDraft(condition.value), [condition.value]);
  // A path that is not in the sample (e.g. address.city) is typed; "Other field…" switches to typing
  const [typing, setTyping] = useState(false);
  const [fieldDraft, setFieldDraft] = useState(condition.field);
  // Picking a field sampled only as documents or arrays continues as typing below it ("payload.source."), focused at the end
  const digInto = useRef<string | undefined>(undefined);
  const focusFieldInput = useRef(false);
  useEffect(() => {
    if (digInto.current !== undefined && digInto.current === condition.field) {
      digInto.current = undefined;
      focusFieldInput.current = true;
      setFieldDraft(`${condition.field}.`);
      setTyping(true);
      return;
    }
    setFieldDraft(condition.field);
    setTyping(false);
  }, [condition.field]);
  const customField = typing || (condition.field !== "" && !fieldNames.includes(condition.field));

  const label = `Condition ${index + 1}`;
  const listId = useId();
  const options = valueOptions(condition, draft, values.values);
  const result = clauseFor({ ...condition, value: draft });
  const error = "error" in result && condition.field !== "" ? result.error : undefined;
  const commitValue = (run: boolean): void => {
    if (draft !== condition.value || run) {
      onChange({ ...condition, value: draft }, run);
    }
  };
  const chooseField = (field: string): void => {
    const types = typesOf.get(field);
    // A sampled field retypes the row; a typed path keeps the type chosen so far, except "document", which a path below a document is not
    onChange(types ? withValueType({ ...condition, field }, valueTypeFor(types))
      : condition.type === "document" ? { ...withValueType({ ...condition, field }, "string"), op: "eq" } : { ...condition, field });
  };
  /** Applies the typed path. A path ending in "." (nothing typed below the parent) means the parent; nothing typed goes back to the list. */
  const commitFieldDraft = (): void => {
    const typed = fieldDraft.trim().replace(/\.+$/, "");
    if (typed !== condition.field) {
      chooseField(typed);
    } else if (typed === "" || fieldNames.includes(typed)) {
      setTyping(false);
    }
  };
  const sampledTypes = typesOf.get(condition.field);

  return (
    <div className="qmongo-qb-condition" role="group" aria-label={label}>
      {customField ? (
        <input className="qmongo-input qmongo-qb-cond-field" aria-label={`${label} field`} placeholder="field.path" value={fieldDraft} spellCheck={false}
          autoFocus={condition.field === ""}
          ref={(input) => {
            if (input && focusFieldInput.current) {
              focusFieldInput.current = false;
              input.focus();
              input.setSelectionRange(input.value.length, input.value.length);
            }
          }}
          onChange={(e) => setFieldDraft(e.target.value)}
          onBlur={commitFieldDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFieldDraft();
            }
          }} />
      ) : (
        <select className="qmongo-input qmongo-qb-cond-field" aria-label={`${label} field`} value={condition.field}
          title={sampledTypes ? `${condition.field}: ${sampledTypes.join(" | ")}` : undefined}
          onChange={(e) => {
            if (e.target.value === OTHER_FIELD) {
              // Below the current field when it holds documents or arrays (choosing it again in the list fires no change)
              const types = typesOf.get(condition.field);
              const below = types && !isSortable(types) ? `${condition.field}.` : "";
              focusFieldInput.current = below !== "";
              setTyping(true);
              setFieldDraft(below);
            } else {
              const types = typesOf.get(e.target.value);
              digInto.current = types && !isSortable(types) ? e.target.value : undefined;
              chooseField(e.target.value);
            }
          }}>
          {condition.field === "" && <option value="">Field…</option>}
          {fieldNames.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value={OTHER_FIELD}>Other field…</option>
        </select>
      )}
      <select className="qmongo-input qmongo-qb-cond-op" aria-label={`${label} operator`} value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as Condition["op"], value: draft })}>
        {operatorsFor(condition.type).map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      {takesValue(condition.op) && (
        <>
          <select className="qmongo-input qmongo-qb-cond-type" aria-label={`${label} value type`} value={condition.type}
            title="How the value is read"
            onChange={(e) => onChange(withValueType({ ...condition, value: draft }, e.target.value as Condition["type"]))}>
            {CHOOSABLE_VALUE_TYPES.map((type) => <option key={type} value={type}>{VALUE_TYPE_LABELS[type]}</option>)}
          </select>
          {condition.type === "boolean" ? (
            <select className="qmongo-input qmongo-qb-cond-value" aria-label={`${label} value`} value={condition.value}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : condition.type === "null" ? (
            <span className="qmongo-muted qmongo-qb-cond-value">null</span>
          ) : (
            <input className={`qmongo-input qmongo-qb-cond-value${error ? " is-invalid" : ""}`} aria-label={`${label} value`}
              aria-invalid={error ? true : undefined} value={draft} spellCheck={false}
              placeholder={placeholderFor(condition)} list={options.length > 0 ? listId : undefined}
              title={options.length > 0 ? `${suggestionNote(values)}; type or pick one` : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                // Picking a suggestion applies it at once, like choosing from a select
                if ((e.nativeEvent as InputEvent).inputType === "insertReplacementText" && options.includes(e.target.value)) {
                  onChange({ ...condition, value: e.target.value });
                }
              }}
              onBlur={() => commitValue(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitValue(true);
                }
              }} />
          )}
        </>
      )}
      {options.length > 0 && (
        <datalist id={listId} aria-label={`${label} suggested values`}>
          {options.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
      <button type="button" className="qmongo-button" aria-label={`Remove ${label.toLowerCase()}`} title="Remove" onClick={onRemove}>✕</button>
      {error && <div className="qmongo-error qmongo-qb-cond-error">{error}</div>}
      {/* Always visible, not only as a tooltip: a sampled list looks complete but may miss values */}
      {options.length > 0 && values.sampled !== undefined && (
        <div className="qmongo-muted qmongo-qb-cond-note" role="note">
          ⚠ Suggestions come from a random sample of {values.sampled.toLocaleString("en-US")} documents. Other values may exist.
        </div>
      )}
    </div>
  );
}

const NO_VALUES: FieldValues = { values: [] };

function suggestionNote({ values, sampled }: FieldValues): string {
  return sampled
    ? `${values.length} values seen in a random sample of ${sampled.toLocaleString("en-US")} documents (others may exist)`
    : `${values.length} values in this collection`;
}

/** A field path, with the parent of an embedded field dimmed (`payload.` in `payload.orderId`). */
function FieldName({ name, parent }: { name: string; parent: string | undefined }): JSX.Element {
  return parent && name.startsWith(`${parent}.`)
    ? <><span className="qmongo-muted">{parent}.</span>{name.slice(parent.length + 1)}</>
    : <>{name}</>;
}

function placeholderFor(condition: Condition): string {
  if (condition.op === "in" || condition.op === "nin") {
    return condition.type === "string" ? 'a, b, "c, d"' : "1, 2, 3";
  }
  switch (condition.type) {
    case "date":
      return "2026-11-14";
    case "objectId":
      return "24 hex characters";
    case "number":
    case "decimal":
      return "0";
    default:
      return condition.op === "regex" ? "^abc" : "value";
  }
}
