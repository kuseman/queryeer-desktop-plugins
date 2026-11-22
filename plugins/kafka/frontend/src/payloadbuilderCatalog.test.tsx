// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayloadbuilderCatalogPanelProps } from "@queryeer/api/queryengine/PayloadbuilderCatalogExtension";
import type { KafkaConnection } from "./connections.js";
import { ACTION_LIST_TOPICS, LIST_TOPICS_TIMEOUT_MS } from "./constants.js";
import { kafkaCatalogContribution, resolveRuntimeProperties } from "./payloadbuilderCatalog.js";
import type { PluginBackend } from "./pluginBackend.js";
import { testConnection } from "./plugin.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connections: KafkaConnection[] = [
  { connectionId: "local", title: "Local", bootstrapServers: "localhost:9092", securityProtocol: "PLAINTEXT", enabled: true },
  { connectionId: "off", bootstrapServers: "off:9092", securityProtocol: "PLAINTEXT", enabled: false }
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

function renderPanel(backend: PluginBackend, properties: Record<string, unknown>, setProperty = vi.fn()) {
  const contribution = kafkaCatalogContribution(() => connections, backend);
  act(() => {
    root.render(contribution.renderPanel!({ fileId: "f1", alias: "kafka", properties, setProperty } as unknown as PayloadbuilderCatalogPanelProps));
  });
  return setProperty;
}

describe("resolveRuntimeProperties", () => {
  it("sends an enabled connection and the picked topic", () => {
    expect(resolveRuntimeProperties({ connectionId: "local", topic: "orders" }, connections)).toEqual({ connectionId: "local", topic: "orders" });
    expect(resolveRuntimeProperties({ connectionId: "local", topic: "" }, connections)).toEqual({ connectionId: "local" });
    expect(resolveRuntimeProperties({ connectionId: "off", topic: "orders" }, connections)).toEqual({});
    expect(resolveRuntimeProperties({}, connections)).toEqual({});
  });
});

describe("the catalog panel", () => {
  it("picks the first enabled connection for a new catalog", () => {
    const invoke = vi.fn();
    const setProperty = renderPanel({ invoke } as unknown as PluginBackend, {});

    expect(setProperty).toHaveBeenCalledWith("connectionId", "local");
    const options = Array.from(container.querySelectorAll<HTMLOptionElement>("#com-queryeer-kafka-catalog-connection-kafka option")).map((option) => option.textContent);
    expect(options).toEqual(["Select connection", "Local"]);
  });

  it("lists topics through the plugin's own backend action", async () => {
    const invoke = vi.fn(async () => ({ topics: ["orders", "payments"] }));
    renderPanel({ invoke } as unknown as PluginBackend, { connectionId: "local", topic: "" });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });

    expect(invoke).toHaveBeenCalledWith(ACTION_LIST_TOPICS, { connectionId: "local" }, { timeoutMs: LIST_TOPICS_TIMEOUT_MS });
    const topics = Array.from(container.querySelectorAll<HTMLOptionElement>("#com-queryeer-kafka-catalog-topic-kafka option")).map((option) => option.value);
    expect(topics).toEqual(["", "orders", "payments"]);
  });

  it("keeps the listed topics when the panel is shown again, also for another file on the same connection", async () => {
    const invoke = vi.fn(async () => ({ topics: ["orders", "payments"] }));
    const contribution = kafkaCatalogContribution(() => connections, { invoke } as unknown as PluginBackend);
    const show = (fileId: string) =>
      act(() => {
        root.render(
          contribution.renderPanel!({ fileId, alias: "kafka", properties: { connectionId: "local", topic: "" }, setProperty: vi.fn() } as unknown as PayloadbuilderCatalogPanelProps)
        );
      });
    const topics = () => Array.from(container.querySelectorAll<HTMLOptionElement>("#com-queryeer-kafka-catalog-topic-kafka option")).map((option) => option.value);

    show("f1");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });
    expect(topics()).toEqual(["", "orders", "payments"]);

    // Another file type is shown: the panel unmounts
    act(() => root.render(<div />));
    show("f1");
    expect(topics()).toEqual(["", "orders", "payments"]);

    act(() => root.render(<div />));
    show("f2");
    expect(topics()).toEqual(["", "orders", "payments"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows why the topics couldn't be listed", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Kafka did not answer within 30 seconds");
    });
    renderPanel({ invoke } as unknown as PluginBackend, { connectionId: "local" });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Kafka did not answer within 30 seconds");
  });

  it("keeps a connection that is no longer configured visible, and doesn't list its topics", () => {
    renderPanel({ invoke: vi.fn() } as unknown as PluginBackend, { connectionId: "gone" });

    expect(container.querySelector("#com-queryeer-kafka-catalog-connection-kafka option[value='gone']")?.textContent).toBe("gone (unavailable)");
    expect(container.querySelector<HTMLButtonElement>(".payloadbuilder-catalog-button")!.disabled).toBe(true);
  });
});

describe("testConnection", () => {
  it("reports the cluster or the backend's message", async () => {
    const ok = vi.fn(async () => ({ ok: true, clusterId: "abc", brokers: 3 }));
    await expect(testConnection({ invoke: ok } as unknown as PluginBackend, { connectionId: "c" })).resolves.toEqual({ ok: true, clusterId: "abc", brokers: 3 });
    expect(ok).toHaveBeenCalledWith("connection.test", { connection: { connectionId: "c" } }, { timeoutMs: 15_000 });

    const failed = vi.fn(async () => ({ ok: false, message: "Could not connect: Timed out" }));
    await expect(testConnection({ invoke: failed } as unknown as PluginBackend, {})).resolves.toEqual({ ok: false, message: "Could not connect: Timed out" });
  });
});
