import { useRef, useState, type ReactNode } from "react";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  AUTH_TYPES,
  cloneConnection,
  connectionLabel,
  newConnection,
  parseConnections,
  parseTimeout,
  serializeConnection,
  validateConnection,
  type AuthType,
  type CopySecrets,
  type ElasticsearchConnection
} from "./connections.js";

export type TestConnectionResult = { ok: true; clusterName?: string; version?: string } | { ok: false; message: string };

type Props = {
  value: unknown;
  readonly: boolean;
  setValue: (next: unknown) => void;
  /** Host components: CollectionSettingsListEditor, useCollectionSettingsPersistence and PasswordFieldInput. */
  components: PluginContext["components"];
  testConnection: (connection: Record<string, unknown>) => Promise<TestConnectionResult>;
  /** The host's `settings.copySecrets`, so a clone gets its own copy of the password. */
  copySecrets: CopySecrets;
};

const AUTH_LABELS: Record<AuthType, string> = { NONE: "None", BASIC: "Basic (username and password)" };

/** Elasticsearch connections in the host's list/detail settings editor, with plugin-rendered detail fields. */
export function ConnectionsSettingsEditor({ value, readonly, setValue, components, testConnection, copySecrets }: Props): JSX.Element {
  const { CollectionSettingsListEditor, PasswordFieldInput, useCollectionSettingsPersistence } = components;
  const [rows, setRows] = useState<ElasticsearchConnection[]>(() => parseConnections(value));
  const [selectedId, setSelectedId] = useState<string | undefined>(() => rows[0]?.connectionId);
  const [testState, setTestState] = useState<Record<string, { running: boolean; result?: TestConnectionResult }>>({});
  // The host hook also flushes a pending debounced save when the settings view unmounts
  const { persistNow, persistDebounced } = useCollectionSettingsPersistence<ElasticsearchConnection>({
    persist: (next) => setValue(next.map(serializeConnection))
  });

  // The latest rows, for changes that land after a re-render: a password field's async vault write, or a clone waiting
  // for its secrets to be copied. Building on `rows` there would drop rows added since.
  const rowsRef = useRef(rows);

  const commit = (next: ElasticsearchConnection[], debounce: boolean, nextSelectedId?: string): void => {
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

  const update = (connectionId: string, patch: Partial<ElasticsearchConnection>): void => {
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

  const runTest = async (row: ElasticsearchConnection): Promise<void> => {
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
      return <div className="qes-muted">Select or add a connection.</div>;
    }
    const errors = validateConnection(selected);
    const test = testState[selected.connectionId];
    return (
      <div className="qes-detail" role="group" aria-label="Elasticsearch connection details">
        <Field id="qes-title" label="Title (optional)">
          <input id="qes-title" className="qes-input" value={selected.title ?? ""} readOnly={readonly} placeholder="Production"
            onChange={(e) => update(selected.connectionId, { title: e.target.value })} />
        </Field>
        <Field id="qes-endpoint" label="Endpoint" error={errors.endpoint}>
          <input id="qes-endpoint" className="qes-input" value={selected.endpoint} readOnly={readonly} placeholder="https://localhost:9200"
            onChange={(e) => update(selected.connectionId, { endpoint: e.target.value })} />
        </Field>
        <Field id="qes-auth" label="Authentication">
          <select id="qes-auth" className="qes-input" value={selected.authType} disabled={readonly}
            onChange={(e) => update(selected.connectionId, { authType: e.target.value as AuthType })}>
            {AUTH_TYPES.map((authType) => <option key={authType} value={authType}>{AUTH_LABELS[authType]}</option>)}
          </select>
        </Field>
        {selected.authType === "BASIC" && (
          <>
            <Field id="qes-username" label="Username" error={errors.authUsername}>
              <input id="qes-username" className="qes-input" value={selected.authUsername ?? ""} readOnly={readonly} autoComplete="off"
                onChange={(e) => update(selected.connectionId, { authUsername: e.target.value })} />
            </Field>
            <Field id={`qes-password-${selected.connectionId}`} label="Password">
              <PasswordFieldInput inputId={`qes-password-${selected.connectionId}`} valueRef={selected.authPassword} readonly={readonly}
                onChangeRef={(authPassword) => update(selected.connectionId, { authPassword })} />
            </Field>
          </>
        )}
        <div className="qes-field">
          <label className="qes-check" htmlFor="qes-trust">
            <input id="qes-trust" type="checkbox" checked={selected.trustCertificate} disabled={readonly}
              onChange={(e) => update(selected.connectionId, { trustCertificate: e.target.checked })} />
            <span>Trust certificate</span>
          </label>
          <div className="qes-muted">Accepts any server certificate and host name, e.g. a self-signed one. Only for clusters you trust.</div>
        </div>
        <div className="qes-row">
          <Field id="qes-connect-timeout" label="Connect timeout (ms)" error={errors.connectTimeoutMs}>
            <input id="qes-connect-timeout" className="qes-input" inputMode="numeric" value={selected.connectTimeoutMs ?? ""} readOnly={readonly} placeholder="500"
              onChange={(e) => update(selected.connectionId, { connectTimeoutMs: parseTimeout(e.target.value) })} />
          </Field>
          <Field id="qes-receive-timeout" label="Read timeout (ms)" error={errors.receiveTimeoutMs}>
            <input id="qes-receive-timeout" className="qes-input" inputMode="numeric" value={selected.receiveTimeoutMs ?? ""} readOnly={readonly} placeholder="15000"
              onChange={(e) => update(selected.connectionId, { receiveTimeoutMs: parseTimeout(e.target.value) })} />
          </Field>
        </div>
        <div className="qes-field">
          <label className="qes-check" htmlFor="qes-enabled">
            <input id="qes-enabled" type="checkbox" checked={selected.enabled} disabled={readonly}
              onChange={(e) => update(selected.connectionId, { enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <div className="qes-test">
          <button type="button" className="qes-button" disabled={test?.running || Object.keys(errors).length > 0}
            onClick={() => void runTest(selected)}>
            {test?.running ? "Testing…" : "Test connection"}
          </button>
          {test?.result && (
            <span className={test.result.ok ? "qes-ok" : "qes-error"} role="status">
              {test.result.ok
                ? `Connected${test.result.clusterName ? ` to ${test.result.clusterName}` : ""}${test.result.version ? ` (Elasticsearch ${test.result.version})` : ""}`
                : test.result.message}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="qes-settings">
      <div className="qes-muted">Elasticsearch connections, used by the payloadbuilder <code>elasticsearch</code> catalog. Passwords are stored in the Queryeer vault, never in settings.</div>
      <CollectionSettingsListEditor
        items={rows.map((row) => ({
          id: row.connectionId,
          label: connectionLabel(row),
          subtitle: row.endpoint,
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
    <div className="qes-field">
      <label className="qes-label" htmlFor={id}>{label}</label>
      {children}
      {error && <div className="qes-error">{error}</div>}
    </div>
  );
}
