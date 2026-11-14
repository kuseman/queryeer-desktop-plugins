import { describe, expect, it } from "vitest";
import {
  connectionLabel,
  isValidConnection,
  newConnection,
  parseConnectionString,
  parseConnections,
  serializeConnection,
  validateConnection
} from "./connections.js";

describe("connection color", () => {
  it("keeps a #rrggbb color through storage and drops anything else", () => {
    const [stored] = parseConnections([{ connectionId: "c1", hosts: "h", color: "#FF8800" }]);
    expect(stored.color).toBe("#ff8800");
    expect(serializeConnection(stored).color).toBe("#ff8800");
    expect(parseConnections([{ connectionId: "c1", hosts: "h", color: "red" }])[0].color).toBeUndefined();
    expect(serializeConnection(newConnection())).not.toHaveProperty("color");
  });
});

describe("parseConnectionString", () => {
  it("reads hosts, user, database and options, and leaves the password out", () => {
    expect(parseConnectionString("mongodb://app%40corp:s3cr%3At@db1:27017,db2:27018/shop?replicaSet=rs0&authSource=admin&readPreference=secondary"))
      .toEqual({
        fields: {
          hosts: "db1:27017,db2:27018",
          srv: false,
          tls: false,
          tlsAllowInvalidCertificates: false,
          username: "app@corp",
          authDatabase: "admin",
          defaultDatabase: "shop",
          options: "replicaSet=rs0&readPreference=secondary"
        },
        hadPassword: true
      });
  });

  it("follows the driver's defaults for SRV, TLS and the authentication database", () => {
    const srv = parseConnectionString("mongodb+srv://reader@cluster0.example.mongodb.net/reports");
    expect(srv).toMatchObject({ fields: { srv: true, tls: true, authDatabase: "reports", defaultDatabase: "reports" }, hadPassword: false });
    expect(parseConnectionString("mongodb+srv://cluster0.example.mongodb.net/?tls=false")).toMatchObject({ fields: { tls: false } });
    expect(parseConnectionString("mongodb://u@h/?ssl=true&tlsInsecure=true")).toMatchObject({ fields: { tls: true, tlsAllowInvalidCertificates: true, authDatabase: "admin" } });
    expect(parseConnectionString("mongodb://h:27017")).toEqual({
      fields: { hosts: "h:27017", srv: false, tls: false, tlsAllowInvalidCertificates: false, username: undefined, authDatabase: undefined, defaultDatabase: undefined, options: undefined },
      hadPassword: false
    });
  });

  it("gives a connection that validates, and rejects anything else", () => {
    const parsed = parseConnectionString("mongodb://localhost:27017/?appName=queryeer");
    expect("fields" in parsed && isValidConnection({ ...newConnection(), ...parsed.fields })).toBe(true);
    expect(parseConnectionString("postgres://h/db")).toHaveProperty("error");
    expect(parseConnectionString("mongodb://")).toHaveProperty("error");
    expect(parseConnectionString("mongodb://u%ZZ@h")).toHaveProperty("error");
  });
});

describe("parseConnections", () => {
  it("parses stored connections with defaults and skips invalid or duplicate entries", () => {
    const parsed = parseConnections([
      { connectionId: "a", hosts: " localhost:27017 ", password: { secretRef: "s1" } },
      { connectionId: "a", hosts: "dup" },
      { connectionId: "b" },
      { hosts: "no-id" },
      "garbage",
      { connectionId: "c", hosts: "x", srv: true, tls: true, enabled: false, password: "plain-text-is-ignored" }
    ]);

    expect(parsed.map((c) => c.connectionId)).toEqual(["a", "c"]);
    expect(parsed[0]).toMatchObject({ hosts: "localhost:27017", srv: false, tls: false, enabled: true, password: { secretRef: "s1" } });
    expect(parsed[1]).toMatchObject({ srv: true, tls: true, enabled: false, password: undefined });
  });

  it("returns an empty list for non-arrays", () => {
    expect(parseConnections(undefined)).toEqual([]);
    expect(parseConnections({})).toEqual([]);
  });

  it("round-trips through serializeConnection without empty optional fields", () => {
    const [connection] = parseConnections([{ connectionId: "a", hosts: "h:1", title: "  ", username: "u", password: { secretRef: "s" } }]);
    const stored = serializeConnection(connection);

    expect(stored).toEqual({
      connectionId: "a",
      hosts: "h:1",
      srv: false,
      tls: false,
      tlsAllowInvalidCertificates: false,
      enabled: true,
      username: "u",
      password: { secretRef: "s" }
    });
    expect(parseConnections([stored])).toEqual([connection]);
  });
});

describe("validateConnection", () => {
  it("accepts host lists and SRV hosts", () => {
    expect(isValidConnection({ hosts: "a:27017,b:27018,c" })).toBe(true);
    expect(isValidConnection({ hosts: "cluster0.example.mongodb.net", srv: true })).toBe(true);
    expect(isValidConnection({ hosts: "h", options: "replicaSet=rs0&readPreference=secondary" })).toBe(true);
  });

  it("rejects bad hosts, SRV with ports, bad options and credentials in options", () => {
    expect(validateConnection({ hosts: "" }).hosts).toBeDefined();
    expect(validateConnection({ hosts: "mongodb://h" }).hosts).toBeDefined();
    expect(validateConnection({ hosts: "a:1,b:2", srv: true }).hosts).toBeDefined();
    expect(validateConnection({ hosts: "a:1", srv: true }).hosts).toBeDefined();
    expect(validateConnection({ hosts: "h", options: "a b=1" }).options).toBeDefined();
    expect(validateConnection({ hosts: "h", options: "novalue" }).options).toBeDefined();
    expect(validateConnection({ hosts: "h", options: "authSource=admin&password=x" }).options).toBeDefined();
    expect(validateConnection({ hosts: "h", tls: false, tlsAllowInvalidCertificates: true }).tlsAllowInvalidCertificates).toBeDefined();
  });
});

describe("connectionLabel", () => {
  it("prefers title, then hosts", () => {
    expect(connectionLabel({ connectionId: "id", title: "Prod", hosts: "h" })).toBe("Prod");
    expect(connectionLabel({ connectionId: "id", title: " ", hosts: "h" })).toBe("h");
  });
});
