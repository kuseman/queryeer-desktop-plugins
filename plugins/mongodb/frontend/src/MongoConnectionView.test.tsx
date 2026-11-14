// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntity } from "@queryeer/api/files/FileEntity";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { connectionFingerprint } from "./connections.js";
import { ACTION_DATABASES, CONNECTIONS_SETTING_ID } from "./constants.js";
import { clearDatabaseCache, MongoConnectionView } from "./MongoConnectionView.js";
import { clearExplorerCache } from "./MongoExplorer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = { fileId: "f1", engineBinding: { engineId: "mongodb", connectionId: "c1" } } as unknown as FileEntity;
const invoke = vi.fn(async ({ action }: { action: string }) => (action === ACTION_DATABASES ? ["shop"] : []));
const context = {
  settings: { getValue: (id: string) => (id === CONNECTIONS_SETTING_ID ? [{ connectionId: "c1", hosts: "localhost" }] : undefined), subscribe: () => () => {} },
  files: { getFile: () => file, getEditorState: () => undefined, subscribe: () => () => {} },
  queryEngines: { invoke }
} as unknown as PluginContext;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearDatabaseCache();
  clearExplorerCache();
  invoke.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const databaseLoads = () => invoke.mock.calls.filter(([request]) => request.action === ACTION_DATABASES).length;

describe("MongoConnectionView", () => {
  it("loads the databases again after the cache is cleared, e.g. when connection details change", async () => {
    await act(async () => {
      root.render(<MongoConnectionView context={context} file={file} />);
    });
    await settle();
    expect(databaseLoads()).toBe(1);
    expect(container.textContent).not.toContain("Loading databases");

    await act(async () => {
      clearDatabaseCache();
    });
    await settle();
    expect(databaseLoads()).toBe(2);
    expect(container.textContent).not.toContain("Loading databases");
  });
});

describe("connectionFingerprint", () => {
  it("ignores title and color, which do not change where the connection goes", () => {
    const base = { connectionId: "c1", hosts: "localhost:27017" };
    expect(connectionFingerprint([{ ...base, title: "Prod", color: "#ff0000" }])).toBe(connectionFingerprint([base]));
    expect(connectionFingerprint([{ ...base, hosts: "other:27017" }])).not.toBe(connectionFingerprint([base]));
    expect(connectionFingerprint([{ ...base, defaultDatabase: "shop" }])).not.toBe(connectionFingerprint([base]));
  });
});
