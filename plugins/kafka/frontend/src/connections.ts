import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { SecretRefValue } from "@queryeer/api/security/Security";

export type SecurityProtocol = "PLAINTEXT" | "SSL" | "SASL_PLAINTEXT" | "SASL_SSL";
export type SaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512" | "OAUTHBEARER" | "GSSAPI";

export const SECURITY_PROTOCOLS: readonly SecurityProtocol[] = ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"];
export const SASL_MECHANISMS: readonly SaslMechanism[] = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER", "GSSAPI"];

/**
 * One connection as stored in the `com.queryeer.kafka.connections` setting.
 * The backend parses the same shape (KafkaConnectionSettings.parse); keep the two in sync.
 */
export type KafkaConnection = {
  connectionId: string;
  title?: string;
  /** `host:port`, comma-separated. */
  bootstrapServers: string;
  securityProtocol: SecurityProtocol;
  /** With a SASL protocol. */
  saslMechanism?: SaslMechanism;
  /** For PLAIN and SCRAM. */
  username?: string;
  /** For PLAIN and SCRAM: vault reference written by the host's PasswordFieldInput. */
  password?: SecretRefValue;
  /** For OAUTHBEARER and GSSAPI: the whole JAAS configuration, kept in the vault as it may hold credentials. */
  saslJaasConfig?: SecretRefValue;
  schemaRegistryUrl?: string;
  enabled: boolean;
};

/** Parses the raw setting value. Entries without an ID or bootstrap servers are skipped; the first entry wins for duplicate IDs. */
export function parseConnections(raw: unknown): KafkaConnection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: KafkaConnection[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const connectionId = text(entry.connectionId);
    const bootstrapServers = text(entry.bootstrapServers);
    if (!connectionId || !bootstrapServers || seen.has(connectionId)) {
      continue;
    }
    seen.add(connectionId);
    const protocol = text(entry.securityProtocol)?.toUpperCase() as SecurityProtocol | undefined;
    const mechanism = text(entry.saslMechanism)?.toUpperCase() as SaslMechanism | undefined;
    result.push({
      connectionId,
      title: text(entry.title),
      bootstrapServers,
      securityProtocol: protocol && SECURITY_PROTOCOLS.includes(protocol) ? protocol : "PLAINTEXT",
      saslMechanism: mechanism && SASL_MECHANISMS.includes(mechanism) ? mechanism : undefined,
      username: text(entry.username),
      password: secretRef(entry.password),
      saslJaasConfig: secretRef(entry.saslJaasConfig),
      schemaRegistryUrl: text(entry.schemaRegistryUrl),
      enabled: entry.enabled !== false
    });
  }
  return result;
}

export function isSasl(connection: Pick<KafkaConnection, "securityProtocol">): boolean {
  return connection.securityProtocol.startsWith("SASL_");
}

/** PLAIN and SCRAM take a username and password; the plugin builds their JAAS configuration. */
export function usesUsernamePassword(mechanism: SaslMechanism | undefined): boolean {
  return mechanism === "PLAIN" || mechanism === "SCRAM-SHA-256" || mechanism === "SCRAM-SHA-512";
}

/** Field-level problems with a connection, keyed by field name. Empty when valid. */
export function validateConnection(connection: Partial<KafkaConnection>): Partial<Record<keyof KafkaConnection, string>> {
  const errors: Partial<Record<keyof KafkaConnection, string>> = {};
  const servers = (connection.bootstrapServers ?? "").split(",").map((server) => server.trim()).filter(Boolean);
  if (servers.length === 0) {
    errors.bootstrapServers = "At least one bootstrap server is required";
  } else {
    const invalid = servers.find((server) => !/^[^\s:/?#@]+:\d{1,5}$/.test(server));
    if (invalid) {
      errors.bootstrapServers = `"${invalid}" is not a host:port`;
    }
  }
  if (connection.securityProtocol && isSasl({ securityProtocol: connection.securityProtocol })) {
    if (!connection.saslMechanism) {
      errors.saslMechanism = "Pick the SASL mechanism";
    } else if (usesUsernamePassword(connection.saslMechanism)) {
      if (!connection.username?.trim()) {
        errors.username = "A username is required";
      }
    } else if (connection.saslMechanism === "OAUTHBEARER" && !connection.saslJaasConfig) {
      errors.saslJaasConfig = "OAUTHBEARER needs a JAAS configuration";
    }
  }
  const registry = connection.schemaRegistryUrl?.trim();
  if (registry && !/^https?:\/\/\S+$/.test(registry)) {
    errors.schemaRegistryUrl = "Use an http:// or https:// URL";
  }
  return errors;
}

export function isValidConnection(connection: Partial<KafkaConnection>): boolean {
  return Object.keys(validateConnection(connection)).length === 0;
}

export function connectionLabel(connection: Pick<KafkaConnection, "connectionId" | "title" | "bootstrapServers">): string {
  return connection.title?.trim() || connection.bootstrapServers || connection.connectionId;
}

/** `context.settings.copySecrets`: a deep copy of a value in which every `{ secretRef }` has its own vault entry. */
export type CopySecrets = <T>(value: T) => Promise<T>;

// copySecrets is PluginContext.settings in @queryeer/api 0.23, which isn't on npm yet; read it from there once the
// plugin builds against 0.23
export function hostCopySecrets(settings: PluginContext["settings"]): CopySecrets | undefined {
  return (settings as PluginContext["settings"] & { copySecrets?: CopySecrets }).copySecrets?.bind(settings);
}

/**
 * A copy with a new ID and its own copy of every secret: a shared secretRef would let editing one row's password change
 * the other's. Without `copySecrets` (Queryeer before 0.23), the copy has no secrets.
 */
export async function cloneConnection(source: KafkaConnection, copySecrets: CopySecrets | undefined): Promise<KafkaConnection> {
  const copied = copySecrets ? await copySecrets(source) : { ...source, password: undefined, saslJaasConfig: undefined };
  return { ...copied, connectionId: crypto.randomUUID(), title: `${connectionLabel(source)} (copy)` };
}

/** Serialises for storage: omits empty optional fields, and credentials the security settings don't use. */
export function serializeConnection(connection: KafkaConnection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    connectionId: connection.connectionId,
    bootstrapServers: connection.bootstrapServers.trim(),
    securityProtocol: connection.securityProtocol,
    enabled: connection.enabled
  };
  for (const key of ["title", "schemaRegistryUrl"] as const) {
    const value = connection[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }
  if (isSasl(connection) && connection.saslMechanism) {
    out.saslMechanism = connection.saslMechanism;
    if (usesUsernamePassword(connection.saslMechanism)) {
      const username = connection.username?.trim();
      if (username) {
        out.username = username;
      }
      if (connection.password) {
        out.password = connection.password;
      }
    } else if (connection.saslJaasConfig) {
      out.saslJaasConfig = connection.saslJaasConfig;
    }
  }
  return out;
}

export function newConnection(): KafkaConnection {
  return { connectionId: crypto.randomUUID(), bootstrapServers: "localhost:9092", securityProtocol: "PLAINTEXT", enabled: true };
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
