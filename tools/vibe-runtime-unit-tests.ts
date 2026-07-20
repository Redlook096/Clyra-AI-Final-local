import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntimeStore,
  assertWorkspaceBoundary,
  createWorkspaceCheckpoint,
  ensureWorkspaceAlias,
} from "../lib/vibe-runtime/runtime";

const root = await mkdtemp(path.join(tmpdir(), "clyra-vibe-runtime-"));
const projectRoot = path.join(root, "project");
const workspace = path.join(projectRoot, "files");
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, "index.html"), "<main>Vibe runtime test</main>", "utf8");

try {
  const alias = await ensureWorkspaceAlias("runtime-test", workspace);
  assert.equal(path.basename(alias), "runtime-test");
  assert.equal(await assertWorkspaceBoundary(workspace, path.join(workspace, "index.html")), await realpath(path.join(workspace, "index.html")));
  await assert.rejects(() => assertWorkspaceBoundary(workspace, root), /Workspace boundary violation/);

  const store = new AgentRuntimeStore(projectRoot);
  await store.create({ projectId: "runtime-test", threadId: "thread-1", state: "CREATED", workspacePath: workspace, workspaceAlias: alias, harness: "m1" });
  await store.transition("INITIALISING", "Starting test runtime");
  await store.transition("INSPECTING", "Inspecting project");
  const checkpoint = await createWorkspaceCheckpoint(projectRoot, workspace, "Test checkpoint");
  await store.setCheckpoint(checkpoint.id);
  await store.append({ type: "checkpoint.created", harness: "clyra", status: "completed", payload: { checkpointId: checkpoint.id } });
  await store.transition("RUNNING", "Executing test turn");
  await store.addValidation({ name: "lint", status: "passed", exitCode: 0, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  await store.transition("VALIDATING", "Checking evidence");
  await store.addCompletionEvidence("Validation passed.");
  await store.transition("COMPLETED", "Verified test completion.");

  const snapshot = await store.getSnapshot();
  const events = await store.events();
  assert.equal(snapshot.state, "COMPLETED");
  assert.equal(snapshot.validation[0]?.status, "passed");
  assert.ok(events.length >= 8);
  assert.equal(events[0]?.sequence, 1);
  assert.equal(events.at(-1)?.type, "turn.completed");
  console.log(JSON.stringify({ ok: true, assertions: 9 }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
