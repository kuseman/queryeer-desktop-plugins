import { useRef, useState, type ReactNode } from "react";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  cloneConnection,
  connectionLabel,
  isSasl,
  newConnection,
  parseConnections,
  SASL_MECHANISMS,
  SECURITY_PROTOCOLS,
  serializeConnection,
  usesUsernamePassword,
  validateConnection,
  type CopySecrets,
  type KafkaConnection,
  type SaslMechanism,
  type SecurityProtocol
} from "./connections.js";

export type TestConnectionResult = { ok: true; clusterId?: string; brokers?: number } | { ok: false; message: string };

type Props = {
  value: unknown;
  readonly: boolean;
  setValue: (next: unknown) => void;
  /** Host components: CollectionSettingsListEditor, useCollectionSettingsPersistence and PasswordFieldInput. */
  components: PluginContext["components"];
  testConnection: (connection: Record<string, unknown>) => Promise<TestConnectionResult>;
  /** The host's `settings.copySecrets`, so a clone gets its own copy of the password. */
  copySecrets: CopySecrets | undefined;
};

/** Kafka connections in the host's list/detail settings editor, with plugin-rendered detail fields. */
export function ConnectionsSettingsEditor({ value, readonly, setValue, components, testConnection, copySecrets }: Props): JSX.Element {
  const { CollectionSettingsListEditor, PasswordFieldInput, useCollectionSettingsPersistence } = components;
  const [rows, setRows] = useState<KafkaConnection[]>(() => parseConnections(value));
  const [selectedId, setSelectedId] = useState<string | undefined>(() => rows[0]?.connectionId);
  const [testState, setTestState] = useState<Record<string, { running: boolean; result?: TestConnectionResult }>>({});
  // The host hook also flushes a pending debounced save when the settings view unmounts
  const { persistNow, persistDebounced } = useCollectionSettingsPersistence<KafkaConnection>({
    persist: (next) => setValue(next.map(serializeConnection))
  });

  // The latest rows, for changes that land after a re-render: a password field's async vault write, or a clone waiting
  // for its secrets to be copied. Building on `rows` there would drop rows added since.
  const rowsRef = useRef(rows);

  const commit = (next: KafkaConnection[], debounce: boolean, nextSelectedId?: string): void => {
    rowsRef.current = next;
    setRows(next);
    if (nextSelectedId !== undefined) {
      setSelectedId(nextSelectedId);
    }
    if (debounce) {
      persistDebounced(next);
    } else {
      persistNow(next);
    }
  };

  const update = (connectionId: string, patch: Partial<KafkaConnection>): void => {
    commit(rowsRef.current.map((row) => (row.connectionId === connectionId ? { ...row, ...patch } : row)), true);
    setTestState((state) => ({ ...state, [connectionId]: { running: false } }));
  };

  const add = (): void => {
    const row = newConnection();
    commit([...rowsRef.current, row], false, row.connectionId);
  };

  const clone = async (connectionId: string): Promise<void> => {
    const source = rowsRef.current.find((row) => row.connectionId === connectionId);
    if (source) {
      const copy = await cloneConnection(source, copySecrets);
      commit([...rowsRef.current, copy], false, copy.connectionId);
    }
  };

  const remove = (connectionId: string): void => {
    const current = rowsRef.current;
    const index = current.findIndex((row) => row.connectionId === connectionId);
    const next = current.filter((row) => row.connectionId !== connectionId);
    commit(next, false, next[index]?.connectionId ?? next[index - 1]?.connectionId ?? "");
  };

  const runTest = async (row: KafkaConnection): Promise<void> => {
    persistNow(rows);
    setTestState((state) => ({ ...state, [row.connectionId]: { running: true } }));
    let result: TestConnectionResult;
    try {
      result = await testConnection(serializeConnection(row));
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    setTestState((state) => ({ ...state, [row.connectionId]: { running: false, result } }));
  };

  const renderDetails = (id: string | undefined): ReactNode => {
    const selected = rows.find((row) => row.connectionId === id);
    if (!selected) {
      return <div className="qkafka-muted">Select or add a connection.</div>;
    }
    const errors = validateConnection(selected);
    const test = testState[selected.connectionId];
    const sasl = isSasl(selected);
    const usernamePassword = sasl && usesUsernamePassword(selected.saslMechanism);
    const jaas = sasl && selected.saslMechanism !== undefined && !usernamePassword;
    return (
      <div className="qkafka-detail" role="group" aria-label="Kafka connection details">
        <Field id="qkafka-title" label="Title (optional)">
          <input id="qkafka-title" className="qkafka-input" value={selected.title ?? ""} readOnly={readonly} placeholder="Production"
            onChange={(e) => update(selected.connectionId, { title: e.target.value })} />
        </Field>
        <Field id="qkafka-bootstrap" label="Bootstrap servers" error={errors.bootstrapServers}>
          <input id="qkafka-bootstrap" className="qkafka-input" value={selected.bootstrapServers} readOnly={readonly} placeholder="broker1:9092,broker2:9092"
            onChange={(e) => update(selected.connectionId, { bootstrapServers: e.target.value })} />
        </Field>
        <Field id="qkafka-protocol" label="Security protocol">
          <select id="qkafka-protocol" className="qkafka-input" value={selected.securityProtocol} disabled={readonly}
            onChange={(e) => update(selected.connectionId, { securityProtocol: e.target.value as SecurityProtocol })}>
            {SECURITY_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
        </Field>
        {sasl && (
          <Field id="qkafka-mechanism" label="SASL mechanism" error={errors.saslMechanism}>
            <select id="qkafka-mechanism" className="qkafka-input" value={selected.saslMechanism ?? ""} disabled={readonly}
              onChange={(e) => update(selected.connectionId, { saslMechanism: (e.target.value || undefined) as SaslMechanism | undefined })}>
              <option value="">Select mechanism</option>
              {SASL_MECHANISMS.map((mechanism) => <option key={mechanism} value={mechanism}>{mechanism}</option>)}
            </select>
          </Field>
        )}
        {usernamePassword && (
          <>
            <Field id="qkafka-username" label="Username" error={errors.username}>
              <input id="qkafka-username" className="qkafka-input" value={selected.username ?? ""} readOnly={readonly} autoComplete="off"
                onChange={(e) => update(selected.connectionId, { username: e.target.value })} />
            </Field>
            <Field id={`qkafka-password-${selected.connectionId}`} label="Password">
              <PasswordFieldInput inputId={`qkafka-password-${selected.connectionId}`} valueRef={selected.password} readonly={readonly}
                onChangeRef={(password) => update(selected.connectionId, { password })} />
            </Field>
          </>
        )}
        {jaas && (
          <Field id={`qkafka-jaas-${selected.connectionId}`} label={selected.saslMechanism === "GSSAPI" ? "JAAS configuration (optional)" : "JAAS configuration"} error={errors.saslJaasConfig}>
            <PasswordFieldInput inputId={`qkafka-jaas-${selected.connectionId}`} valueRef={selected.saslJaasConfig} readonly={readonly}
              onChangeRef={(saslJaasConfig) => update(selected.connectionId, { saslJaasConfig })} />
            <div className="qkafka-muted">The whole <code>sasl.jaas.config</code> value, kept in the vault.</div>
          </Field>
        )}
        <Field id="qkafka-registry" label="Schema registry URL (optional)" error={errors.schemaRegistryUrl}>
          <input id="qkafka-registry" className="qkafka-input" value={selected.schemaRegistryUrl ?? ""} readOnly={readonly} placeholder="http://localhost:8081"
            onChange={(e) => update(selected.connectionId, { schemaRegistryUrl: e.target.value })} />
        </Field>
        <div className="qkafka-field">
          <label className="qkafka-check" htmlFor="qkafka-enabled">
            <input id="qkafka-enabled" type="checkbox" checked={selected.enabled} disabled={readonly}
              onChange={(e) => update(selected.connectionId, { enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <div className="qkafka-test">
          <button type="button" className="qkafka-button" disabled={test?.running || Object.keys(errors).length > 0}
            onClick={() => void runTest(selected)}>
            {test?.running ? "Testing…" : "Test connection"}
          </button>
          {test?.result && (
            <span className={test.result.ok ? "qkafka-ok" : "qkafka-error"} role="status">
              {test.result.ok
                ? `Connected (${test.result.brokers ?? "?"} broker${test.result.brokers === 1 ? "" : "s"}${test.result.clusterId ? `, cluster ${test.result.clusterId}` : ""})`
                : test.result.message}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="qkafka-settings">
      <div className="qkafka-muted">Kafka connections, used by the payloadbuilder <code>kafka</code> catalog. Passwords and JAAS configurations are stored in the Queryeer vault, never in settings.</div>
      <CollectionSettingsListEditor
        items={rows.map((row) => ({
          id: row.connectionId,
          label: connectionLabel(row),
          subtitle: row.bootstrapServers,
          invalid: Object.keys(validateConnection(row)).length > 0
        }))}
        selectedId={selectedId}
        readonly={readonly}
        addLabel="Add Connection"
        onSelect={setSelectedId}
        onAdd={add}
        onClone={clone}
        onDelete={remove}
        renderDetails={renderDetails}
      />
    </div>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="qkafka-field">
      <label className="qkafka-label" htmlFor={id}>{label}</label>
      {children}
      {error && <div className="qkafka-error">{error}</div>}
    </div>
  );
}
