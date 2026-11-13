// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { EditorHandle } from "@queryeer/api/editor/EditorCapability";
import { ACTION_COLLECTIONS, ACTION_FIELDS, CONNECTIONS_SETTING_ID, DATABASE_STATE_KEY, MIME_TYPE, QUERY_BAR_STATE_KEY } from "./constants.js";
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
      invoke: async ({ action }: { action: string }) => {
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
            { name: "total", types: ["double"], count: 3, sampled: 3 }
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

    await click(chip("Sort"));
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
