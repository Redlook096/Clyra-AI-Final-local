/**
 * Anthropic Computer Use API client — ported from suitedaces/computer-agent (Apache-2.0).
 * https://github.com/suitedaces/computer-agent
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
import { recordApiUsage, usageFromAnthropic } from "../../lib/api-usage-ledger.mjs";
const BETA_HEADER =
  "computer-use-2025-01-24,interleaved-thinking-2025-05-14,web-fetch-2025-09-10,context-management-2025-06-27";
const API_VERSION = "2023-06-01";

export const AI_WIDTH = 1280;
export const AI_HEIGHT = 800;

const SYSTEM_PROMPT = `You are OpenCluely, a desktop computer control agent integrated with Clyra. You see the screen, control mouse/keyboard, and run bash.

Keep text responses very concise. Focus on doing, not explaining. Use tools on every turn.

Click to focus before typing. Screenshot after actions to verify. If something fails, try another approach.

Prefer bash for speed on macOS: open -a "App", open https://url, pbcopy/pbpaste, mdfind. Use sleep N when waiting.

Use the computer tool for visual tasks: clicking UI, reading screen content, filling forms.

SAFETY: Do not delete files, empty Trash, format disks, or run destructive rm/del unless the user explicitly asked for deletion in their task.`;

export function anthropicApiKey() {
  return (
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLYRA_ANTHROPIC_API_KEY ||
    ""
  ).trim();
}

export function anthropicModel() {
  return (
    process.env.ANTHROPIC_COMPUTER_MODEL ||
    process.env.CLYRA_ANTHROPIC_MODEL ||
    "claude-sonnet-4-5"
  ).trim();
}

function clyraComputerUseUrl() {
  const explicit = String(process.env.CLYRA_COMPUTER_AGENT_API_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const base = String(process.env.CLYRA_API_BASE || '').trim().replace(/\/$/, '');
  return base ? `${base}/api/companion/computer-use` : '';
}

export async function computerAgentAvailability({ timeoutMs = 2500 } = {}) {
  const endpoint = clyraComputerUseUrl();
  if (!endpoint) return false;
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    return Boolean(response.ok && payload?.ok && payload?.configured);
  } catch {
    return false;
  }
}

function buildTools() {
  const tools = [
    {
      type: "computer_20250124",
      name: "computer",
      display_width_px: AI_WIDTH,
      display_height_px: AI_HEIGHT,
      display_number: 1,
    },
    { type: "bash_20250124", name: "bash" },
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 10,
    },
    {
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 10,
      max_content_tokens: 50000,
    },
  ];
  const last = tools[tools.length - 1];
  last.cache_control = { type: "ephemeral" };
  return tools;
}

/**
 * @param {Array<{ role: string, content: unknown }>} messages
 * @param {{ model?: string, apiKey?: string, timeoutMs?: number }} [opts]
 */
export async function sendComputerAgentMessage(messages, opts = {}) {
  const apiKey = opts.apiKey || anthropicApiKey();
  const model = opts.model || anthropicModel();
  const body = {
    model,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: buildTools(),
    messages,
    stream: false,
    thinking: { type: "enabled", budget_tokens: 5000 },
    context_management: {
      edits: [
        { type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } },
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 80000 },
          keep: { type: "tool_uses", value: 5 },
          clear_at_least: { type: "input_tokens", value: 10000 },
          exclude_tools: ["web_search", "web_fetch"],
        },
      ],
    },
  };

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs || 120_000);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const proxyUrl = !opts.forceDirect ? clyraComputerUseUrl() : '';
  const response = await fetch(proxyUrl || ANTHROPIC_API_URL, {
    method: "POST",
    headers: proxyUrl
      ? { "content-type": "application/json" }
      : {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "anthropic-beta": BETA_HEADER,
          "content-type": "application/json",
        },
    body: JSON.stringify(proxyUrl ? { messages } : body),
    signal,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      json?.error?.message || json?.error?.type || `Anthropic API failed (${response.status})`;
    throw new Error(String(detail));
  }

  const content = Array.isArray(json?.content) ? json.content : [];
  // Proxy requests are recorded by the Clyra server that made the provider
  // call. Direct mode bypasses that server, so record its authoritative usage
  // here to keep Settings → Usage complete without double-counting.
  if (!proxyUrl) {
    void recordApiUsage({
      provider: "anthropic",
      model: json?.model || model,
      feature: "opencluely-computer-control",
      usage: usageFromAnthropic(json),
    }).catch(() => undefined);
  }
  return { content, usage: json?.usage || null, model, stopReason: json?.stop_reason || null };
}

export function textBlock(text) {
  return { type: "text", text: String(text || "") };
}

export function imageBlock(base64Jpeg) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg },
  };
}

export function toolResultImage(toolUseId, base64Jpeg) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg },
      },
    ],
  };
}

export function toolResultText(toolUseId, text) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: String(text || "") }],
  };
}
