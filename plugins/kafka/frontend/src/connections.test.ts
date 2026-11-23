import { describe, expect, it, vi } from "vitest";
import { cloneConnection, connectionLabel, parseConnections, serializeConnection, validateConnection, type KafkaConnection } from "./connections.js";

describe("cloneConnection", () => {
  const source: KafkaConnection = {
    connectionId: "prod",
    title: "Prod",
    bootstrapServers: "b:9093",
    securityProtocol: "SASL_SSL",
    saslMechanism: "SCRAM-SHA-512",
    username: "app",
    password: { secretRef: "pw" },
    saslJaasConfig: { secretRef: "jaas" },
    enabled: true
  };

  it("gives the copy its own vault copy of every secret, through the host", async () => {
    // Stands in for context.settings.copySecrets
    const copySecrets = vi.fn(async <T,>(value: T): Promise<T> => {
      const connection = value as KafkaConnection;
      return { ...connection, password: { secretRef: "pw-copy" }, saslJaasConfig: { secretRef: "jaas-copy" } } as T;
    });
    const copy = await cloneConnection(source, copySecrets);

    expect(copySecrets).toHaveBeenCalledWith(source);
    expect(copy.connectionId).not.toBe("prod");
    expect(copy).toMatchObject({ title: "Prod (copy)", bootstrapServers: "b:9093", saslMechanism: "SCRAM-SHA-512", username: "app" });
    expect(copy.password).toEqual({ secretRef: "pw-copy" });
    expect(copy.saslJaasConfig).toEqual({ secretRef: "jaas-copy" });
    expect(source.password).toEqual({ secretRef: "pw" });
  });
});

describe("parseConnections", () => {
  it("skips incomplete and duplicate entries and normalises the security settings", () => {
    const connections = parseConnections([
      { connectionId: "local", bootstrapServers: " localhost:9092 " },
      { connectionId: "local", bootstrapServers: "other:9092" },
      { connectionId: "nobootstrap" },
      "not a connection",
      { connectionId: "prod", bootstrapServers: "b:9093", securityProtocol: "sasl_ssl", saslMechanism: "scram-sha-512", username: "app", password: { secretRef: "ref-1" }, enabled: false },
      { connectionId: "odd", bootstrapServers: "b:9092", securityProtocol: "WHATEVER", saslMechanism: "NOPE" }
    ]);

    expect(connections.map((connection) => connection.connectionId)).toEqual(["local", "prod", "odd"]);
    expect(connections[0]).toEqual({ connectionId: "local", bootstrapServers: "localhost:9092", securityProtocol: "PLAINTEXT", enabled: true });
    expect(connections[1]).toMatchObject({ securityProtocol: "SASL_SSL", saslMechanism: "SCRAM-SHA-512", password: { secretRef: "ref-1" }, enabled: false });
    expect(connections[2]).toMatchObject({ securityProtocol: "PLAINTEXT", saslMechanism: undefined });
    expect(parseConnections("nope")).toEqual([]);
  });
});

describe("validateConnection", () => {
  const base: KafkaConnection = { connectionId: "c", bootstrapServers: "localhost:9092", securityProtocol: "PLAINTEXT", enabled: true };

  it("accepts host:port lists", () => {
    expect(validateConnection(base)).toEqual({});
    expect(validateConnection({ ...base, bootstrapServers: "b1:9092, b2:9093" })).toEqual({});
  });

  it("says what is wrong", () => {
    expect(validateConnection({ ...base, bootstrapServers: " " }).bootstrapServers).toBe("At least one bootstrap server is required");
    expect(validateConnection({ ...base, bootstrapServers: "localhost" }).bootstrapServers).toBe('"localhost" is not a host:port');
    expect(validateConnection({ ...base, securityProtocol: "SASL_SSL" }).saslMechanism).toBe("Pick the SASL mechanism");
    expect(validateConnection({ ...base, securityProtocol: "SASL_SSL", saslMechanism: "PLAIN" }).username).toBe("A username is required");
    expect(validateConnection({ ...base, securityProtocol: "SASL_SSL", saslMechanism: "OAUTHBEARER" }).saslJaasConfig).toBe("OAUTHBEARER needs a JAAS configuration");
    expect(validateConnection({ ...base, securityProtocol: "SASL_SSL", saslMechanism: "GSSAPI" })).toEqual({});
    expect(validateConnection({ ...base, schemaRegistryUrl: "localhost:8081" }).schemaRegistryUrl).toBe("Use an http:// or https:// URL");
  });
});

describe("serializeConnection", () => {
  it("keeps only the credentials the security settings use", () => {
    const connection: KafkaConnection = {
      connectionId: "c",
      title: " Prod ",
      bootstrapServers: " b:9093 ",
      securityProtocol: "SASL_SSL",
      saslMechanism: "PLAIN",
      username: "app",
      password: { secretRef: "pw" },
      saslJaasConfig: { secretRef: "stale" },
      enabled: true
    };

    expect(serializeConnection(connection)).toEqual({
      connectionId: "c",
      title: "Prod",
      bootstrapServers: "b:9093",
      securityProtocol: "SASL_SSL",
      saslMechanism: "PLAIN",
      username: "app",
      password: { secretRef: "pw" },
      enabled: true
    });
    expect(serializeConnection({ ...connection, saslMechanism: "OAUTHBEARER" })).toMatchObject({ saslJaasConfig: { secretRef: "stale" } });
    expect(serializeConnection({ ...connection, securityProtocol: "SSL" })).toEqual({ connectionId: "c", title: "Prod", bootstrapServers: "b:9093", securityProtocol: "SSL", enabled: true });
  });

  it("round-trips through parseConnections", () => {
    const connection: KafkaConnection = { connectionId: "c", bootstrapServers: "b:9092", securityProtocol: "SASL_PLAINTEXT", saslMechanism: "SCRAM-SHA-256", username: "u", enabled: false };
    expect(parseConnections([serializeConnection(connection)])).toEqual([connection]);
  });
});

it("labels a connection by title, else by its bootstrap servers", () => {
  expect(connectionLabel({ connectionId: "c", title: " Prod ", bootstrapServers: "b:9092" })).toBe("Prod");
  expect(connectionLabel({ connectionId: "c", bootstrapServers: "b:9092" })).toBe("b:9092");
});
