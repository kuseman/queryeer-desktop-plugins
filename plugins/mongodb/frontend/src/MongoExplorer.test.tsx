// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { ACTION_COLLECTIONS, ACTION_FIELDS, ACTION_INDEXES } from "./constants.js";
import { clearExplorerCache, MongoExplorer } from "./MongoExplorer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const responses: Record<string, unknown> = {
  [ACTION_COLLECTIONS]: [
    { name: "orders", type: "collection", count: 3, validator: "{\"$jsonSchema\": {}}", validationLevel: "strict", validationAction: "warn" },
    { name: "system.profile", type: "collection", count: 10 }
  ],
  [ACTION_FIELDS]: [{ name: "_id", types: ["objectId"], count: 3, sampled: 3 }],
  [ACTION_INDEXES]: [{ name: "_id_", key: "{\"_id\": 1}", unique: false }]
};

const context = {
  queryEngines: { invoke: async ({ action }: { action: string }) => responses[action] }
} as unknown as PluginContext;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearExplorerCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function click(label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `button "${label}"`).not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

describe("MongoExplorer", () => {
  it("expands a collection into Fields and Indexes folders", async () => {
    await act(async () => {
      root.render(<MongoExplorer context={context} connectionId="c1" databases={["shop"]} />);
    });

    await click("Expand shop");
    expect(container.textContent).toContain("orders");

    await click("Expand orders");
    expect(container.textContent).toContain("Fields");
    expect(container.textContent).toContain("Indexes");

    await click("Expand fields");
    await click("Expand indexes");
    expect(container.textContent).toContain("objectId");
    expect(container.textContent).toContain("_id_");
    expect(container.textContent).toContain("Validator");
    expect(container.textContent).toContain("warn");
  });

  it("offers Stats on a database, and Slowest queries when system.profile exists", async () => {
    await act(async () => {
      root.render(<MongoExplorer context={context} connectionId="c2" databases={["shop"]} />);
    });
    await click("Expand shop");

    const dbActions = container.querySelector<HTMLButtonElement>('button[title="Actions"]');
    await act(async () => {
      dbActions!.click();
    });
    const items = Array.from(container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
    expect(items).toEqual(["Stats", "Slowest queries"]);
  });
});
