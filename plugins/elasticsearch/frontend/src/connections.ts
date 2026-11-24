import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { SecretRefValue } from "@queryeer/api/security/Security";

export type AuthType = "NONE" | "BASIC";

export const AUTH_TYPES: readonly AuthType[] = ["NONE", "BASIC"];

/**
 * One connection as stored in the `com.queryeer.elasticsearch.connections` setting. The backend parses the same shape
 * (ElasticsearchConnectionSettings.parse); keep the two in sync. The fields of Queryeer's built-in connections keep
 * their names, so the migration copies them as they are.
 */
export type ElasticsearchConnection = {
  connectionId: string;
  title?: string;
  /** `https://host:9200`. */
  endpoint: string;
  authType: AuthType;
  /** With BASIC. */
  authUsername?: string;
  /** With BASIC: vault reference written by the host's PasswordFieldInput. */
  authPassword?: SecretRefValue;
  /** Accept any certificate and host name, e.g. a cluster with a self-signed certificate. */
  trustCertificate: boolean;
  /** Empty for payloadbuilder's default (500 ms). */
  connectTimeoutMs?: number;
  /** Empty for payloadbuilder's default (15 s). */
  receiveTimeoutMs?: number;
  enabled: boolean;
};

/** Parses the raw setting value. Entries without an ID or endpoint are skipped; the first entry wins for duplicate IDs. */
export function parseConnections(raw: unknown): ElasticsearchConnection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: ElasticsearchConnection[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const connection = parseConnection(entry);
    if (connection && !seen.has(connection.connectionId)) {
      seen.add(connection.connectionId);
      result.push(connection);
    }
  }
  return result;
}

/**
 * One entry, or undefined without an ID or endpoint. A password that isn't a vault reference is dropped: the plugin
 * never keeps one in settings.
 */
export function parseConnection(entry: unknown): ElasticsearchConnection | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const connectionId = text(entry.connectionId);
  const endpoint = text(entry.endpoint);
  if (!connectionId || !endpoint) {
    return undefined;
  }
  return {
    connectionId,
    title: text(entry.title),
    endpoint,
    authType: text(entry.authType)?.toUpperCase() === "BASIC" ? "BASIC" : "NONE",
    authUsername: text(entry.authUsername),
    authPassword: secretRef(entry.authPassword),
    trustCertificate: entry.trustCertificate === true,
    connectTimeoutMs: timeout(entry.connectTimeoutMs),
    receiveTimeoutMs: timeout(entry.receiveTimeoutMs),
    enabled: entry.enabled !== false
  };
}

/** Field-level problems with a connection, keyed by field name. Empty when valid. */
export function validateConnection(connection: Partial<ElasticsearchConnection>): Partial<Record<keyof ElasticsearchConnection, string>> {
  const errors: Partial<Record<keyof ElasticsearchConnection, string>> = {};
  const endpoint = connection.endpoint?.trim() ?? "";
  if (!endpoint) {
    errors.endpoint = "An endpoint is required";
  } else if (!/^https?:\/\/[^\s/?#]+(\/\S*)?$/.test(endpoint)) {
    errors.endpoint = "Use an http:// or https:// URL, e.g. https://localhost:9200";
  }
  if (connection.authType === "BASIC" && !connection.authUsername?.trim()) {
    errors.authUsername = "A username is required";
  }
  for (const key of ["connectTimeoutMs", "receiveTimeoutMs"] as const) {
    const value = connection[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      errors[key] = "Use a whole number of milliseconds, or leave it empty";
    }
  }
  return errors;
}

export function isValidConnection(connection: Partial<ElasticsearchConnection>): boolean {
  return Object.keys(validateConnection(connection)).length === 0;
}

export function connectionLabel(connection: Pick<ElasticsearchConnection, "connectionId" | "title" | "endpoint">): string {
  return connection.title?.trim() || connection.endpoint || connection.connectionId;
}

/** `context.settings.copySecrets`: a deep copy of a value in which every `{ secretRef }` has its own vault entry. */
export type CopySecrets = PluginContext["settings"]["copySecrets"];

/**
 * A copy with a new ID and its own copy of the password: a shared secretRef would let editing one row's password change
 * the other's.
 */
export async function cloneConnection(source: ElasticsearchConnection, copySecrets: CopySecrets): Promise<ElasticsearchConnection> {
  const copied = await copySecrets(source);
  return { ...copied, connectionId: crypto.randomUUID(), title: `${connectionLabel(source)} (copy)` };
}

/** Serialises for storage: omits empty optional fields, and credentials the auth type doesn't use. */
export function serializeConnection(connection: ElasticsearchConnection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    connectionId: connection.connectionId,
    endpoint: connection.endpoint.trim(),
    authType: connection.authType,
    enabled: connection.enabled
  };
  const title = connection.title?.trim();
  if (title) {
    out.title = title;
  }
  if (connection.authType === "BASIC") {
    const username = connection.authUsername?.trim();
    if (username) {
      out.authUsername = username;
    }
    if (connection.authPassword) {
      out.authPassword = connection.authPassword;
    }
  }
  if (connection.trustCertificate) {
    out.trustCertificate = true;
  }
  for (const key of ["connectTimeoutMs", "receiveTimeoutMs"] as const) {
    if (connection[key] !== undefined) {
      out[key] = connection[key];
    }
  }
  return out;
}

export function newConnection(): ElasticsearchConnection {
  return { connectionId: crypto.randomUUID(), endpoint: "http://localhost:9200", authType: "NONE", trustCertificate: false, enabled: true };
}

/** A timeout field's text as stored: its digits as a number, or undefined (the default) without any. */
export function parseTimeout(value: string): number | undefined {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : undefined;
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

function timeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
