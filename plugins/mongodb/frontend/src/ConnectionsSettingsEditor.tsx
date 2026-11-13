import { useState, type ReactNode } from "react";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import {
  connectionLabel,
  newConnection,
  parseConnections,
  serializeConnection,
  validateConnection,
  type MongoConnection
} from "./connections.js";

export type TestConnectionResult = { ok: true; version: string } | { ok: false; message: string };

type Props = {
  value: unknown;
  readonly: boolean;
  setValue: (next: unknown) => void;
  /** Host components: CollectionSettingsListEditor, useCollectionSettingsPersistence and PasswordFieldInput. */
  components: PluginContext["components"];
  testConnection: (connection: Record<string, unknown>) => Promise<TestConnectionResult>;
};

/** MongoDB connections in the host's list/detail settings editor, with plugin-rendered detail fields. */
export function ConnectionsSettingsEditor({ value, readonly, setValue, components, testConnection }: Props): JSX.Element {
  const { CollectionSettingsListEditor, PasswordFieldInput, useCollectionSettingsPersistence } = components;
  const [rows, setRows] = useState<MongoConnection[]>(() => parseConnections(value));
  const [selectedId, setSelectedId] = useState<string | undefined>(() => rows[0]?.connectionId);
  const [testState, setTestState] = useState<Record<string, { running: boolean; result?: TestConnectionResult }>>({});
  // The host hook also flushes a pending debounced save when the settings view unmounts
  const { persistNow, persistDebounced } = useCollectionSettingsPersistence<MongoConnection>({
    persist: (next) => setValue(next.map(serializeConnection))
  });

  const commit = (next: MongoConnection[], debounce: boolean, nextSelectedId?: string): void => {
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

  const update = (connectionId: string, patch: Partial<MongoConnection>): void => {
    commit(rows.map((row) => (row.connectionId === connectionId ? { ...row, ...patch } : row)), true);
    setTestState((state) => ({ ...state, [connectionId]: { running: false } }));
  };

  const add = (): void => {
    const row = newConnection();
    commit([...rows, row], false, row.connectionId);
  };

  const clone = (connectionId: string): void => {
    const source = rows.find((row) => row.connectionId === connectionId);
    if (source) {
      const copy: MongoConnection = { ...source, connectionId: crypto.randomUUID(), title: `${connectionLabel(source)} (copy)` };
      commit([...rows, copy], false, copy.connectionId);
    }
  };

  const remove = (connectionId: string): void => {
    const index = rows.findIndex((row) => row.connectionId === connectionId);
    const next = rows.filter((row) => row.connectionId !== connectionId);
    commit(next, false, next[index]?.connectionId ?? next[index - 1]?.connectionId ?? "");
  };

  const runTest = async (row: MongoConnection): Promise<void> => {
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
      return <div className="qmongo-muted">Select or add a connection.</div>;
    }
    const errors = validateConnection(selected);
    const test = testState[selected.connectionId];
    return (
      <div className="qmongo-detail" role="group" aria-label="MongoDB connection details">
        <Field id="qmongo-title" label="Title (optional)">
          <input id="qmongo-title" className="qmongo-input" value={selected.title ?? ""} readOnly={readonly} placeholder="Production"
            onChange={(e) => update(selected.connectionId, { title: e.target.value })} />
        </Field>
        <Field id="qmongo-hosts" label={selected.srv ? "SRV host" : "Hosts"} error={errors.hosts}>
          <input id="qmongo-hosts" className="qmongo-input" value={selected.hosts} readOnly={readonly}
            placeholder={selected.srv ? "cluster0.example.mongodb.net" : "host1:27017,host2:27017"}
            onChange={(e) => update(selected.connectionId, { hosts: e.target.value })} />
        </Field>
        <Check id="qmongo-srv" label="Use DNS seed list (mongodb+srv://)" checked={selected.srv} readonly={readonly}
          onChange={(srv) => update(selected.connectionId, { srv, tls: srv ? true : selected.tls })} />
        <Field id="qmongo-username" label="Username (optional)">
          <input id="qmongo-username" className="qmongo-input" value={selected.username ?? ""} readOnly={readonly} autoComplete="off"
            onChange={(e) => update(selected.connectionId, { username: e.target.value })} />
        </Field>
        <Field id={`qmongo-password-${selected.connectionId}`} label="Password">
          <PasswordFieldInput inputId={`qmongo-password-${selected.connectionId}`} valueRef={selected.password} readonly={readonly}
            onChangeRef={(password) => update(selected.connectionId, { password })} />
        </Field>
        <Field id="qmongo-auth-db" label="Authentication database">
          <input id="qmongo-auth-db" className="qmongo-input" value={selected.authDatabase ?? ""} readOnly={readonly} placeholder="admin"
            onChange={(e) => update(selected.connectionId, { authDatabase: e.target.value })} />
        </Field>
        <Check id="qmongo-tls" label="TLS" checked={selected.tls} readonly={readonly}
          onChange={(tls) => update(selected.connectionId, { tls, tlsAllowInvalidCertificates: tls ? selected.tlsAllowInvalidCertificates : false })} />
        <Check id="qmongo-tls-invalid" label="Allow invalid certificates (insecure)" checked={selected.tlsAllowInvalidCertificates}
          readonly={readonly || !selected.tls} error={errors.tlsAllowInvalidCertificates}
          onChange={(tlsAllowInvalidCertificates) => update(selected.connectionId, { tlsAllowInvalidCertificates })} />
        <Field id="qmongo-default-db" label="Default database (optional)">
          <input id="qmongo-default-db" className="qmongo-input" value={selected.defaultDatabase ?? ""} readOnly={readonly} placeholder="Used when a file has no database selected"
            onChange={(e) => update(selected.connectionId, { defaultDatabase: e.target.value })} />
        </Field>
        <Field id="qmongo-options" label="Extra URI options (optional)" error={errors.options}>
          <input id="qmongo-options" className="qmongo-input" value={selected.options ?? ""} readOnly={readonly} placeholder="replicaSet=rs0&readPreference=secondary"
            onChange={(e) => update(selected.connectionId, { options: e.target.value })} />
        </Field>
        <Check id="qmongo-enabled" label="Enabled" checked={selected.enabled} readonly={readonly}
          onChange={(enabled) => update(selected.connectionId, { enabled })} />
        <div className="qmongo-test">
          <button type="button" className="qmongo-button" disabled={test?.running || Object.keys(errors).length > 0}
            onClick={() => void runTest(selected)}>
            {test?.running ? "Testing…" : "Test connection"}
          </button>
          {test?.result && (
            <span className={test.result.ok ? "qmongo-ok" : "qmongo-error"}>
              {test.result.ok ? `Connected (MongoDB ${test.result.version})` : test.result.message}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="qmongo-settings">
      <div className="qmongo-muted">
        Connections used by MongoDB query files (<code>.mongo</code>). Passwords are stored in the Queryeer vault, never in settings.
      </div>
      <CollectionSettingsListEditor
        items={rows.map((row) => ({
          id: row.connectionId,
          label: connectionLabel(row),
          subtitle: row.srv ? `mongodb+srv://${row.hosts}` : row.hosts,
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
    <div className="qmongo-field">
      <label className="qmongo-label" htmlFor={id}>{label}</label>
      {children}
      {error && <div className="qmongo-error">{error}</div>}
    </div>
  );
}

function Check({ id, label, checked, readonly, error, onChange }: {
  id: string;
  label: string;
  checked: boolean;
  readonly: boolean;
  error?: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="qmongo-field">
      <label className="qmongo-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} disabled={readonly} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {error && <div className="qmongo-error">{error}</div>}
    </div>
  );
}
