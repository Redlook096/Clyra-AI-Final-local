import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  IdempotencyConflictError,
  ImmediatePublishJobStore,
  SocialPublisherRegistry,
  type SocialPublisher,
} from "../lib/clipper/social-publishing";

let assertions = 0;
const check = (value: unknown, message?: string) => {
  assert.ok(value, message);
  assertions += 1;
};

let connected = false;
const youtubeAdapter: SocialPublisher = {
  platform: "youtube",
  async getConnectionState() {
    return connected ? { state: "connected" as const } : {
      state: "needs_connection" as const,
      message: "YouTube needs to be connected before publishing.",
    };
  },
  async getCapabilities() {
    return { maxDurationMs: 60_000, supportedAspectRatios: ["9:16"], allowsThumbnail: true };
  },
  async validatePost() { return { ok: true, warnings: [], errors: [] }; },
  async initialiseUpload() { return { id: "test-upload" }; },
  async uploadMedia() { return { providerMediaId: "test-media" }; },
  async publish() { return { status: "published" as const, providerPostId: "test-post" }; },
  async getStatus() { return { status: "published" as const }; },
};

const registry = new SocialPublisherRegistry();
const unavailable = await registry.getCapability("tiktok");
assert.equal(unavailable.state, "unavailable"); assertions += 1;
assert.equal(unavailable.code, "adapter_not_installed"); assertions += 1;
assert.equal(unavailable.requiresExplicitConfirmation, true); assertions += 1;
const allDefaultCapabilities = await registry.listCapabilities();
assert.equal(allDefaultCapabilities.length, 9); assertions += 1;
assert.equal((await registry.preflight({ platform: "tiktok", accountId: "account-123" })).ok, false); assertions += 1;

registry.register(youtubeAdapter);
const needsConnection = await registry.getCapability("youtube");
assert.equal(needsConnection.state, "needs_connection"); assertions += 1;

connected = true;
const ready = await registry.getCapability("youtube", "channel_123");
assert.equal(ready.state, "ready"); assertions += 1;
assert.equal(ready.capabilities?.maxDurationMs, 60_000); assertions += 1;
assert.deepEqual(ready.capabilities?.supportedAspectRatios, ["9:16"]); assertions += 1;
assert.equal((await registry.preflight({ platform: "youtube", accountId: "channel_123" })).ok, true); assertions += 1;

const root = await mkdtemp(path.join(tmpdir(), "clyra-clipper-publishing-"));
try {
  const store = new ImmediatePublishJobStore(root);
  const request = {
    platform: "youtube" as const,
    accountId: "channel_123",
    projectId: "project-01",
    clipId: "clip-01",
    mediaRef: "clip-01.mp4",
    idempotencyKey: "client-request-0001",
  };
  const created = await store.create(request);
  assert.equal(created.reused, false); assertions += 1;
  assert.equal(created.job.state, "awaiting_confirmation"); assertions += 1;
  check(!JSON.stringify(created.job).includes(request.idempotencyKey), "Raw idempotency key must never be persisted");

  const repeated = await store.create(request);
  assert.equal(repeated.reused, true); assertions += 1;
  assert.equal(repeated.job.id, created.job.id); assertions += 1;

  await assert.rejects(
    () => store.create({ ...request, clipId: "different-clip" }),
    IdempotencyConflictError,
  );
  assertions += 1;

  const validated = await store.transition(created.job.id, "validated");
  assert.equal(validated.state, "validated"); assertions += 1;
  const uploading = await store.transition(created.job.id, "uploading");
  assert.equal(uploading.state, "uploading"); assertions += 1;
  const processing = await store.transition(created.job.id, "processing");
  assert.equal(processing.state, "processing"); assertions += 1;
  const published = await store.transition(created.job.id, "published", {
    providerPostId: "provider-post-01",
    postUrl: "https://example.test/post/1",
  });
  assert.equal(published.state, "published"); assertions += 1;
  assert.equal(published.providerPostId, "provider-post-01"); assertions += 1;
  await assert.rejects(() => store.transition(created.job.id, "uploading"));
  assertions += 1;
  await assert.rejects(() => store.create({ ...request, mediaRef: "../unsafe.mp4" }));
  assertions += 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`clipper-publishing-unit-tests: ${assertions} assertions passed`);
