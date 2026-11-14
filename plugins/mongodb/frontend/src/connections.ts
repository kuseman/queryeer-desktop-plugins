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
  /** `#rrggbb`, shown on the connection's tabs and status label (frontend only; the backend ignores it). */
  color?: string;
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
      enabled: entry.enabled !== false,
      color: color(entry.color)
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

/**
 * What decides where a connection connects to and as whom: everything but its title and color. Cached server data (database lists,
 * collections, field samples) only needs to be dropped when this changes.
 */
export function connectionFingerprint(raw: unknown): string {
  return JSON.stringify(parseConnections(raw).map(({ title: _title, color: _color, ...rest }) => serializeConnection({ ...rest, title: undefined, color: undefined })));
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
  for (const key of ["title", "username", "authDatabase", "defaultDatabase", "options", "color"] as const) {
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

function color(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

/** What a pasted connection string fills in. The password is never part of it: it has to be typed into the vault-backed field. */
export type ParsedConnectionString = {
  fields: Pick<MongoConnection, "hosts" | "srv" | "tls" | "tlsAllowInvalidCertificates"> &
    Partial<Pick<MongoConnection, "username" | "authDatabase" | "defaultDatabase" | "options">>;
  /** The string held a password, which was left out. */
  hadPassword: boolean;
};

/** Options mapped to their own fields instead of being kept as extra URI options. */
const MAPPED_OPTIONS = ["authsource", "tls", "ssl", "tlsallowinvalidcertificates", "sslallowinvalidcertificates", "tlsinsecure"];

/**
 * Reads a `mongodb://` or `mongodb+srv://` connection string into connection fields. The authentication database follows the
 * driver's rules: `authSource`, else the database in the path, else `admin`. SRV turns TLS on unless the string turns it off.
 */
export function parseConnectionString(input: string): ParsedConnectionString | { error: string } {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:([^@/?#]*)@)?([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(input.trim());
  if (!match) {
    return { error: "Not a MongoDB connection string (mongodb://… or mongodb+srv://…)" };
  }
  const [, scheme, userInfo, hosts, path, query] = match;
  const srv = scheme === "mongodb+srv";
  let username: string | undefined;
  let hadPassword = false;
  try {
    if (userInfo !== undefined) {
      const colon = userInfo.indexOf(":");
      username = decodeURIComponent(colon < 0 ? userInfo : userInfo.slice(0, colon)) || undefined;
      hadPassword = colon >= 0 && userInfo.length > colon + 1;
    }
    const database = path ? decodeURIComponent(path) || undefined : undefined;
    const params: Array<[string, string]> = [];
    new URLSearchParams(query ?? "").forEach((value, key) => params.push([key, value]));
    const lower = new Map(params.map(([key, value]) => [key.toLowerCase(), value]));
    const flag = (...keys: string[]): boolean | undefined => {
      const value = keys.map((key) => lower.get(key)).find((v) => v !== undefined);
      return value === undefined ? undefined : value.toLowerCase() === "true";
    };
    const extra = params.filter(([key]) => !MAPPED_OPTIONS.includes(key.toLowerCase()))
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    const tls = flag("tls", "ssl") ?? srv;
    return {
      fields: {
        hosts: decodeURIComponent(hosts),
        srv,
        tls,
        tlsAllowInvalidCertificates: tls && (flag("tlsallowinvalidcertificates", "sslallowinvalidcertificates", "tlsinsecure") ?? false),
        username,
        authDatabase: lower.get("authsource") || (username ? database ?? "admin" : undefined),
        defaultDatabase: database,
        options: extra || undefined
      },
      hadPassword
    };
  } catch {
    return { error: "The connection string has invalid %-escapes" };
  }
}

function secretRef(value: unknown): SecretRefValue | undefined {
  return isRecord(value) && typeof value.secretRef === "string" && value.secretRef ? { secretRef: value.secretRef } : undefined;
}
