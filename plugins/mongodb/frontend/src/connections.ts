import type { SecretRefValue } from "@queryeer/api/security/Security";

/**
 * One connection as stored in the `com.queryeer.mongodb.connections` setting.
 * The backend parses the same shape (MongoConnectionSettings.parseList); keep the two in sync.
 */
export type MongoConnection = {
  connectionId: string;
  title?: string;
  /** `host[:port]`, comma-separated. One host without a port when `srv` is set. */
  hosts: string;
  srv: boolean;
  username?: string;
  /** Vault reference written by the host's PasswordFieldInput. */
  password?: SecretRefValue;
  authDatabase?: string;
  tls: boolean;
  tlsAllowInvalidCertificates: boolean;
  defaultDatabase?: string;
  /** Extra URI options, e.g. `replicaSet=rs0&readPreference=secondary`. */
  options?: string;
  enabled: boolean;
};

/** Parses the raw setting value. Entries without an ID or hosts are skipped; the first entry wins for duplicate IDs. */
export function parseConnections(raw: unknown): MongoConnection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: MongoConnection[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const connectionId = text(entry.connectionId);
    const hosts = text(entry.hosts);
    if (!connectionId || !hosts || seen.has(connectionId)) {
      continue;
    }
    seen.add(connectionId);
    result.push({
      connectionId,
      title: text(entry.title),
      hosts,
      srv: entry.srv === true,
      username: text(entry.username),
      password: secretRef(entry.password),
      authDatabase: text(entry.authDatabase),
      tls: entry.tls === true,
      tlsAllowInvalidCertificates: entry.tlsAllowInvalidCertificates === true,
      defaultDatabase: text(entry.defaultDatabase),
      options: text(entry.options),
      enabled: entry.enabled !== false
    });
  }
  return result;
}

/** Field-level problems with a connection, keyed by field name. Empty when valid. */
export function validateConnection(connection: Partial<MongoConnection>): Partial<Record<keyof MongoConnection, string>> {
  const errors: Partial<Record<keyof MongoConnection, string>> = {};
  const hosts = (connection.hosts ?? "").split(",").map((h) => h.trim()).filter(Boolean);

  if (hosts.length === 0) {
    errors.hosts = "At least one host is required";
  } else if (connection.srv) {
    if (hosts.length > 1 || hosts[0].includes(":")) {
      errors.hosts = "With SRV, enter a single host name without a port (e.g. cluster0.example.mongodb.net)";
    }
  } else {
    const invalid = hosts.find((h) => !/^[^\s:/?#@]+(:\d{1,5})?$/.test(h));
    if (invalid) {
      errors.hosts = `"${invalid}" is not a host or host:port`;
    }
  }

  const options = connection.options?.trim();
  if (options) {
    if (/[\s]/.test(options)) {
      errors.options = "Options must not contain spaces";
    } else if (options.split("&").some((pair) => !/^[A-Za-z0-9_.]+=[^&]*$/.test(pair.replace(/^\?/, "")))) {
      errors.options = "Use key=value pairs separated by &";
    } else if (/(^|&|\?)(password|user(name)?)=/i.test(options)) {
      errors.options = "Credentials belong in the username and password fields, not in options";
    }
  }

  if (connection.tlsAllowInvalidCertificates && !connection.tls) {
    errors.tlsAllowInvalidCertificates = "Only applies when TLS is enabled";
  }
  return errors;
}

export function isValidConnection(connection: Partial<MongoConnection>): boolean {
  return Object.keys(validateConnection(connection)).length === 0;
}

export function connectionLabel(connection: Pick<MongoConnection, "connectionId" | "title" | "hosts">): string {
  return connection.title?.trim() || connection.hosts || connection.connectionId;
}

/** Serialises for storage: omits empty optional fields so the stored JSON stays readable. */
export function serializeConnection(connection: MongoConnection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    connectionId: connection.connectionId,
    hosts: connection.hosts.trim(),
    srv: connection.srv,
    tls: connection.tls,
    tlsAllowInvalidCertificates: connection.tlsAllowInvalidCertificates,
    enabled: connection.enabled
  };
  for (const key of ["title", "username", "authDatabase", "defaultDatabase", "options"] as const) {
    const value = connection[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }
  if (connection.password) {
    out.password = connection.password;
  }
  return out;
}

export function newConnection(): MongoConnection {
  return {
    connectionId: crypto.randomUUID(),
    hosts: "localhost:27017",
    srv: false,
    authDatabase: "admin",
    tls: false,
    tlsAllowInvalidCertificates: false,
    enabled: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function secretRef(value: unknown): SecretRefValue | undefined {
  return isRecord(value) && typeof value.secretRef === "string" && value.secretRef ? { secretRef: value.secretRef } : undefined;
}
