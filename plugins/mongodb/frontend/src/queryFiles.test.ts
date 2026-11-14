import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { isReuseClick, openQueryFile, replaceInActiveQuery, runGeneratedQuery } from "./queryFiles.js";
import { DATABASE_STATE_KEY, MIME_TYPE } from "./constants.js";

function fakeContext(active: { mimeType: string; connectionId?: string } | undefined, executed = true) {
  const setContent = vi.fn();
  const context = {
    editors: {
      getActiveEditor: () => (active ? { editorId: "e1", fileId: "f1", content: { getContent: () => "old", setContent } } : null),
      onActiveEditorChanged: vi.fn(() => ({ dispose: vi.fn() }))
    },
    files: {
      getFile: () =>
        active
          ? { fileId: "f1", mimeType: active.mimeType, engineBinding: active.connectionId ? { engineId: "mongodb", connectionId: active.connectionId } : undefined }
          : undefined,
      setEditorState: vi.fn()
    },
    fileMediator: {
      bindEngine: vi.fn(async () => undefined),
      createUntitledFile: vi.fn(async () => ({ fileId: "new" }))
    },
    queryEngines: { execute: vi.fn() },
    commands: { executeCommand: vi.fn(async () => ({ commandId: "core.queryengine.execute", executed, reason: executed ? undefined : "disabled" })) },
    notifications: { notify: vi.fn() }
  };
  return { context: context as unknown as PluginContext, mocks: context, setContent };
}

const options = { title: "orders (Browse)", text: "{ \"find\": \"orders\" }\n", connectionId: "prod", database: "shop", execute: true };

describe("replaceInActiveQuery", () => {
  it("replaces the active MongoDB tab, binds it to the target and runs it", async () => {
    const { context, mocks, setContent } = fakeContext({ mimeType: MIME_TYPE, connectionId: "dev" });

    expect(await replaceInActiveQuery(context, options)).toBe(true);

    expect(mocks.fileMediator.bindEngine).toHaveBeenCalledWith("f1", "mongodb", "prod");
    expect(mocks.files.setEditorState).toHaveBeenCalledWith("f1", DATABASE_STATE_KEY, { connectionId: "prod", database: "shop" });
    expect(setContent).toHaveBeenCalledWith(options.text);
    expect(mocks.commands.executeCommand).toHaveBeenCalledWith("core.queryengine.execute");
    expect(mocks.fileMediator.createUntitledFile).not.toHaveBeenCalled();
  });

  it("does not rebind when the tab already uses the target connection", async () => {
    const { context, mocks } = fakeContext({ mimeType: MIME_TYPE, connectionId: "prod" });
    await replaceInActiveQuery(context, options);
    expect(mocks.fileMediator.bindEngine).not.toHaveBeenCalled();
  });

  it("refuses non-MongoDB tabs and missing editors", async () => {
    expect(await replaceInActiveQuery(fakeContext({ mimeType: "application/sql" }).context, options)).toBe(false);
    expect(await replaceInActiveQuery(fakeContext(undefined).context, options)).toBe(false);
  });

  it("tells the user when the replaced query could not run", async () => {
    const { context, mocks } = fakeContext({ mimeType: MIME_TYPE, connectionId: "prod" }, false);
    await replaceInActiveQuery(context, options);
    expect(mocks.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
  });
});

describe("openQueryFile", () => {
  it("creates the tab with the query as its content, binds it, then runs that file", async () => {
    const { context, mocks } = fakeContext(undefined);
    await openQueryFile(context, options);

    expect(mocks.fileMediator.createUntitledFile).toHaveBeenCalledWith(expect.objectContaining({ mimeType: MIME_TYPE, initialContent: options.text }));
    expect(mocks.fileMediator.bindEngine).toHaveBeenCalledWith("new", "mongodb", "prod");
    expect(mocks.files.setEditorState).toHaveBeenCalledWith("new", DATABASE_STATE_KEY, { connectionId: "prod", database: "shop" });
    expect(mocks.queryEngines.execute).toHaveBeenCalledWith({ fileId: "new", text: options.text });
    expect(mocks.fileMediator.bindEngine.mock.invocationCallOrder[0]).toBeLessThan(mocks.queryEngines.execute.mock.invocationCallOrder[0]);
    expect(mocks.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("does not run when only opening", async () => {
    const { context, mocks } = fakeContext(undefined);
    await openQueryFile(context, { ...options, execute: false });
    expect(mocks.queryEngines.execute).not.toHaveBeenCalled();
  });
});

describe("runGeneratedQuery", () => {
  it("falls back to a new tab when the active tab is not a MongoDB query", async () => {
    const { context, mocks } = fakeContext({ mimeType: "application/sql" });
    void runGeneratedQuery(context, { ...options, reuseActiveTab: true });
    await vi.waitFor(() => expect(mocks.fileMediator.createUntitledFile).toHaveBeenCalled());
  });

  it("opens a new tab on a plain click even when a MongoDB tab is active", async () => {
    const { context, mocks, setContent } = fakeContext({ mimeType: MIME_TYPE, connectionId: "prod" });
    void runGeneratedQuery(context, { ...options, reuseActiveTab: false });
    await vi.waitFor(() => expect(mocks.fileMediator.createUntitledFile).toHaveBeenCalled());
    expect(setContent).not.toHaveBeenCalled();
  });
});

describe("isReuseClick", () => {
  it("uses Ctrl outside macOS", () => {
    expect(isReuseClick({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isReuseClick({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});
