import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { MONGODB_CATALOG_ID, mongoCatalogContribution, PAYLOADBUILDER_PLUGIN_ID, registerPayloadbuilderCatalog, resolveRuntimeProperties } from "./payloadbuilderCatalog.js";
import { CONNECTIONS_SETTING_ID } from "./constants.js";
import type { MongoConnection } from "./connections.js";

const connection = (connectionId: string, enabled = true): MongoConnection => ({
  connectionId,
  hosts: "localhost:27017",
  srv: false,
  tls: false,
  tlsAllowInvalidCertificates: false,
  enabled
});

function contextWith(payloadbuilderActive: boolean) {
  const registerContribution = vi.fn(() => ({ dispose: vi.fn() }));
  const context = {
    isDependencyActive: (id: string) => payloadbuilderActive && id === PAYLOADBUILDER_PLUGIN_ID,
    payloadbuilderCatalog: { registerContribution },
    settings: { getValue: (id: string) => (id === CONNECTIONS_SETTING_ID ? [connection("c1")] : undefined) }
  } as unknown as PluginContext;
  return { context, registerContribution };
}

describe("registerPayloadbuilderCatalog", () => {
  it("registers the mongodb catalog when payloadbuilder is there", () => {
    const { context, registerContribution } = contextWith(true);

    expect(registerPayloadbuilderCatalog(context)).toBeDefined();
    expect(registerContribution).toHaveBeenCalledWith(expect.objectContaining({ catalogId: MONGODB_CATALOG_ID, defaultAlias: "mongo" }));
  });

  it("registers nothing without payloadbuilder", () => {
    const { context, registerContribution } = contextWith(false);

    expect(registerPayloadbuilderCatalog(context)).toBeUndefined();
    expect(registerContribution).not.toHaveBeenCalled();
  });
});

describe("the mongodb catalog's properties", () => {
  it("sends the connection only while it exists and is enabled", () => {
    const connections = [connection("c1"), connection("off", false)];

    expect(resolveRuntimeProperties({ connectionId: "c1" }, connections)).toEqual({ connectionId: "c1" });
    expect(resolveRuntimeProperties({ connectionId: "off" }, connections)).toEqual({});
    expect(resolveRuntimeProperties({ connectionId: "core-connection" }, connections)).toEqual({});
    expect(resolveRuntimeProperties({}, connections)).toEqual({});
  });

  it("stores only the connection id", () => {
    const contribution = mongoCatalogContribution(() => []);

    expect(contribution.filterPersistedProperties?.({ connectionId: "c1", other: 1 })).toEqual({ connectionId: "c1" });
  });
});
