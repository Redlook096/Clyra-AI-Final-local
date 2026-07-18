import assert from "node:assert/strict";
import { createAgentTask, taskKey, updateTaskStep } from "../src/lib/agentController";

const key = taskKey("message-1", "vibe");
assert.equal(key, "message-1:vibe");

const task = createAgentTask(key, "vibe", "Build a calculator");
assert.equal(task.state, "queued");
assert.equal(task.plan[0]?.status, "active");

const advanced = updateTaskStep(updateTaskStep(task, "open", "complete"), "request", "active");
assert.equal(advanced.plan.find((step) => step.id === "open")?.status, "complete");
assert.equal(advanced.plan.find((step) => step.id === "request")?.status, "active");
assert.equal(advanced.currentStep, 1);

console.log(JSON.stringify({ ok: true, assertions: 5 }, null, 2));
