/**
 * Clyra-owned social publishing foundation.
 *
 * This module deliberately contains no provider SDK, OAuth client secret, or
 * browser-login fallback. Provider integrations must be registered by the
 * secure desktop/backend process only after their official OAuth flow and app
 * approval have been implemented. Until then, every provider is explicitly
 * reported as unavailable rather than presenting a fake connection or post.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SOCIAL_PLATFORMS = [
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "linkedin",
  "x",
  "threads",
  "pinterest",
  "bluesky",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type PublishingCapabilityState = "ready" | "needs_connection" | "unavailable";
export type ImmediatePublishJobState =
  | "awaiting_confirmation"
  | "validated"
  | "uploading"
  | "processing"
  | "published"
  | "failed"
  | "cancelled";

export interface ConnectedAccount {
  id: string;
  displayName: string;
  handle?: string;
  avatarUrl?: string;
}

export interface PublishingCapabilities {
  maxDurationMs?: number;
  maxFileSizeBytes?: number;
  supportedAspectRatios?: string[];
  supportedVideoCodecs?: string[];
  supportedAudioCodecs?: string[];
  titleMaxLength?: number;
  captionMaxLength?: number;
  privacyOptions?: string[];
  allowsCommentsControl?: boolean;
  allowsThumbnail?: boolean;
  allowsCaptionsFile?: boolean;
  allowsUserTags?: boolean;
}

export interface PublishingCapability {
  platform: SocialPlatform;
  state: PublishingCapabilityState;
  code:
    | "adapter_not_installed"
    | "needs_connection"
    | "account_not_eligible"
    | "provider_configuration_error"
    | "ready";
  message: string;
  requiresExplicitConfirmation: true;
  capabilities?: PublishingCapabilities;
}

export interface PublishRequest {
  platform: SocialPlatform;
  accountId: string;
  projectId: string;
  clipId: string;
  /** A server-resolved media handle; never accept arbitrary filesystem paths from a renderer. */
  mediaRef: string;
  title?: string;
  caption?: string;
  privacy?: string;
  idempotencyKey: string;
}

export interface ValidationResult {
  ok: boolean;
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
}

export interface UploadSession {
  id: string;
  uploadUrl?: string;
  expiresAt?: string;
}

export interface UploadedMedia {
  providerMediaId: string;
}

export interface PublishResult {
  providerPostId?: string;
  postUrl?: string;
  status: "published" | "processing";
}

export interface PublishStatus {
  status: "published" | "processing" | "failed";
  postUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PublisherConnectionState {
  state: "connected" | "needs_connection" | "unavailable";
  code?: "needs_connection" | "account_not_eligible" | "provider_configuration_error";
  message?: string;
}

/**
 * Provider adapters are intentionally narrow. They must live in the secure
 * backend, use official APIs, and never use browser automation or passwords.
 */
export interface SocialPublisher {
  readonly platform: SocialPlatform;
  getConnectionState(accountId?: string): Promise<PublisherConnectionState>;
  getCapabilities(accountId: string): Promise<PublishingCapabilities>;
  validatePost(request: PublishRequest): Promise<ValidationResult>;
  initialiseUpload(request: PublishRequest): Promise<UploadSession>;
  uploadMedia(
    session: UploadSession,
    mediaRef: string,
    onProgress: (progress: { uploadedBytes?: number; totalBytes?: number }) => void,
  ): Promise<UploadedMedia>;
  publish(request: PublishRequest, media: UploadedMedia): Promise<PublishResult>;
  getStatus(providerPostId: string): Promise<PublishStatus>;
}

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
};

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

function safeProviderMessage(platform: SocialPlatform, reason: string) {
  return `${PLATFORM_LABELS[platform]} ${reason}`;
}

/**
 * The registry is deliberately empty by default. Registering a provider is an
 * explicit backend-only action, allowing the UI to distinguish a missing
 * adapter from an account that merely needs OAuth connection.
 */
export class SocialPublisherRegistry {
  private readonly adapters = new Map<SocialPlatform, SocialPublisher>();

  register(adapter: SocialPublisher) {
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`A ${adapter.platform} publisher is already registered`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: SocialPlatform) {
    return this.adapters.get(platform);
  }

  async getCapability(platform: SocialPlatform, accountId?: string): Promise<PublishingCapability> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return {
        platform,
        state: "unavailable",
        code: "adapter_not_installed",
        message: safeProviderMessage(platform, "publishing is not configured in this Clyra build."),
        requiresExplicitConfirmation: true,
      };
    }

    try {
      const connection = await adapter.getConnectionState(accountId);
      if (connection.state === "needs_connection") {
        return {
          platform,
          state: "needs_connection",
          code: "needs_connection",
          message: connection.message || safeProviderMessage(platform, "needs to be connected before publishing."),
          requiresExplicitConfirmation: true,
        };
      }
      if (connection.state === "unavailable") {
        return {
          platform,
          state: "unavailable",
          code: connection.code || "provider_configuration_error",
          message: connection.message || safeProviderMessage(platform, "publishing is unavailable right now."),
          requiresExplicitConfirmation: true,
        };
      }
      if (!accountId) {
        return {
          platform,
          state: "needs_connection",
          code: "needs_connection",
          message: safeProviderMessage(platform, "needs an authorised account before publishing."),
          requiresExplicitConfirmation: true,
        };
      }
      return {
        platform,
        state: "ready",
        code: "ready",
        message: safeProviderMessage(platform, "is ready for a final publishing review."),
        requiresExplicitConfirmation: true,
        capabilities: await adapter.getCapabilities(accountId),
      };
    } catch {
      // Do not surface provider exception details to renderer clients. Secrets,
      // response bodies, and OAuth metadata must stay in backend logs only.
      return {
        platform,
        state: "unavailable",
        code: "provider_configuration_error",
        message: safeProviderMessage(platform, "publishing could not be prepared safely."),
        requiresExplicitConfirmation: true,
      };
    }
  }

  async listCapabilities(accountIdByPlatform: Partial<Record<SocialPlatform, string>> = {}) {
    return Promise.all(
      SOCIAL_PLATFORMS.map((platform) => this.getCapability(platform, accountIdByPlatform[platform])),
    );
  }

  async preflight(request: Pick<PublishRequest, "platform" | "accountId">) {
    const capability = await this.getCapability(request.platform, request.accountId);
    if (capability.state !== "ready") {
      return { ok: false as const, capability };
    }
    return { ok: true as const, capability };
  }
}

export interface ImmediatePublishJob {
  schemaVersion: 1;
  id: string;
  idempotencyHash: string;
  requestFingerprint: string;
  platform: SocialPlatform;
  accountId: string;
  projectId: string;
  clipId: string;
  mediaRef: string;
  state: ImmediatePublishJobState;
  createdAt: string;
  updatedAt: string;
  lastError?: { code: string; message: string };
  providerPostId?: string;
  postUrl?: string;
}

export interface CreateImmediatePublishJobInput {
  platform: SocialPlatform;
  accountId: string;
  projectId: string;
  clipId: string;
  mediaRef: string;
  idempotencyKey: string;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("This idempotency key has already been used for a different publish request.");
    this.name = "IdempotencyConflictError";
  }
}

const TRANSITIONS: Record<ImmediatePublishJobState, ReadonlySet<ImmediatePublishJobState>> = {
  awaiting_confirmation: new Set(["validated", "cancelled", "failed"]),
  validated: new Set(["uploading", "cancelled", "failed"]),
  uploading: new Set(["processing", "published", "failed"]),
  processing: new Set(["published", "failed"]),
  published: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function safeIdentifier(value: string, label: string) {
  const trimmed = String(value || "").trim();
  if (!/^[A-Za-z0-9._:@-]{1,180}$/.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function safeIdempotencyKey(value: string) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 8 || trimmed.length > 256 || /[\u0000-\u001F]/.test(trimmed)) {
    throw new Error("Invalid idempotency key");
  }
  return trimmed;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableRequestFingerprint(input: Omit<CreateImmediatePublishJobInput, "idempotencyKey">) {
  return hash(JSON.stringify({
    accountId: input.accountId,
    clipId: input.clipId,
    mediaRef: input.mediaRef,
    platform: input.platform,
    projectId: input.projectId,
  }));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Local durable state for immediate (never scheduled) publishing jobs.
 * It stores hashes for idempotency keys and only safe media handles, never
 * access tokens, refresh tokens, OAuth codes, or arbitrary filesystem paths.
 */
export class ImmediatePublishJobStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  private jobPath(jobId: string) {
    return path.join(this.root, "jobs", `${safeIdentifier(jobId, "job id")}.json`);
  }

  private idempotencyPath(keyHash: string) {
    return path.join(this.root, "idempotency", `${keyHash}.json`);
  }

  private serialise<T>(action: () => Promise<T>) {
    const next = this.writes.then(action, action);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }

  async create(input: CreateImmediatePublishJobInput): Promise<{ job: ImmediatePublishJob; reused: boolean }> {
    const normalized = {
      platform: input.platform,
      accountId: safeIdentifier(input.accountId, "account id"),
      projectId: safeIdentifier(input.projectId, "project id"),
      clipId: safeIdentifier(input.clipId, "clip id"),
      mediaRef: safeIdentifier(input.mediaRef, "media reference"),
      idempotencyKey: safeIdempotencyKey(input.idempotencyKey),
    };
    if (!isSocialPlatform(normalized.platform)) throw new Error("Invalid social platform");
    const idempotencyHash = hash(normalized.idempotencyKey);
    const requestFingerprint = stableRequestFingerprint(normalized);

    return this.serialise(async () => {
      const indexPath = this.idempotencyPath(idempotencyHash);
      const index = await readJson<{ jobId: string; requestFingerprint: string }>(indexPath);
      if (index) {
        if (index.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
        const existing = await this.get(index.jobId);
        if (!existing) throw new Error("Publish job index is inconsistent");
        return { job: existing, reused: true };
      }

      const now = new Date().toISOString();
      const job: ImmediatePublishJob = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        idempotencyHash,
        requestFingerprint,
        platform: normalized.platform,
        accountId: normalized.accountId,
        projectId: normalized.projectId,
        clipId: normalized.clipId,
        mediaRef: normalized.mediaRef,
        state: "awaiting_confirmation",
        createdAt: now,
        updatedAt: now,
      };
      await atomicWriteJson(this.jobPath(job.id), job);
      await atomicWriteJson(indexPath, { jobId: job.id, requestFingerprint });
      return { job, reused: false };
    });
  }

  async get(jobId: string): Promise<ImmediatePublishJob | null> {
    return readJson<ImmediatePublishJob>(this.jobPath(jobId));
  }

  async transition(
    jobId: string,
    state: ImmediatePublishJobState,
    patch: Pick<ImmediatePublishJob, "lastError" | "providerPostId" | "postUrl"> = {},
  ): Promise<ImmediatePublishJob> {
    return this.serialise(async () => {
      const current = await this.get(jobId);
      if (!current) throw new Error("Publish job not found");
      if (!TRANSITIONS[current.state].has(state)) {
        throw new Error(`Publish job cannot transition from ${current.state} to ${state}`);
      }
      const next: ImmediatePublishJob = {
        ...current,
        ...patch,
        state,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.jobPath(jobId), next);
      return next;
    });
  }
}

export interface ClipperPublishingFoundation {
  registry: SocialPublisherRegistry;
  jobs: ImmediatePublishJobStore;
}

export function createClipperPublishingFoundation(root: string): ClipperPublishingFoundation {
  return {
    registry: new SocialPublisherRegistry(),
    jobs: new ImmediatePublishJobStore(root),
  };
}
