import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.join(__dirname, "harness");

function readHarness(name: string): string {
  try {
    return readFileSync(path.join(harnessDir, name), "utf8").trim();
  } catch {
    return "";
  }
}

export const COMPLETE_PRODUCT_BUILD_SUFFIX = readHarness(
  "complete-product-build-suffix.md",
);
export const DEEP_BUILD_COMPLETION_SUFFIX = readHarness(
  "deep-build-completion-suffix.md",
);
export const UNIVERSAL_COMPLETE_PRODUCT_BUILD_INTELLIGENCE_SUFFIX = readHarness(
  "universal-complete-product-build-intelligence.md",
);
export const THINKING_MODE_SUFFIX = readHarness("thinking-mode-suffix.md");
export const GAME_DEV_MODE_SUFFIX = readHarness("game-dev-mode-suffix.md");

export const BUILD_INTENT_PATTERN =
  /\b(build|create|make|design|develop|scaffold|implement|landing\s*page|dashboard|saas|website|web\s*app|frontend|full[\s-]?stack|clone|redesign|vibe[\s-]?cod|improve\s+ui|fix\s+app|feature|product|tool|game|auth|login|sign\s*up|ecommerce|chatbot|api|utility|automation|minecraft|prototype|platform|mobile\s*app|extension|simulation|internal\s*tool|creative\s*tool|developer\s*tool|calculator)\b/i;

export const DEEP_BUILD_CONTINUE_MESSAGE = `You finished too early. Continue the build.

This is a non-trivial product request. You must inspect the project, use task_tracker, implement missing complete-product flows, create/edit the required files, add working adjacent features such as auth/account/navigation/settings where appropriate, run verification commands, start or verify preview, fix errors, and only finish after a self-review.

Do not summarize yet. Continue coding.`;

export const MAX_AUTO_CONTINUE_PER_RUN = 4;

export function isBuildLikeUserMessage(text: string): boolean {
  return BUILD_INTENT_PATTERN.test(text.trim());
}

export function mergeSystemMessageSuffixes(
  ...parts: Array<string | undefined | null>
): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join("\n\n");
}

export function buildClyraSystemMessageSuffix(options: {
  planMode: boolean;
  prompt: string;
}): string {
  const thinking =
    /(?:^|\s)\/thinking\b/i.test(options.prompt) ||
    /\bthinking mode\b/i.test(options.prompt);
  const game =
    /(?:^|\s)\/game\b/i.test(options.prompt) ||
    /\b(3d\s+game|browser game|phaser|three\.js)\b/i.test(options.prompt);

  const base = mergeSystemMessageSuffixes(
    "You are Clyra Vibe Coder using the OpenHands agent-server harness (same tools and loop as Vibe Coder M1). Keep all work inside the workspace. Call canvas_ui (navigate_to_file / show_preview / open_tab) whenever the user should see a file or preview.",
    UNIVERSAL_COMPLETE_PRODUCT_BUILD_INTELLIGENCE_SUFFIX,
    COMPLETE_PRODUCT_BUILD_SUFFIX,
    DEEP_BUILD_COMPLETION_SUFFIX,
    thinking ? THINKING_MODE_SUFFIX : null,
    game ? GAME_DEV_MODE_SUFFIX : null,
    options.planMode
      ? "PLAN MODE: First write a thorough PLAN.md in the workspace root describing architecture, file list, and steps. After PLAN.md is written, stop and wait for the user to approve before implementing code."
      : null,
  );

  return base;
}
