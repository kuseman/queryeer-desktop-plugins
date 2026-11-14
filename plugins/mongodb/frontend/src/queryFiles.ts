import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { EditorHandle } from "@queryeer/api/editor/EditorCapability";
import { DATABASE_STATE_KEY, ENGINE_ID, FILE_EXTENSION, MIME_TYPE } from "./constants.js";

const EXECUTE_COMMAND_ID = "core.queryengine.execute";

export type OpenQueryOptions = {
  title: string;
  text: string;
  connectionId: string;
  database: string;
  execute: boolean;
  /** Extra per-file editor state to set, e.g. the query bar's state for a Browse it can take over. */
  editorState?: Record<string, unknown>;
};

/**
 * Runs a generated query: in the active MongoDB tab when `reuseActiveTab` is set and the active editor is a .mongo file,
 * otherwise in a new tab. Reusing replaces the tab's text as one undoable edit (Ctrl+Z restores the previous query),
 * and rebinds the tab to the target connection and database.
 */
export async function runGeneratedQuery(context: PluginContext, options: OpenQueryOptions & { reuseActiveTab: boolean }): Promise<void> {
  if (options.reuseActiveTab && (await replaceInActiveQuery(context, options))) {
    return;
  }
  await openQueryFile(context, options);
}

/** Returns false (and changes nothing) when the active editor is not a MongoDB query that can take new content. */
export async function replaceInActiveQuery(context: PluginContext, options: OpenQueryOptions): Promise<boolean> {
  const editor = context.editors.getActiveEditor();
  const file = editor?.fileId ? context.files.getFile(editor.fileId) : undefined;
  if (!editor?.content || !file || file.mimeType !== MIME_TYPE) {
    return false;
  }

  if (file.engineBinding?.engineId !== ENGINE_ID || file.engineBinding.connectionId !== options.connectionId) {
    await context.fileMediator.bindEngine(file.fileId, ENGINE_ID, options.connectionId);
  }
  setFileState(context, file.fileId, options);
  await writeAndRun(context, editor, options.text, options.execute);
  return true;
}

function setFileState(context: PluginContext, fileId: string, options: OpenQueryOptions): void {
  context.files.setEditorState(fileId, DATABASE_STATE_KEY, { connectionId: options.connectionId, database: options.database });
  for (const [key, value] of Object.entries(options.editorState ?? {})) {
    context.files.setEditorState(fileId, key, value);
  }
}

/**
 * Writes `text` into the active editor when it shows `fileId` (one undoable edit, skipped when the text is already
 * there) and optionally runs it. Used by the query bar. Returns false, changing nothing, when that file's editor is
 * not the active one.
 */
export async function writeToFile(context: PluginContext, fileId: string, text: string, execute: boolean): Promise<boolean> {
  const editor = context.editors.getActiveEditor();
  if (!editor?.content || editor.fileId !== fileId) {
    return false;
  }
  await writeAndRun(context, editor, text, execute);
  return true;
}

async function writeAndRun(context: PluginContext, editor: EditorHandle, text: string, execute: boolean): Promise<void> {
  if (editor.content && editor.content.getContent() !== text) {
    editor.content.setContent(text);
  }
  if (!execute) {
    return;
  }
  await nextFrame();
  const result = await context.commands.executeCommand(EXECUTE_COMMAND_ID);
  if (!result.executed) {
    context.notifications.notify({
      title: "MongoDB",
      message: `The query was written to the current tab but not run${result.reason ? `: ${result.reason}` : ""}. Is a query still running there?`,
      severity: "warning"
    });
  }
}

/** Ctrl+click on Windows/Linux, ⌘+click on macOS. */
export function isReuseClick(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

export function reuseModifierLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Opens a new .mongo tab bound to a connection and database, with `text` as its content, and optionally runs it.
 * The content and the run are aimed at the new file, so neither depends on when its editor becomes active.
 */
export async function openQueryFile(context: PluginContext, options: OpenQueryOptions): Promise<void> {
  const file = await context.fileMediator.createUntitledFile({
    mimeType: MIME_TYPE,
    extension: FILE_EXTENSION,
    title: options.title,
    initialContent: options.text
  });

  // Bind before the run so the execution-context provider sends this connection and database
  await context.fileMediator.bindEngine(file.fileId, ENGINE_ID, options.connectionId);
  setFileState(context, file.fileId, options);

  if (options.execute) {
    context.queryEngines.execute({ fileId: file.fileId, text: options.text });
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}
