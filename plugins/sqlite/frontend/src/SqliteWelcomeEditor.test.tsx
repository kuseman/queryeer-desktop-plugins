// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteWelcomeEditorProps } from "./SqliteWelcomeEditor.js";
import { databaseName, findSqliteConnection, JDBC_CONNECTIONS_SETTING_ID, SqliteWelcomeEditor } from "./SqliteWelcomeEditor.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_PATH = "C:\\data\\shop.db";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setup(connections: unknown, setValueResult: { ok: true } | { ok: false; message: string } = { ok: true }) {
  const settings = {
    getValue: vi.fn(() => connections),
    setValue: vi.fn(async () => setValueResult)
  };
  const fileMediator = {
    createUntitledFile: vi.fn(async () => ({ fileId: "query-1" })),
    bindEngine: vi.fn(async () => undefined),
    closeFile: vi.fn(async () => undefined)
  };
  const props = { fileId: "db-1", filePath: FILE_PATH, settings, fileMediator } as unknown as SqliteWelcomeEditorProps;
  return { settings, fileMediator, props };
}

async function render(props: SqliteWelcomeEditorProps): Promise<void> {
  await act(async () => {
    root.render(<SqliteWelcomeEditor {...props} />);
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  if (!match) {
    throw new Error(`No button ${label}`);
  }
  return match;
}

describe("SqliteWelcomeEditor", () => {
  it("opens a query file bound to the file's existing connection and closes the database tab", async () => {
    const { fileMediator, settings, props } = setup([
      { connectionId: "other", dialectId: "sqlite", properties: { filePath: "C:\\data\\other.db" }, enabled: true },
      { connectionId: "shop", dialectId: "sqlite", properties: { filePath: FILE_PATH }, enabled: true }
    ]);

    await render(props);

    expect(settings.getValue).toHaveBeenCalledWith(JDBC_CONNECTIONS_SETTING_ID);
    expect(fileMediator.createUntitledFile).toHaveBeenCalledWith({ mimeType: "application/sql", extension: "sql", title: "shop" });
    expect(fileMediator.bindEngine).toHaveBeenCalledWith("query-1", "jdbc", "shop");
    expect(fileMediator.closeFile).toHaveBeenCalledWith("db-1");
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it("creates a connection to the file, keeping the others as they are, then opens a query file for it", async () => {
    const other = { connectionId: "pg", dialectId: "postgres", properties: { host: "db" }, enabled: true, color: "#ff0000" };
    const { fileMediator, settings, props } = setup([other]);
    await render(props);
    expect(fileMediator.createUntitledFile).not.toHaveBeenCalled();

    await act(async () => button("Create Database Connection").click());

    const [[settingId, saved]] = settings.setValue.mock.calls as unknown as [[string, Array<Record<string, unknown>>]];
    expect(settingId).toBe(JDBC_CONNECTIONS_SETTING_ID);
    expect(saved[0]).toBe(other);
    expect(saved[1]).toMatchObject({ title: "shop (SQLite)", dialectId: "sqlite", properties: { filePath: FILE_PATH }, enabled: true });
    expect(fileMediator.bindEngine).toHaveBeenCalledWith("query-1", "jdbc", saved[1].connectionId);
    expect(fileMediator.closeFile).toHaveBeenCalledWith("db-1");
  });

  it("shows why the connection could not be saved and opens nothing", async () => {
    const { fileMediator, props } = setup(undefined, { ok: false, message: "Vault is locked" });
    await render(props);

    await act(async () => button("Create Database Connection").click());

    expect(container.querySelector("[role=alert]")?.textContent).toContain("Vault is locked");
    expect(fileMediator.createUntitledFile).not.toHaveBeenCalled();
    expect(button("Create Database Connection").disabled).toBe(false);
  });

  it("closes the database tab on Cancel", async () => {
    const { fileMediator, props } = setup([]);
    await render(props);

    await act(async () => button("Cancel").click());

    expect(fileMediator.closeFile).toHaveBeenCalledWith("db-1");
    expect(fileMediator.createUntitledFile).not.toHaveBeenCalled();
  });
});

describe("findSqliteConnection", () => {
  it("matches an enabled SQLite connection by file path only", () => {
    expect(findSqliteConnection([
      { connectionId: "off", dialectId: "sqlite", properties: { filePath: FILE_PATH }, enabled: false },
      { connectionId: "pg", dialectId: "postgres", properties: { filePath: FILE_PATH } },
      { connectionId: "on", dialectId: "sqlite", properties: { filePath: FILE_PATH } }
    ], FILE_PATH)).toBe("on");
    expect(findSqliteConnection(undefined, FILE_PATH)).toBeUndefined();
    expect(findSqliteConnection([null, "x"], FILE_PATH)).toBeUndefined();
  });
});

describe("databaseName", () => {
  it("is the file name without folder and extension", () => {
    expect(databaseName("C:\\data\\shop.db")).toBe("shop");
    expect(databaseName("/home/me/my.data.sqlite3")).toBe("my.data");
    expect(databaseName("/home/me/plain")).toBe("plain");
  });
});
