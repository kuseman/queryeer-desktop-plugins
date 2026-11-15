import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { QueryExecuteOptions } from "@queryeer/api/backend/Types";
import { ENGINE_ID, MIME_TYPE, PLUGIN_ID } from "./constants.js";

export const SHOW_ESTIMATED_PLAN_COMMAND_ID = `${PLUGIN_ID}.showEstimatedPlan`;
export const TOGGLE_ACTUAL_PLAN_COMMAND_ID = `${PLUGIN_ID}.toggleActualPlan`;
/** Per-file editor state: whether runs show the actual plan instead of rows. */
export const ACTUAL_PLAN_STATE_KEY = `${PLUGIN_ID}.actualPlan`;

const EXECUTE_COMMAND_ID = "core.queryengine.execute";
const PLAN_ARTIFACTS: QueryExecuteOptions["requestedArtifacts"] = [{ capability: "plan", kind: "graph" }];
/** How long an Estimated Plan request waits for its run to start. */
const ESTIMATED_REQUEST_TTL_MS = 5000;
const MONGO_FILE_WHEN = `hasActiveQueryExecutableFile && activeFile.mimeType == '${MIME_TYPE}'`;

/**
 * Estimated Plan and Actual Plan for MongoDB files, with the same titles and places as the JDBC buttons. Both run through the host's normal
 * execution (so a selection is respected) with a plan intent, which the backend answers with a plan graph for the Plan output instead of rows:
 *
 * - Estimated Plan runs once with `plan.estimated` (explain `queryPlanner`: nothing is executed).
 * - Actual Plan is a toggle: while on, every run of the file uses `plan.actual` (explain `executionStats`: the query runs on the server, but only
 *   the plan with its counts comes back).
 */
export class PlanActions {
  /**
   * Files whose next run is an Estimated Plan request, with when the request expires. The execute command only queues a run, which the editor
   * starts a moment later, so the mark stays until that run takes it, and expires (like the host's own queued requests) so it cannot turn a
   * much later ordinary run into a plan.
   */
  private readonly estimatedNext = new Map<string, number>();

  constructor(private readonly context: PluginContext, private readonly now: () => number = Date.now) {}

  register(): void {
    const { context } = this;
    context.commands.registerCommand({
      id: SHOW_ESTIMATED_PLAN_COMMAND_ID,
      title: "MongoDB: Show Estimated Query Plan",
      category: "Query",
      enablement: `backendHealthy && ${MONGO_FILE_WHEN} && activeEditorGroupHasRunningQuery != true`,
      handler: () => this.showEstimatedPlan()
    });
    context.commands.registerCommand({
      id: TOGGLE_ACTUAL_PLAN_COMMAND_ID,
      title: "MongoDB: Include Actual Query Plan",
      category: "Query",
      enablement: MONGO_FILE_WHEN,
      handler: () => this.toggleActualPlan()
    });
    context.layout.registerToolbarAction({
      id: `${PLUGIN_ID}.toolbar.showEstimatedPlan`,
      title: "Estimated Plan",
      order: 44,
      commandId: SHOW_ESTIMATED_PLAN_COMMAND_ID,
      when: MONGO_FILE_WHEN
    });
    context.layout.registerToolbarAction({
      id: `${PLUGIN_ID}.toolbar.includeActualPlan`,
      title: "Actual Plan",
      order: 45,
      commandId: TOGGLE_ACTUAL_PLAN_COMMAND_ID,
      when: MONGO_FILE_WHEN,
      pressed: ({ activeFile }) => (activeFile ? this.actualPlanOn(activeFile.fileId) : false)
    });
  }

  /** Options for a run of `fileId`, for the engine's execution context provider; undefined to leave the run as it is. */
  optionsFor(fileId: string, options: QueryExecuteOptions | undefined): QueryExecuteOptions | undefined {
    if (options?.intent) {
      return undefined; // Another feature chose what this run is
    }
    const expiresAt = this.estimatedNext.get(fileId);
    this.estimatedNext.delete(fileId);
    if (expiresAt !== undefined && expiresAt >= this.now()) {
      return { ...options, intent: "plan.estimated", requestedArtifacts: PLAN_ARTIFACTS };
    }
    if (this.actualPlanOn(fileId)) {
      return { ...options, intent: "plan.actual", requestedArtifacts: PLAN_ARTIFACTS };
    }
    return undefined;
  }

  actualPlanOn(fileId: string): boolean {
    return this.context.files.getEditorState(fileId, ACTUAL_PLAN_STATE_KEY) === true;
  }

  private activeMongoFileId(): string | undefined {
    const fileId = this.context.editors.getActiveEditor()?.fileId;
    const file = fileId ? this.context.files.getFile(fileId) : undefined;
    return file && file.mimeType === MIME_TYPE && (file.engineBinding?.engineId ?? ENGINE_ID) === ENGINE_ID ? file.fileId : undefined;
  }

  private async showEstimatedPlan(): Promise<void> {
    const fileId = this.activeMongoFileId();
    if (!fileId) {
      return;
    }
    this.estimatedNext.set(fileId, this.now() + ESTIMATED_REQUEST_TTL_MS);
    const result = await this.context.commands.executeCommand(EXECUTE_COMMAND_ID).catch(() => ({ executed: false, reason: undefined }));
    if (!result.executed) {
      // A run that will not start must not turn the next ordinary run into a plan
      this.estimatedNext.delete(fileId);
      this.context.notifications.notify({ title: "MongoDB", message: `The plan was not requested${result.reason ? `: ${result.reason}` : ""}.`, severity: "warning" });
    }
  }

  private toggleActualPlan(): void {
    const fileId = this.activeMongoFileId();
    if (fileId) {
      this.context.files.setEditorState(fileId, ACTUAL_PLAN_STATE_KEY, this.actualPlanOn(fileId) ? undefined : true);
    }
  }
}
