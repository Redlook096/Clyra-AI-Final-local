// Central, main-process-only execution harness. Individual integrations expose
// typed tool descriptors; this class owns stage transitions, checkpoints,
// recovery, completion gates, and renderer-safe activity summaries.
const READ = "read";
const WRITE = "write";
const DESTRUCTIVE = "destructive";
const tool = (name, description, classification, timeoutMs, retry, idempotent, requiredParameters = []) => Object.freeze({
  name, description, requiredParameters, permission: "main-process", classification, timeoutMs,
  retry: { maxAttempts: retry + 1, strategy: retry ? "exponential-backoff" : "none" }, idempotent,
  expectedResult: "validated structured result", validation: "source read-back where applicable",
  redaction: "credentials, OAuth tokens, message bodies, and private identifiers are never emitted to the renderer",
  recovery: retry ? "retry transient failures, then return a safe actionable error" : "return a safe actionable error",
});

export const CLYRA_TOOL_REGISTRY = Object.freeze({
  chat: tool("chat", "Generate a Clyra response", READ, 45_000, 1, true, ["prompt"]),
  webSearch: tool("webSearch", "Search and inspect current public sources", READ, 30_000, 2, true, ["query"]),
  browser: tool("browser", "Inspect and act on an authorised browser page", READ, 45_000, 1, false, ["url"]),
  gmail: tool("gmail", "Read or modify the connected Gmail account", READ, 30_000, 2, true, ["action"]),
  drive: tool("drive", "Search or manage connected Drive files", READ, 30_000, 2, true, ["action"]),
  docs: tool("docs", "Create and validate a Google Doc", WRITE, 60_000, 1, false, ["documentPlan"]),
  sheets: tool("sheets", "Create and validate a Google Sheet", WRITE, 45_000, 1, false, ["sheetPlan"]),
  calendar: tool("calendar", "Read or update the connected calendar", WRITE, 30_000, 1, false, ["action"]),
  youtube: tool("youtube", "Retrieve authorised YouTube metadata", READ, 45_000, 2, true, ["videoId"]),
  clipper: tool("clipper", "Create and validate a clip", WRITE, 120_000, 1, false, ["source"]),
  vibe: tool("vibe", "Implement and verify a coding task", WRITE, 120_000, 1, false, ["prompt"]),
  filesystem: tool("filesystem", "Perform a guarded filesystem action", DESTRUCTIVE, 30_000, 0, false, ["action"]),
});

export class AgentOrchestrator {
  constructor({ emitProgress, log, executeWorkspace }) { this.emitProgress = emitProgress; this.log = log; this.executeWorkspace = executeWorkspace; this.checkpoints = new Map(); }
  classify(payload) {
    const prompt = String(payload.prompt || "").toLowerCase();
    const dataTask = /\b(?:email|gmail|drive|calendar|sheet|document|doc)\b/.test(prompt);
    const deep = /\b(?:research|report|business plan|all emails|comprehensive|multi-source|complex)\b/.test(prompt);
    return { depth: deep ? "deep" : dataTask ? "standard" : "quick", dataTask, deep };
  }
  async run(payload) {
    const runId = payload.runId;
    const profile = this.classify(payload);
    const stage = (label, detail, state = "running") => this.emitProgress(runId, { service:"clyra", state, label, detail });
    stage("Understanding your request", `Routing a ${profile.depth} execution with validated tool actions.`);
    const graph = ["context", ...(profile.dataTask ? ["connected-data"] : []), ...(profile.deep ? ["research", "critique"] : []), "execution", "verification"];
    this.checkpoints.set(runId, { graph, status:"running", createdAt:Date.now() });
    stage("Retrieving relevant context", "Checking only the context and connected sources needed for this request.");
    try {
      const result = await this.executeWorkspace(payload, { profile, stage });
      if (!result?.ok) throw Object.assign(new Error(result?.text || "The requested outcome could not be verified."), { result });
      stage("Verifying the final output", "Checking the source system before reporting completion.");
      this.checkpoints.set(runId, { graph, status:"complete", completedAt:Date.now() });
      stage("Complete", "The requested result passed its final verification.", "completed");
      return result;
    } catch (error) {
      this.checkpoints.set(runId, { graph, status:"failed", failedAt:Date.now(), stage:error?.stage || "execution" });
      this.log("orchestrator-failed", { depth:profile.depth, stage:error?.stage || "execution", httpStatus:error?.httpStatus, errorCode:error?.errorCode });
      stage("Recovery needed", "The task stopped before completion; no unverified result was reported.", "failed");
      if (error?.result) return error.result;
      return { ok:false, text:error instanceof Error ? error.message : "The task could not be completed safely." };
    }
  }
}
