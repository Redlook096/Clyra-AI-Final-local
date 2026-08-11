import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

const VERSION = 1;
const MAX_EVENTS = 10_000;

function dataDirectory() {
  if (process.env.CLYRA_USAGE_DATA_DIR) return process.env.CLYRA_USAGE_DATA_DIR;
  if (platform() === "win32") return path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "Clyra");
  if (platform() === "darwin") return path.join(homedir(), "Library", "Application Support", "Clyra");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "Clyra");
}

const ledgerFile = () => path.join(dataDirectory(), "api-usage-ledger.json");
const lockFile = () => `${ledgerFile()}.lock`;
const emptyLedger = () => ({ version: VERSION, updatedAt: new Date().toISOString(), events: [] });

async function sleep(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function acquireLock() {
  const lock = lockFile();
  await mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      return async () => { await unlink(lock).catch(() => undefined); };
    } catch {
      const age = await stat(lock).then((item) => Date.now() - item.mtimeMs).catch(() => 0);
      if (age > 12_000) await unlink(lock).catch(() => undefined);
      await sleep(18 + Math.min(attempt * 3, 90));
    }
  }
  throw new Error("Usage ledger is busy");
}

async function readLedger() {
  try {
    const value = JSON.parse(await readFile(ledgerFile(), "utf8"));
    return value?.version === VERSION && Array.isArray(value.events) ? value : emptyLedger();
  } catch { return emptyLedger(); }
}

async function saveLedger(ledger) {
  const file = ledgerFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger), "utf8");
  await rename(temporary, file);
}

// Verified public token prices in USD per one million tokens. Unknown model
// aliases deliberately have no entry: reporting an invented cost is worse than
// showing "unpriced". Operators can supply exact contract rates through
// CLYRA_USAGE_PRICING_JSON, e.g. {"provider/model":{"input":1,"output":2}}.
const VERIFIED_PRICES = {
  "deepseek/deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28, source: "DeepSeek API pricing" },
  "deepseek/deepseek-v4-pro": { input: 0.435, cachedInput: 0.003625, output: 0.87, source: "DeepSeek API pricing" },
  // Anthropic's standard cache read is 10% of input and its default 5-minute
  // cache write is 125% of input. This app requests the default ephemeral
  // cache lifetime for computer use, so the returned cache-creation token
  // count can be priced rather than silently folded into regular input.
  "anthropic/claude-haiku-4-5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5, source: "Anthropic API pricing" },
  "anthropic/claude-sonnet-4-5": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15, source: "Anthropic API pricing" },
  "anthropic/claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25, source: "Anthropic API pricing" },
};

function customPrices() {
  try { return JSON.parse(process.env.CLYRA_USAGE_PRICING_JSON || "{}"); } catch { return {}; }
}

function normalizedModel(model = "") {
  return String(model).trim().toLowerCase().replace(/-\d{8}$/, "");
}

function resolvePrice(provider, model) {
  const key = `${String(provider).toLowerCase()}/${normalizedModel(model)}`;
  const custom = customPrices();
  // Claude Sonnet 5 has a documented introductory price through 31 August
  // 2026. The ledger uses the usage event's date (not the viewer's date), so
  // past events remain correct after the scheduled rate transition.
  if (key === "anthropic/claude-sonnet-5") {
    const introductory = new Date() < new Date("2026-09-01T00:00:00Z");
    return introductory
      ? { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10, source: "Anthropic API pricing (introductory rate)" }
      : { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15, source: "Anthropic API pricing" };
  }
  return custom[key] || VERIFIED_PRICES[key] || null;
}

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

export function usageFromOpenAi(payload = {}) {
  const usage = payload?.usage || {};
  const prompt = finite(usage.prompt_tokens ?? usage.input_tokens);
  const completion = finite(usage.completion_tokens ?? usage.output_tokens);
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cached = finite(details.cached_tokens ?? details.cache_read_input_tokens);
  return { inputTokens: Math.max(0, prompt - cached), cachedInputTokens: cached, outputTokens: completion, totalTokens: finite(usage.total_tokens) || prompt + completion };
}

export function usageFromAnthropic(payload = {}) {
  const usage = payload?.usage || {};
  return {
    inputTokens: finite(usage.input_tokens),
    cachedInputTokens: finite(usage.cache_read_input_tokens),
    cacheWriteTokens: finite(usage.cache_creation_input_tokens),
    outputTokens: finite(usage.output_tokens),
    totalTokens: finite(usage.input_tokens) + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens) + finite(usage.output_tokens),
  };
}

export function usageFromGemini(payload = {}) {
  const usage = payload?.usageMetadata || payload?.usage_metadata || {};
  return {
    inputTokens: finite(usage.promptTokenCount ?? usage.prompt_token_count),
    cachedInputTokens: finite(usage.cachedContentTokenCount ?? usage.cached_content_token_count),
    outputTokens: finite(usage.candidatesTokenCount ?? usage.candidates_token_count),
    totalTokens: finite(usage.totalTokenCount ?? usage.total_token_count),
  };
}

export async function recordApiUsage(input) {
  const provider = String(input.provider || "unknown").toLowerCase();
  const model = String(input.model || "unknown");
  const tokens = {
    inputTokens: finite(input.usage?.inputTokens),
    cachedInputTokens: finite(input.usage?.cachedInputTokens),
    cacheWriteTokens: finite(input.usage?.cacheWriteTokens),
    outputTokens: finite(input.usage?.outputTokens),
    totalTokens: finite(input.usage?.totalTokens),
  };
  if (!tokens.totalTokens) tokens.totalTokens = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens + tokens.outputTokens;
  const price = resolvePrice(provider, model);
  const costUsd = input.costUsd != null
    ? finite(input.costUsd)
    : price
      ? (tokens.inputTokens * finite(price.input) + tokens.cachedInputTokens * finite(price.cachedInput ?? price.input) + tokens.cacheWriteTokens * finite(price.cacheWrite ?? price.input) + tokens.outputTokens * finite(price.output)) / 1_000_000
      : null;
  const event = {
    id: createHash("sha256").update(`${Date.now()}:${Math.random()}:${provider}:${model}:${input.feature || "other"}`).digest("hex").slice(0, 18),
    at: new Date().toISOString(),
    provider, model, feature: String(input.feature || "other"),
    status: input.status === "error" ? "error" : "success",
    usage: tokens,
    units: input.units && typeof input.units === "object" ? input.units : undefined,
    costUsd,
    costStatus: input.costUsd != null ? "provider-reported" : price ? "verified-rate" : "unpriced",
    priceSource: price?.source || null,
  };
  const release = await acquireLock();
  try {
    const ledger = await readLedger();
    ledger.events = [...ledger.events, event].slice(-MAX_EVENTS);
    ledger.updatedAt = event.at;
    await saveLedger(ledger);
  } finally { await release(); }
  return event;
}

export async function getApiUsageSummary() {
  const ledger = await readLedger();
  const now = Date.now();
  const sinceDay = now - 24 * 60 * 60 * 1000;
  const summarize = (events) => events.reduce((total, event) => ({
    requests: total.requests + 1,
    pricedRequests: total.pricedRequests + (event.costUsd != null ? 1 : 0),
    unpricedRequests: total.unpricedRequests + (event.costUsd == null ? 1 : 0),
    costUsd: total.costUsd + (event.costUsd || 0),
    tokens: total.tokens + finite(event.usage?.totalTokens),
  }), { requests: 0, pricedRequests: 0, unpricedRequests: 0, costUsd: 0, tokens: 0 });
  const groups = new Map();
  for (const event of ledger.events) {
    const key = `${event.provider}:${event.model}`;
    const current = groups.get(key) || { provider: event.provider, model: event.model, requests: 0, tokens: 0, costUsd: 0, unpricedRequests: 0, lastUsedAt: event.at };
    current.requests += 1; current.tokens += finite(event.usage?.totalTokens); current.costUsd += event.costUsd || 0;
    current.unpricedRequests += event.costUsd == null ? 1 : 0;
    if (event.at > current.lastUsedAt) current.lastUsedAt = event.at;
    groups.set(key, current);
  }
  return {
    ok: true,
    currency: "USD",
    updatedAt: ledger.updatedAt,
    total: summarize(ledger.events),
    today: summarize(ledger.events.filter((event) => Date.parse(event.at) >= sinceDay)),
    byModel: [...groups.values()].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)),
    recent: ledger.events.slice(-30).reverse(),
    methodology: "Actual provider usage fields are recorded per completed request. Dollar totals are calculated only when this exact provider/model has a verified rate; unpriced models are never counted as $0.",
  };
}

export async function clearApiUsage() {
  const release = await acquireLock();
  try { await saveLedger(emptyLedger()); } finally { await release(); }
}
