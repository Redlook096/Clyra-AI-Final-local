import { randomUUID } from "node:crypto";
import { buildClyraSystemMessageSuffix } from "./deep-build-harness";

export const HOST_PYTHON_TOOL_MODULES: Record<string, string> = {
  research_tool: "research_tool_tool",
  website_theme_scraper: "website_theme_scraper_tool",
  google_image_downloader: "google_image_downloader_tool",
  game_vision_compare: "game_vision_compare_tool",
  site_icon_downloader: "site_icon_downloader_tool",
  codebase_search: "codebase_search_tool",
  canvas_ui: "canvas_ui_tool",
};

export const DEFAULT_TOOL_NAMES = [
  "terminal",
  "file_editor",
  "task_tracker",
  "canvas_ui",
  "research_tool",
  "website_theme_scraper",
  "site_icon_downloader",
  "google_image_downloader",
  "game_vision_compare",
  "codebase_search",
  "browser_tool_set",
] as const;

export function buildOpenHandsConversationPayload(options: {
  prompt: string;
  workspacePath: string;
  planMode: boolean;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  conversationId?: string;
  /** When false, open the workspace without injecting/running a user message. */
  includeInitialMessage?: boolean;
}) {
  const conversationId = options.conversationId || randomUUID();
  const tools = DEFAULT_TOOL_NAMES.map((name) => ({ name, params: {} }));
  const includeInitialMessage = options.includeInitialMessage !== false;

  const llm: Record<string, unknown> = {
    model: options.model.includes("/")
      ? options.model
      : `openai/${options.model}`,
    stream: true,
  };
  if (options.apiKey) llm.api_key = options.apiKey;
  if (options.baseUrl) llm.base_url = options.baseUrl;

  return {
    conversation_id: conversationId,
    agent_settings: {
      agent_kind: "openhands",
      llm,
      tools,
      agent_context: {
        system_message_suffix: buildClyraSystemMessageSuffix({
          planMode: options.planMode,
          prompt: options.prompt,
        }),
      },
    },
    workspace: {
      kind: "LocalWorkspace",
      working_dir: options.workspacePath,
    },
    confirmation_policy: { kind: "NeverConfirm" },
    max_iterations: 100_000,
    stuck_detection: true,
    autotitle: true,
    worktree: false,
    tool_module_qualnames: HOST_PYTHON_TOOL_MODULES,
    ...(includeInitialMessage && options.prompt.trim()
      ? {
          initial_message: {
            role: "user",
            content: [{ type: "text", text: options.prompt }],
            run: true,
          },
        }
      : {}),
  };
}
