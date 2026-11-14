// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { EditorHandle } from "@queryeer/api/editor/EditorCapability";
import { ACTION_COLLECTIONS, ACTION_FIELDS, ACTION_VALUES, CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, MIME_TYPE, QUERY_BAR_STATE_KEY } from "./constants.js";
import { clearExplorerCache } from "./MongoExplorer.js";
import { MongoQueryBar } from "./MongoQueryBar.js";
import { initialState, textFor } from "./queryBarModel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An editor for file "f1" whose text can change as if typed, firing version events like Monaco. */
function fakeEditor(initial: string) {
  let text = initial;
  let version = 1;
  const listeners = new Set<(version: number) => void>();
  const setText = (next: string): void => {
    text = next;
    version++;
    listeners.forEach((listener) => listener(version));
  };
  const handle = {
    editorId: "e1",
    fileId: "f1",
    content: { getContent: () => text, setContent: vi.fn(setText) },
    versionedTextEdit: {
      getVersionId: () => version,
      replaceRange: () => ({ ok: false, reason: "editFailed", actualVersion: version }),
      onDidChangeVersion: (listener: (version: number) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    }
  } as unknown as EditorHandle;
  return { handle, text: () => text, type: setText };
}

let container: HTMLDivElement;
let root: Root;
let executeCommand: ReturnType<typeof vi.fn>;
let editorState: Map<string, unknown>;

beforeEach(() => {
  clearExplorerCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  executeCommand = vi.fn(async () => ({ executed: true }));
  editorState = new Map<string, unknown>([[DATABASE_STATE_KEY, { connectionId: "c1", database: "shop" }]]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll(".qmongo-qb-popover").forEach((element) => element.remove());
});

/**
 * Mimics Queryeer's editor group (ShellApp focusEditorGroupFromPointer): on mousedown it takes focus unless the target
 * is a form control or button. React events from portals bubble through the React tree, so this sees popup clicks too.
 */
function HostEditorGroup({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div tabIndex={-1} onMouseDownCapture={(event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target?.closest("input, textarea, select, button, [contenteditable='true'], [role='button']")) {
        event.currentTarget.focus({ preventScroll: true });
      }
    }}>
      {children}
    </div>
  );
}

async function mount(editor: EditorHandle): Promise<void> {
  const fileListeners = new Set<() => void>();
  const context = {
    files: {
      getFile: () => ({ fileId: "f1", mimeType: MIME_TYPE, engineBinding: { engineId: "mongodb", connectionId: "c1" } }),
      getEditorState: (_fileId: string, key: string) => editorState.get(key),
      setEditorState: (_fileId: string, key: string, value: unknown) => {
        editorState.set(key, value);
        fileListeners.forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        fileListeners.add(listener);
        return () => fileListeners.delete(listener);
      }
    },
    settings: {
      getValue: (id: string) => (id === CONNECTIONS_SETTING_ID ? [{ connectionId: "c1", hosts: "localhost:27017" }] : undefined),
      subscribe: () => () => {}
    },
    editors: { getActiveEditor: () => editor, onActiveEditorChanged: () => ({ dispose() {} }) },
    commands: { executeCommand },
    notifications: { notify: vi.fn() },
    queryEngines: {
      invoke: async ({ action, payload }: { action: string; payload?: { field?: string } }) => {
        if (action === ACTION_VALUES) {
          if (payload?.field === "status") {
            return { values: [{ type: "string", text: "new" }, { type: "string", text: "paid" }], complete: true };
          }
          // A large collection: values from a sample
          return payload?.field === "total"
            ? { values: [{ type: "double", text: "5" }, { type: "double", text: "7.5" }], complete: true, sampled: 1000 }
            : { values: [], complete: false };
        }
        if (action === ACTION_COLLECTIONS) {
          return [
            { name: "customers", type: "collection", count: 2 },
            { name: "openOrders", type: "view", count: null, viewOn: "orders" },
            { name: "orders", type: "collection", count: 3 },
            { name: "system.profile", type: "collection", count: 1 }
          ];
        }
        if (action === ACTION_FIELDS) {
          return [
            { name: "_id", types: ["objectId"], count: 3, sampled: 3 },
            { name: "status", types: ["string"], count: 3, sampled: 3 },
            { name: "total", types: ["double"], count: 3, sampled: 3 },
            { name: "payload", types: ["object"], count: 3, sampled: 3 },
            { name: "payload.orderId", types: ["int"], count: 3, sampled: 3, parent: "payload" }
          ];
        }
        return [];
      }
    }
  } as unknown as PluginContext;
  await act(async () => {
    root.render(<HostEditorGroup><MongoQueryBar context={context} fileId="f1" /></HostEditorGroup>);
  });
  await settle();
}

/** Lets queued loads and their re-renders finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Waits in small act() steps until `condition` holds; fails after two seconds. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within 2 s");
    }
    await settle();
  }
}

const byLabel = (label: string): HTMLButtonElement =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!;
const chip = (name: string): HTMLButtonElement =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(".qmongo-qb-chip")).find((b) => b.textContent?.startsWith(name))!;

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const options = (): string[] =>
  Array.from(document.body.querySelectorAll('[role="option"] .qmongo-qb-item-name')).map((option) => option.textContent ?? "");

async function openCombobox(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.focus();
  });
  await settle();
}

async function pick(label: string): Promise<void> {
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((element) => element.querySelector(".qmongo-qb-item-name")?.textContent === label)!;
  const focused = document.activeElement;
  await act(async () => {
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  // In Queryeer a focus change here closes the list before the option's handler runs (see HostEditorGroup)
  expect(document.activeElement).toBe(focused);
  await settle();
}

describe("MongoQueryBar", () => {
  it("lists every collection when opened, even with one selected, and filters only while typing", async () => {
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: textFor(initialState("orders")) });
    const editor = fakeEditor(textFor(initialState("orders")));
    await mount(editor.handle);
    const collection = container.querySelector<HTMLInputElement>(".qmongo-qb-collection")!;
    expect(collection.value).toBe("orders");

    await openCombobox(collection);
    expect(options()).toEqual(["customers", "orders", "openOrders"]);

    await typeInto(collection, "cust");
    expect(options()).toEqual(["customers"]);
    await act(async () => {
      collection.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(JSON.parse(editor.text()).find).toBe("customers");
  });


  it("writes a find as soon as a collection is picked, and runs it on Run", async () => {
    const editor = fakeEditor("");
    await mount(editor.handle);
    const collection = container.querySelector<HTMLInputElement>(".qmongo-qb-collection")!;
    await openCombobox(collection);
    expect(options()).toEqual(["customers", "orders", "openOrders"]);

    await pick("orders");
    expect(editor.text()).toBe(textFor(initialState("orders")));
    expect(executeCommand).not.toHaveBeenCalled();

    await click(byLabel("Run"));
    await until(() => executeCommand.mock.calls.length > 0);
    expect(executeCommand).toHaveBeenCalledWith("core.queryengine.execute");
  });

  it("builds projection and sort from sampled fields, writing live", async () => {
    const browse = textFor(initialState("orders"));
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: browse });
    const editor = fakeEditor(browse);
    await mount(editor.handle);

    await click(chip("Fields"));
    const checkbox = (name: string) =>
      Array.from(document.body.querySelectorAll<HTMLLabelElement>(".qmongo-qb-popover label.qmongo-qb-item"))
        .find((label) => label.textContent?.startsWith(name))!.querySelector("input")!;
    await click(checkbox("status"));
    await click(checkbox("total"));
    expect(JSON.parse(editor.text()).projection).toEqual({ status: 1, total: 1, _id: 0 });
    expect(chip("Fields").textContent).toContain("2 fields");
    // An embedded field shows its parent, and replaces the parent when checked
    await click(checkbox("payload"));
    await click(checkbox("payload.orderId"));
    expect(JSON.parse(editor.text()).projection).toEqual({ status: 1, total: 1, "payload.orderId": 1, _id: 0 });
    await click(checkbox("payload.orderId"));

    await click(chip("Sort"));
    const sortFields = Array.from(document.body.querySelector<HTMLSelectElement>('select[aria-label="Add sort field"]')!.options).map((o) => o.value);
    expect(sortFields).toContain("payload.orderId");
    expect(sortFields, "no sorting by a whole document").not.toContain("payload");
    await choose(document.body.querySelector<HTMLSelectElement>('select[aria-label="Add sort field"]')!, "total");
    await click(byLabel("Sort total descending"));
    expect(JSON.parse(editor.text()).sort).toEqual({ total: -1 });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("pages and runs", async () => {
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: textFor(initialState("orders")) });
    const editor = fakeEditor(textFor(initialState("orders")));
    await mount(editor.handle);
    expect(byLabel("Previous page").disabled).toBe(true);

    await click(byLabel("Next page"));
    expect(JSON.parse(editor.text()).skip).toBe(50);
    expect(container.textContent).toContain("51–100");
    await until(() => executeCommand.mock.calls.length > 0);
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it("steps aside after a hand edit and takes over again on request", async () => {
    const browse = textFor(initialState("orders"));
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: browse });
    const editor = fakeEditor(browse);
    await mount(editor.handle);

    await act(async () => {
      editor.type(browse.replace('"filter": {}', '"filter": { "status": "open" }'));
    });
    expect(container.textContent).toContain("Edited by hand");
    expect(container.querySelector(".qmongo-qb-chip")).toBeNull();

    await click(byLabel("Take over again"));
    expect(editor.text()).toBe(browse);
    expect(container.querySelector(".qmongo-qb-chip")).not.toBeNull();
  });

  it("offers to take over a command it did not write, prefilling the collection", async () => {
    const editor = fakeEditor('{\n  "count": "orders"\n}\n');
    await mount(editor.handle);
    expect(container.textContent).toContain("did not write");

    await click(byLabel("Use the query bar"));
    expect(editor.text()).toBe(textFor(initialState("orders")));
  });
});

describe("MongoQueryBar filter", () => {
  const conditionControl = <T extends HTMLElement>(row: number, part: "field" | "operator" | "value type" | "value"): T =>
    document.body.querySelector<T>(`[aria-label="Condition ${row} ${part}"]`)!;

  async function press(input: HTMLElement, key: string): Promise<void> {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle();
  }

  async function blur(input: HTMLInputElement): Promise<void> {
    await act(async () => {
      input.focus();
      input.blur();
    });
    await settle();
  }

  it("builds conditions typed from the sample, writes them into the find, and runs on Enter", async () => {
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: textFor(initialState("orders")) });
    const editor = fakeEditor(textFor(initialState("orders")));
    await mount(editor.handle);

    await click(chip("Filter"));
    await until(() => byLabel("+ Add condition") !== undefined);
    await click(byLabel("+ Add condition"));
    // The first sampled field not used yet, typed from its sampled types
    expect(conditionControl<HTMLSelectElement>(1, "field").value).toBe("_id");
    expect(conditionControl<HTMLSelectElement>(1, "value type").value).toBe("objectId");

    await choose(conditionControl<HTMLSelectElement>(1, "field"), "total");
    expect(conditionControl<HTMLSelectElement>(1, "value type").value).toBe("number");
    await choose(conditionControl<HTMLSelectElement>(1, "operator"), "gt");

    const value = conditionControl<HTMLInputElement>(1, "value");
    await typeInto(value, "abc");
    await blur(value);
    expect(document.body.textContent).toContain("Not a number");
    // An invalid row is kept in the bar but left out of the query
    expect(JSON.parse(editor.text()).filter).toEqual({});

    await typeInto(conditionControl<HTMLInputElement>(1, "value"), "100");
    expect(executeCommand).not.toHaveBeenCalled();
    await press(conditionControl<HTMLInputElement>(1, "value"), "Enter");
    expect(JSON.parse(editor.text()).filter).toEqual({ total: { $gt: 100 } });
    await until(() => executeCommand.mock.calls.length > 0);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(chip("Filter").textContent).toContain("total > 100");

    await click(byLabel("+ Add condition"));
    expect(conditionControl<HTMLSelectElement>(2, "field").value).toBe("_id");
    await choose(conditionControl<HTMLSelectElement>(2, "field"), "status");
    await choose(conditionControl<HTMLSelectElement>(2, "operator"), "contains");
    await typeInto(conditionControl<HTMLInputElement>(2, "value"), "pai");
    await blur(conditionControl<HTMLInputElement>(2, "value"));
    expect(JSON.parse(editor.text()).filter).toEqual({ total: { $gt: 100 }, status: { $regex: "pai", $options: "i" } });

    const any = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[name="qmongo-qb-filter-combine"]'))[1];
    await click(any);
    expect(JSON.parse(editor.text()).filter).toEqual({ $or: [{ total: { $gt: 100 } }, { status: { $regex: "pai", $options: "i" } }] });

    await click(byLabel("Remove condition 1"));
    expect(JSON.parse(editor.text()).filter).toEqual({ status: { $regex: "pai", $options: "i" } });
  });

  it("suggests the field's values, also for lists", async () => {
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: textFor(initialState("orders")) });
    const editor = fakeEditor(textFor(initialState("orders")));
    await mount(editor.handle);

    await click(chip("Filter"));
    await until(() => byLabel("+ Add condition") !== undefined);
    await click(byLabel("+ Add condition"));
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "status");
    const suggestions = (): string[] =>
      Array.from(document.body.querySelectorAll<HTMLOptionElement>('datalist[aria-label="Condition 1 suggested values"] option')).map((o) => o.value);
    await until(() => suggestions().length > 0);
    expect(suggestions()).toEqual(["new", "paid"]);
    expect(conditionControl<HTMLInputElement>(1, "value").getAttribute("list")).toBeTruthy();
    const note = (): string | undefined => document.body.querySelector('[role="group"][aria-label="Condition 1"] [role="note"]')?.textContent ?? undefined;
    expect(note(), "a complete list needs no note").toBeUndefined();

    await choose(conditionControl<HTMLSelectElement>(1, "operator"), "in");
    await typeInto(conditionControl<HTMLInputElement>(1, "value"), "new, ");
    expect(suggestions()).toEqual(["new, paid"]);

    // Values from a sample say so in the row itself, not only in a tooltip
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "total");
    await choose(conditionControl<HTMLSelectElement>(1, "operator"), "eq");
    await until(() => suggestions().length > 0);
    expect(suggestions()).toEqual(["5", "7.5"]);
    expect(note()).toContain("random sample of 1,000 documents");
    expect(note()).toContain("Other values may exist");

    // A field sampled only as embedded documents can only be tested for presence
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "payload");
    expect(Array.from(conditionControl<HTMLSelectElement>(1, "operator").options).map((o) => o.value)).toEqual(["exists", "missing"]);
    expect(JSON.parse(editor.text()).filter).toEqual({ payload: { $exists: true } });
    // ...and continues as typing below it, so a deeper path can be written
    const typed = conditionControl<HTMLInputElement>(1, "field");
    expect(typed.tagName).toBe("INPUT");
    expect(typed.value).toBe("payload.");
    expect(document.activeElement).toBe(typed);
    // Leaving without typing more keeps the parent and goes back to the list
    await blur(typed);
    expect(conditionControl<HTMLSelectElement>(1, "field").tagName).toBe("SELECT");
    expect(JSON.parse(editor.text()).filter).toEqual({ payload: { $exists: true } });
    // "Other field…" on a document field starts below it too
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "\u0000other");
    expect(conditionControl<HTMLInputElement>(1, "field").value).toBe("payload.");
    await typeInto(conditionControl<HTMLInputElement>(1, "field"), "payload.source.system");
    await press(conditionControl<HTMLInputElement>(1, "field"), "Enter");
    // Below a document, the row is no longer a document: it reads text with =
    expect(conditionControl<HTMLSelectElement>(1, "operator").value).toBe("eq");
    expect(conditionControl<HTMLSelectElement>(1, "value type").value).toBe("string");
    await typeInto(conditionControl<HTMLInputElement>(1, "value"), "pos");
    await blur(conditionControl<HTMLInputElement>(1, "value"));
    expect(JSON.parse(editor.text()).filter).toEqual({ "payload.source.system": "pos" });
    await typeInto(conditionControl<HTMLInputElement>(1, "field"), "");
    await blur(conditionControl<HTMLInputElement>(1, "field"));

    // A field with too many values gets a plain input
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "payload.orderId");
    await choose(conditionControl<HTMLSelectElement>(1, "operator"), "eq");
    expect(suggestions()).toEqual([]);
    expect(conditionControl<HTMLInputElement>(1, "value").getAttribute("list")).toBeNull();
    expect(note()).toBeUndefined();
  });

  it("filters on a field path that is not in the sample", async () => {
    editorState.set(QUERY_BAR_STATE_KEY, { state: initialState("orders"), written: textFor(initialState("orders")) });
    const editor = fakeEditor(textFor(initialState("orders")));
    await mount(editor.handle);

    await click(chip("Filter"));
    await until(() => byLabel("+ Add condition") !== undefined);
    await click(byLabel("+ Add condition"));
    await choose(conditionControl<HTMLSelectElement>(1, "field"), "\u0000other");
    const field = conditionControl<HTMLInputElement>(1, "field");
    expect(field.tagName).toBe("INPUT");
    await typeInto(field, "shipping.method");
    await press(field, "Enter");
    // Not in the sample: keeps the type chosen so far (ObjectId from _id), so switch to text
    await choose(conditionControl<HTMLSelectElement>(1, "value type"), "string");
    await typeInto(conditionControl<HTMLInputElement>(1, "value"), "home");
    await blur(conditionControl<HTMLInputElement>(1, "value"));
    expect(JSON.parse(editor.text()).filter).toEqual({ "shipping.method": "home" });
    expect(conditionControl<HTMLInputElement>(1, "field").value).toBe("shipping.method");
  });
});
