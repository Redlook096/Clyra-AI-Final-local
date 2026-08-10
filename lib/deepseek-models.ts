/**
 * DeepSeek V4 model helpers.
 * Legacy aliases deepseek-chat / deepseek-reasoner were retired (July 2026).
 * Fast chat → deepseek-v4-flash with thinking disabled.
 */

export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";

export type DeepseekThinking = { type: "enabled" | "disabled" };

export function resolveDeepseekModel(
  requested?: string | null,
): { model: string; thinking: DeepseekThinking } {
  const raw = String(
    requested ||
      process.env.DEEPSEEK_MODEL ||
      process.env.MY_LLM_MODEL ||
      DEEPSEEK_FLASH_MODEL,
  ).trim();

  if (raw === "deepseek-reasoner") {
    return { model: DEEPSEEK_FLASH_MODEL, thinking: { type: "enabled" } };
  }
  if (
    raw === "deepseek-chat" ||
    raw === "deepseek-v4-flash" ||
    raw === "flash" ||
    raw === "glsh"
  ) {
    return { model: DEEPSEEK_FLASH_MODEL, thinking: { type: "disabled" } };
  }
  if (raw === "deepseek-v4-pro" || raw === "pro") {
    return { model: DEEPSEEK_PRO_MODEL, thinking: { type: "disabled" } };
  }
  // Unknown IDs pass through; still prefer non-thinking for snappy replies.
  return { model: raw || DEEPSEEK_FLASH_MODEL, thinking: { type: "disabled" } };
}

/** Normalize an OpenAI-compatible chat body for DeepSeek V4. */
export function prepareDeepseekChatBody<T extends Record<string, unknown>>(
  body: T,
  opts?: { preferThinking?: boolean },
): T & { model: string; thinking: DeepseekThinking } {
  const resolved = resolveDeepseekModel(
    typeof body.model === "string" ? body.model : null,
  );
  const existing = body.thinking as DeepseekThinking | string | undefined;
  let thinking = resolved.thinking;
  if (opts?.preferThinking) thinking = { type: "enabled" };
  if (existing && typeof existing === "object" && "type" in existing) {
    thinking = existing as DeepseekThinking;
  } else if (existing === "enabled" || existing === "disabled") {
    thinking = { type: existing };
  }
  return {
    ...body,
    model: resolved.model,
    thinking,
  };
}
