import { describe, expect, it } from "vitest";
import { cloneConnection, connectionLabel, parseConnections, parseTimeout, serializeConnection, validateConnection, type ElasticsearchConnection } from "./connections.js";

describe("parseConnections", () => {
  it("skips incomplete and duplicate entries and normalises the fields", () => {
    const connections = parseConnections([
      { connectionId: "local", endpoint: " http://localhost:9200 " },
      { connectionId: "local", endpoint: "http://other:9200" },
      { connectionId: "noendpoint" },
      "not a connection",
      {
        connectionId: "prod",
        endpoint: "https://es:9200",
        authType: "basic",
        authUsername: "app",
        authPassword: { secretRef: "ref-1" },
        trustCertificate: true,
        connectTimeoutMs: 2000,
        enabled: false
      },
      { connectionId: "odd", endpoint: "http://es:9200", authType: "KERBEROS", authPassword: "plain", connectTimeoutMs: "5000" }
    ]);

    expect(connections).toEqual([
      { connectionId: "local", endpoint: "http://localhost:9200", authType: "NONE", trustCertificate: false, enabled: true },
      {
        connectionId: "prod",
        endpoint: "https://es:9200",
        authType: "BASIC",
        authUsername: "app",
        authPassword: { secretRef: "ref-1" },
        trustCertificate: true,
        connectTimeoutMs: 2000,
        enabled: false
      },
      // A plain-text password is never kept
      { connectionId: "odd", endpoint: "http://es:9200", authType: "NONE", trustCertificate: false, enabled: true }
    ]);
  });
});

describe("validateConnection", () => {
  it("needs an http(s) endpoint, a username for basic auth, and whole positive timeouts", () => {
    expect(validateConnection({ endpoint: "https://es:9200", authType: "NONE" })).toEqual({});
    expect(validateConnection({ endpoint: "", authType: "NONE" }).endpoint).toBe("An endpoint is required");
    expect(validateConnection({ endpoint: "localhost:9200", authType: "NONE" }).endpoint).toMatch(/http:\/\/ or https:\/\//);
    expect(validateConnection({ endpoint: "https://es:9200", authType: "BASIC" }).authUsername).toBe("A username is required");
    expect(validateConnection({ endpoint: "https://es:9200", authType: "NONE", connectTimeoutMs: 0 }).connectTimeoutMs).toBeDefined();
    expect(validateConnection({ endpoint: "https://es:9200", authType: "NONE", receiveTimeoutMs: 60000 })).toEqual({});
  });
});

describe("parseTimeout", () => {
  it("keeps the digits, and is empty for the default", () => {
    expect(parseTimeout("2000")).toBe(2000);
    expect(parseTimeout("2 000ms")).toBe(2000);
    expect(parseTimeout("")).toBeUndefined();
    expect(parseTimeout("abc")).toBeUndefined();
  });
});

describe("serializeConnection", () => {
  it("leaves out empty fields and credentials basic auth isn't on for", () => {
    const connection: ElasticsearchConnection = {
      connectionId: "c",
      title: "  ",
      endpoint: " https://es:9200 ",
      authType: "NONE",
      authUsername: "leftover",
      authPassword: { secretRef: "pw" },
      trustCertificate: false,
      enabled: true
    };

    expect(serializeConnection(connection)).toEqual({ connectionId: "c", endpoint: "https://es:9200", authType: "NONE", enabled: true });
    expect(serializeConnection({ ...connection, authType: "BASIC", trustCertificate: true, receiveTimeoutMs: 60000 })).toEqual({
      connectionId: "c",
      endpoint: "https://es:9200",
      authType: "BASIC",
      authUsername: "leftover",
      authPassword: { secretRef: "pw" },
      trustCertificate: true,
      receiveTimeoutMs: 60000,
      enabled: true
    });
  });
});

describe("cloneConnection", () => {
  it("gives the copy its own vault copy of the password, through the host", async () => {
    const [source] = parseConnections([{ connectionId: "a", title: "Prod", endpoint: "https://es:9200", authType: "BASIC", authUsername: "u", authPassword: { secretRef: "s" } }]);
    // Stands in for context.settings.copySecrets
    const copySecrets = async <T,>(value: T): Promise<T> => ({ ...(value as object), authPassword: { secretRef: "s-copy" } }) as T;

    const copy = await cloneConnection(source, copySecrets);

    expect(copy.connectionId).not.toBe("a");
    expect(copy).toMatchObject({ title: "Prod (copy)", endpoint: "https://es:9200", authUsername: "u", authPassword: { secretRef: "s-copy" } });
    expect(source.authPassword).toEqual({ secretRef: "s" });
  });
});

describe("connectionLabel", () => {
  it("prefers the title, then the endpoint", () => {
    expect(connectionLabel({ connectionId: "c", title: " Prod ", endpoint: "https://es:9200" })).toBe("Prod");
    expect(connectionLabel({ connectionId: "c", endpoint: "https://es:9200" })).toBe("https://es:9200");
  });
});
