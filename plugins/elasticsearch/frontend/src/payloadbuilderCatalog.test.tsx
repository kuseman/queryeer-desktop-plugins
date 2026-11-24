// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginBackend } from "@queryeer/api/plugin/PluginBackend";
import type { PayloadbuilderCatalogPanelProps } from "@queryeer/api/queryengine/PayloadbuilderCatalogExtension";
import type { ElasticsearchConnection } from "./connections.js";
import { ACTION_LIST_INDICES, ACTION_TEST_CONNECTION, LIST_INDICES_TIMEOUT_MS, TEST_CONNECTION_TIMEOUT_MS } from "./constants.js";
import { elasticsearchCatalogContribution, matchIndices, resolveRuntimeProperties } from "./payloadbuilderCatalog.js";
import { testConnection } from "./plugin.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connections: ElasticsearchConnection[] = [
  { connectionId: "local", title: "Local", endpoint: "http://localhost:9200", authType: "NONE", trustCertificate: false, enabled: true },
  { connectionId: "off", endpoint: "http://off:9200", authType: "NONE", trustCertificate: false, enabled: false }
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPanel(backend: PluginBackend, properties: Record<string, unknown>, setProperty = vi.fn(), contribution = elasticsearchCatalogContribution(() => connections, backend)) {
  act(() => {
    root.render(contribution.renderPanel!({ fileId: "f1", alias: "es", properties, setProperty } as unknown as PayloadbuilderCatalogPanelProps));
  });
  return setProperty;
}

/** Opens the suggestion list (when closed) and returns what it shows. */
function indexOptions(): string[] {
  if (!container.querySelector(".qes-combobox-popup")) {
    act(() => {
      container.querySelector<HTMLButtonElement>(".qes-combobox-toggle")!.click();
    });
  }
  return Array.from(container.querySelectorAll<HTMLLIElement>("#com-queryeer-elasticsearch-catalog-indices-es li")).map((option) => option.textContent ?? "");
}

function indexInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("#com-queryeer-elasticsearch-catalog-index-es")!;
}

describe("matchIndices", () => {
  const indices = ["filebeat-8.7", "filebeat-8.8", "metricbeat-8.8", "orders"];

  it("lists everything for nothing typed, matches a pattern as a wildcard, and text anywhere in the name", () => {
    expect(matchIndices(indices, " ")).toEqual(indices);
    expect(matchIndices(indices, "filebeat-*")).toEqual(["filebeat-8.7", "filebeat-8.8"]);
    expect(matchIndices(indices, "*beat-8.8")).toEqual(["filebeat-8.8", "metricbeat-8.8"]);
    expect(matchIndices(indices, "filebeat-8.?")).toEqual(["filebeat-8.7", "filebeat-8.8"]);
    expect(matchIndices(indices, "Beat")).toEqual(["filebeat-8.7", "filebeat-8.8", "metricbeat-8.8"]);
    // A dot is literal, not a regex wildcard
    expect(matchIndices(["filebeat-8x7"], "filebeat-8.*")).toEqual([]);
    expect(matchIndices(indices, "nothing*")).toEqual([]);
  });
});

describe("the catalog contribution", () => {
  it("replaces the built-in elasticsearch catalog and stores what it does", () => {
    const contribution = elasticsearchCatalogContribution(() => connections, { invoke: vi.fn() } as unknown as PluginBackend);

    expect(contribution).toMatchObject({ catalogId: "elasticsearch", defaultAlias: "es" });
    expect(contribution.filterPersistedProperties!({ connectionId: "local", index: "orders", endpoint: "http://x", extra: 1 })).toEqual({ connectionId: "local", index: "orders" });
  });
});

describe("resolveRuntimeProperties", () => {
  it("sends an enabled connection and the index", () => {
    expect(resolveRuntimeProperties({ connectionId: "local", index: " logs-* " }, connections)).toEqual({ connectionId: "local", index: "logs-*" });
    expect(resolveRuntimeProperties({ connectionId: "local", index: "" }, connections)).toEqual({ connectionId: "local" });
    expect(resolveRuntimeProperties({ connectionId: "off", index: "orders" }, connections)).toEqual({});
    expect(resolveRuntimeProperties({}, connections)).toEqual({});
  });
});

describe("the catalog panel", () => {
  it("picks the first enabled connection for a new catalog", () => {
    const setProperty = renderPanel({ invoke: vi.fn() } as unknown as PluginBackend, {});

    expect(setProperty).toHaveBeenCalledWith("connectionId", "local");
    const options = Array.from(container.querySelectorAll<HTMLOptionElement>("#com-queryeer-elasticsearch-catalog-connection-es option")).map((option) => option.textContent);
    expect(options).toEqual(["Select connection", "Local"]);
  });

  it("shows a connection that no longer exists as unavailable", () => {
    renderPanel({ invoke: vi.fn() } as unknown as PluginBackend, { connectionId: "gone" });

    const options = Array.from(container.querySelectorAll<HTMLOptionElement>("#com-queryeer-elasticsearch-catalog-connection-es option")).map((option) => option.textContent);
    expect(options).toContain("gone (unavailable)");
    expect(container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.disabled).toBe(true);
  });

  it("lists indices through the plugin's own backend action, as suggestions for a free-text index", async () => {
    const invoke = vi.fn(async () => ({ indices: ["current-orders", "orders"] }));
    renderPanel({ invoke } as unknown as PluginBackend, { connectionId: "local", index: "logs-*" });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });

    expect(invoke).toHaveBeenCalledWith(ACTION_LIST_INDICES, { connectionId: "local" }, { timeoutMs: LIST_INDICES_TIMEOUT_MS });
    expect(indexInput().value).toBe("logs-*");
    // logs-* matches none of them, and the list says so instead of showing nothing
    expect(container.querySelector(".qes-combobox-hint")?.textContent).toBe("logs-* matches none of the 2 listed indices");
    expect(indexOptions()).toEqual([]);
    expect(container.querySelector(".qes-combobox-summary")?.textContent).toBe("logs-* matches none of the 2 listed indices");
  });

  it("keeps the listed indices when the panel is shown again", async () => {
    const invoke = vi.fn(async () => ({ indices: ["orders"] }));
    const backend = { invoke } as unknown as PluginBackend;
    const contribution = elasticsearchCatalogContribution(() => connections, backend);
    renderPanel(backend, { connectionId: "local" }, vi.fn(), contribution);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });

    act(() => root.unmount());
    root = createRoot(container);
    renderPanel(backend, { connectionId: "local" }, vi.fn(), contribution);

    expect(indexOptions()).toEqual(["orders"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows why the indices couldn't be listed", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Elasticsearch rejected the username or password");
    });
    renderPanel({ invoke } as unknown as PluginBackend, { connectionId: "local" });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Elasticsearch rejected the username or password");
  });
});

describe("testConnection", () => {
  it("calls the plugin's backend and passes on its answer", async () => {
    const ok = vi.fn(async () => ({ ok: true, clusterName: "docker-cluster", version: "8.7.1" }));
    await expect(testConnection({ invoke: ok } as unknown as PluginBackend, { connectionId: "c" })).resolves.toEqual({ ok: true, clusterName: "docker-cluster", version: "8.7.1" });
    expect(ok).toHaveBeenCalledWith(ACTION_TEST_CONNECTION, { connection: { connectionId: "c" } }, { timeoutMs: TEST_CONNECTION_TIMEOUT_MS });

    const failed = vi.fn(async () => ({ ok: false, message: "Could not connect to http://localhost:1" }));
    await expect(testConnection({ invoke: failed } as unknown as PluginBackend, {})).resolves.toEqual({ ok: false, message: "Could not connect to http://localhost:1" });
  });
});

describe("the index suggestions", () => {
  const indices = ["filebeat-8.7", "filebeat-8.8", "orders"];

  async function renderLoaded(index: string, setProperty = vi.fn()) {
    const backend = { invoke: vi.fn(async () => ({ indices })) } as unknown as PluginBackend;
    renderPanel(backend, { connectionId: "local", index }, setProperty);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });
    return setProperty;
  }

  it("lists what a pattern matches, and says how many", async () => {
    await renderLoaded("filebeat-*");

    expect(container.querySelector(".qes-combobox-hint")?.textContent).toBe("filebeat-* matches 2 indices");
    expect(indexOptions()).toEqual(["filebeat-8.7", "filebeat-8.8"]);
  });

  it("picks a suggestion with the keyboard", async () => {
    const setProperty = await renderLoaded("");

    act(() => {
      indexInput().focus();
      indexInput().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      indexInput().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      indexInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(setProperty).toHaveBeenCalledWith("index", "filebeat-8.8");
    expect(container.querySelector(".qes-combobox-popup")).toBeNull();
  });

  it("picks a suggestion with the mouse", async () => {
    const setProperty = await renderLoaded("orde");

    expect(indexOptions()).toEqual(["orders"]);
    act(() => {
      container.querySelector<HTMLLIElement>("#com-queryeer-elasticsearch-catalog-indices-es li")!.click();
    });

    expect(setProperty).toHaveBeenCalledWith("index", "orders");
  });

  it("loads the indices from the toggle when they aren't loaded yet", async () => {
    const invoke = vi.fn(async () => ({ indices }));
    renderPanel({ invoke } as unknown as PluginBackend, { connectionId: "local" });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".qes-combobox-toggle")!.click();
    });

    expect(invoke).toHaveBeenCalledWith(ACTION_LIST_INDICES, { connectionId: "local" }, { timeoutMs: LIST_INDICES_TIMEOUT_MS });
    expect(Array.from(container.querySelectorAll("#com-queryeer-elasticsearch-catalog-indices-es li")).map((option) => option.textContent)).toEqual(indices);
  });
});
