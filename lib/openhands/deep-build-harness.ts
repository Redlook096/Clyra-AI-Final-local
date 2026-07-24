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
  workspaceAlias?: string;
}): string {
  const thinking =
    /(?:^|\s)\/thinking\b/i.test(options.prompt) ||
    /\bthinking mode\b/i.test(options.prompt);
  const game =
    /(?:^|\s)\/game\b/i.test(options.prompt) ||
    /\b(2d\s+platformer|platformer|game|browser game|phaser|three\.js)\b/i.test(options.prompt);

  const base = mergeSystemMessageSuffixes(
    `You are Clyra Vibe Coder using the OpenHands agent-server harness (same tools and loop as Vibe Coder M1). The terminal is already opened inside the approved workspace${options.workspaceAlias ? ` (${options.workspaceAlias})` : ""}. Never cd outside it, never use an absolute filesystem path, never use ../ traversal, and use relative paths or $PWD only. Do not touch parent folders, user home folders, or unrelated repositories. First inspect the real repository before planning or editing. Use file_editor to create or edit every source file. Make source changes in small valid calls: create a minimal file first, then add one focused section at a time; keep each file_editor payload below roughly 6,000 characters. Do not generate source through a Python, Node, shell, heredoc, cat, printf, or base64 workaround. Never write source with terminal redirection; reserve terminal for inspection, package commands, and validation. Do not use interactive project generators or scaffolders such as npm create, npm init prompts, create-vite, npx create-*, or yarn create. Do not start a preview server yourself, use python http.server, or write server output to /tmp: Clyra owns preview startup and browser QA after you finish. For a standalone frontend, prefer a dependency-free index.html, style.css, and script.js unless an existing project already supplies dependencies. Every completion claim must be backed by real file, command, preview, or browser evidence. Call canvas_ui (navigate_to_file / show_preview / open_tab) whenever the user should see a file or preview. Clyra starts and controls generated previews after you finish. Never guess a preview URL and never navigate a browser to port 3000 or a /files path; verify with terminal commands, then finish so Clyra can open the correct project preview and run browser QA.`,
    // The original policy combined three largely overlapping manuals on
    // every model turn (over 20k tokens before workspace context). That made
    // ordinary file edits visibly stall. The deep-build contract already
    // covers inspection, implementation, validation, and completion; retain
    // the expansive policies as an explicit opt-in for offline experiments.
    process.env.CLYRA_VIBE_FULL_POLICY === "1"
      ? mergeSystemMessageSuffixes(
          UNIVERSAL_COMPLETE_PRODUCT_BUILD_INTELLIGENCE_SUFFIX,
          COMPLETE_PRODUCT_BUILD_SUFFIX,
        )
      : null,
    DEEP_BUILD_COMPLETION_SUFFIX,
    thinking ? THINKING_MODE_SUFFIX : null,
    game ? GAME_DEV_MODE_SUFFIX : null,
    game
      ? "GAME TOOL CONTRACT: Build the game as separate relative files in the approved source directory: index.html, style.css, and game.js (or a small js/ module set). Never put the full game in one HTML file and never embed a large CSS or JavaScript block in HTML. Your first file_editor action must create a valid index.html skeleton only, under 900 characters, that references style.css and game.js. Then create style.css and game.js in separate file_editor calls, each under 900 characters. Continue by adding one small focused section per call. Do not attempt a giant one-shot source edit: a malformed or oversized file_editor payload is a failed build. If a feature needs more code, add it in several valid edits and inspect the file between edits."
      : null,
    options.planMode
      ? "PLAN MODE: First write a thorough PLAN.md in the workspace root describing architecture, file list, and steps. After PLAN.md is written, stop and wait for the user to approve before implementing code."
      : null,
  );

  return base;
}
