import { EventEmitter } from "node:events";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { VibeCoderEvent } from "./cline-events";
import { PlanModeOrchestrator } from "../agent/plan-mode-orchestrator";
import { CodeModeOrchestrator } from "../agent/code-mode-orchestrator";

export interface ClineRunnerOptions {
  projectId: string;
  prompt: string;
  planMode: boolean;
  workspacePath: string;
  provider: string;
  model: string;
  apiKey?: string;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(file: string, value: unknown) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export class ClineRunner extends EventEmitter {
  private isCancelled = false;
  private approvalResolver?: () => void;
  private codeOrchestrator?: CodeModeOrchestrator;
  private projectRoot: string;
  private agentRoot: string;
  private checkpointsRoot: string;

  constructor(private options: ClineRunnerOptions) {
    super();
    this.projectRoot = path.resolve(options.workspacePath, "..");
    this.agentRoot = path.join(this.projectRoot, ".agent");
    this.checkpointsRoot = path.join(this.projectRoot, "checkpoints");
  }

  public start() {
    this.isCancelled = false;
    void this.run().catch((error) => {
      if (this.isCancelled) return;
      this.emitEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Cline runner failed.",
        recoverable: false,
      });
    });
  }

  public approvePlan() {
    this.approvalResolver?.();
    this.approvalResolver = undefined;
  }

  public cancel() {
    this.isCancelled = true;
    void this.codeOrchestrator?.cancel();
    this.approvalResolver?.();
  }

  private async run() {
    await ensureDir(this.options.workspacePath);
    await ensureDir(this.agentRoot);
    await ensureDir(this.checkpointsRoot);

    const createdAt = new Date().toISOString();
    await writeJson(path.join(this.projectRoot, "metadata.json"), {
      id: this.options.projectId,
      name: this.options.prompt.slice(0, 70) || "Vibe project",
      prompt: this.options.prompt,
      mode: this.options.planMode ? "plan" : "fast",
      status: "Planning",
      createdAt,
      updatedAt: createdAt,
      harness: "cline-sdk",
    });

    // Archive previous PLAN.md on follow-ups
    const planPath = path.join(this.options.workspacePath, "PLAN.md");
    let previousPlan = "";
    if (await pathExists(planPath)) {
      previousPlan = await fs.readFile(planPath, "utf8");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.copyFile(planPath, path.join(this.checkpointsRoot, `PLAN.previous.${stamp}.md`));
      await fs.rename(planPath, path.join(this.options.workspacePath, "PLAN.previous.md")).catch(async () => {
        await fs.copyFile(planPath, path.join(this.options.workspacePath, "PLAN.previous.md"));
      });
      this.emitEvent({ type: "checkpoint_created", id: `plan-archive-${stamp}`, label: "Before replacing old PLAN.md" });
    }

    const planOrchestrator = new PlanModeOrchestrator(
      this.options.workspacePath,
      this.agentRoot,
      this.checkpointsRoot,
      (event) => this.emitEvent(event),
    );

    const { plan, fileQueue } = await planOrchestrator.run(this.options.prompt, previousPlan);
    if (this.isCancelled) return;

    this.emitEvent({ type: "stage", stage: "planning", message: "PLAN.md ready. Waiting for approval before Code Mode." });

    if (this.options.planMode) {
      await new Promise<void>((resolve) => {
        this.approvalResolver = resolve;
      });
    }
    if (this.isCancelled) return;

    this.codeOrchestrator = new CodeModeOrchestrator(
      {
        projectId: this.options.projectId,
        prompt: this.options.prompt,
        workspacePath: this.options.workspacePath,
        agentRoot: this.agentRoot,
        checkpointsRoot: this.checkpointsRoot,
        projectRoot: this.projectRoot,
      },
      (event) => this.emitEvent(event),
    );

    await this.codeOrchestrator.run(plan, fileQueue);

    const doneAt = new Date().toISOString();
    await writeJson(path.join(this.projectRoot, "metadata.json"), {
      id: this.options.projectId,
      name: this.options.prompt.slice(0, 70) || "Vibe project",
      prompt: this.options.prompt,
      mode: this.options.planMode ? "plan" : "fast",
      // Legacy Cline has not been connected to Clyra's canonical validation
      // runtime yet, so it must not claim the same verified Ready state as M1.
      status: "Building",
      updatedAt: doneAt,
      harness: "cline-sdk",
      lastBuildStatus: "unverified",
      lastReviewStatus: "pending",
    });
  }

  private emitEvent(event: VibeCoderEvent) {
    this.emit("event", { ...event, timestamp: Date.now() } as VibeCoderEvent);
  }
}
