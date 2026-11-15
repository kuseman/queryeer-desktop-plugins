import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import { MIME_TYPE } from "./constants.js";
import { PlanActions, SHOW_ESTIMATED_PLAN_COMMAND_ID, TOGGLE_ACTUAL_PLAN_COMMAND_ID } from "./planActions.js";

type Handler = () => unknown;

describe("PlanActions", () => {
  let now = 1000;
  let executed = true;
  const editorState = new Map<string, unknown>();
  const handlers = new Map<string, Handler>();
  const toolbar: Array<{ id: string; title?: string; commandId: string; when?: string; pressed?: (context: { activeFile?: { fileId: string } }) => boolean }> = [];
  const notify = vi.fn();
  const executeCommand = vi.fn(async () => ({ commandId: "core.queryengine.execute", executed, reason: executed ? undefined : "query running" }));
  let activeFileId = "f1";

  const context = {
    commands: { registerCommand: ({ id, handler }: { id: string; handler: Handler }) => handlers.set(id, handler), executeCommand },
    layout: { registerToolbarAction: (action: (typeof toolbar)[number]) => toolbar.push(action) },
    editors: { getActiveEditor: () => ({ fileId: activeFileId }) },
    files: {
      getFile: (fileId: string) => ({ fileId, mimeType: fileId === "sql" ? "application/sql" : MIME_TYPE, engineBinding: { engineId: fileId === "sql" ? "jdbc" : "mongodb" } }),
      getEditorState: (fileId: string, key: string) => editorState.get(`${fileId}/${key}`),
      setEditorState: (fileId: string, key: string, value: unknown) => editorState.set(`${fileId}/${key}`, value)
    },
    notifications: { notify }
  } as unknown as PluginContext;

  let plans: PlanActions;
  beforeEach(() => {
    now = 1000;
    executed = true;
    activeFileId = "f1";
    editorState.clear();
    handlers.clear();
    toolbar.length = 0;
    vi.clearAllMocks();
    plans = new PlanActions(context, () => now);
    plans.register();
  });

  it("adds Estimated Plan and Actual Plan to the toolbar for MongoDB files", () => {
    expect(toolbar.map((action) => [action.title, action.commandId])).toEqual([
      ["Estimated Plan", SHOW_ESTIMATED_PLAN_COMMAND_ID],
      ["Actual Plan", TOGGLE_ACTUAL_PLAN_COMMAND_ID]
    ]);
    expect(toolbar[0].when).toContain(`activeFile.mimeType == '${MIME_TYPE}'`);
  });

  it("runs once as an estimated plan, through the host's execute command", async () => {
    expect(plans.optionsFor("f1", undefined)).toBeUndefined();
    await handlers.get(SHOW_ESTIMATED_PLAN_COMMAND_ID)!();
    expect(executeCommand).toHaveBeenCalledWith("core.queryengine.execute");
    // The host starts the queued run a moment after the command returned
    now += 200;
    expect(plans.optionsFor("f1", { maxRows: 10 })).toEqual({ maxRows: 10, intent: "plan.estimated", requestedArtifacts: [{ capability: "plan", kind: "graph" }] });
    expect(plans.optionsFor("f1", undefined), "only that run").toBeUndefined();
  });

  it("does not let an Estimated Plan request linger", async () => {
    await handlers.get(SHOW_ESTIMATED_PLAN_COMMAND_ID)!();
    now += 6000;
    expect(plans.optionsFor("f1", undefined), "expired").toBeUndefined();

    executed = false;
    await handlers.get(SHOW_ESTIMATED_PLAN_COMMAND_ID)!();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "The plan was not requested: query running." }));
    expect(plans.optionsFor("f1", undefined), "a run that did not start leaves no request").toBeUndefined();
  });

  it("turns every run into an actual plan while Actual Plan is on, per file", () => {
    const pressed = toolbar[1].pressed!;
    expect(pressed({ activeFile: { fileId: "f1" } })).toBe(false);
    handlers.get(TOGGLE_ACTUAL_PLAN_COMMAND_ID)!();
    expect(pressed({ activeFile: { fileId: "f1" } })).toBe(true);
    expect(plans.optionsFor("f1", undefined)?.intent).toBe("plan.actual");
    expect(plans.optionsFor("f1", undefined)?.intent, "every run").toBe("plan.actual");
    expect(plans.optionsFor("f2", undefined), "other files are not affected").toBeUndefined();
    handlers.get(TOGGLE_ACTUAL_PLAN_COMMAND_ID)!();
    expect(plans.optionsFor("f1", undefined)).toBeUndefined();
  });

  it("leaves runs alone that already have an intent, and files of other engines", async () => {
    handlers.get(TOGGLE_ACTUAL_PLAN_COMMAND_ID)!();
    expect(plans.optionsFor("f1", { intent: "execute" })).toBeUndefined();

    activeFileId = "sql";
    await handlers.get(SHOW_ESTIMATED_PLAN_COMMAND_ID)!();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
