import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConversationClient } from "@openhands/typescript-client/clients";
import { ensureM1Stack } from "./m1-stack";
import { buildOpenHandsConversationPayload } from "./openhands-payload";

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 52) || "clyra-vibe-project"
  );
}

function safeProjectId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

async function readProjectMetadata(projectRoot: string) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "metadata.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildConversationUrl(
  uiUrl: string,
  conversationId: string,
  continueExisting: boolean,
) {
  const base = `${uiUrl}/conversations/${conversationId}?openPreview=1`;
  return continueExisting ? `${base}&continue=1` : base;
}

export async function launchM1Conversation(options: {
  prompt?: string;
  projectId?: string;
  planMode?: boolean;
  continueExisting?: boolean;
}) {
  const stack = await ensureM1Stack();
  const continueExisting = !!options.continueExisting;
  const requestedPrompt = options.prompt?.trim() || "";

  const requested = typeof options.projectId === "string" ? options.projectId : "";
  if (continueExisting && (!requested || requested === "project-advanced-vibe")) {
    throw new Error("A project id is required to reopen an existing Vibe project.");
  }

  const projectId = continueExisting
    ? safeProjectId(requested)
    : requested && requested !== "project-advanced-vibe"
      ? safeProjectId(requested)
      : `${slugify(requestedPrompt || "clyra-vibe-project")}-${randomUUID().slice(0, 6)}`;

  const workspacePath = path.resolve(
    process.cwd(),
    "projects",
    projectId,
    "files",
  );
  const projectRoot = path.resolve(workspacePath, "..");
  await fs.mkdir(workspacePath, { recursive: true });

  const existingMeta = await readProjectMetadata(projectRoot);
  const storedPrompt =
    typeof existingMeta?.prompt === "string" ? existingMeta.prompt.trim() : "";
  const storedName =
    typeof existingMeta?.name === "string" ? existingMeta.name.trim() : "";
  const storedConversationId =
    typeof existingMeta?.conversationId === "string"
      ? existingMeta.conversationId.trim()
      : "";

  const promptForAgent = continueExisting
    ? storedPrompt || requestedPrompt || `Continue "${storedName || projectId}"`
    : requestedPrompt;

  if (!continueExisting && !promptForAgent) {
    throw new Error("A prompt is required to launch M1.");
  }

  const now = new Date().toISOString();
  const projectName =
    (continueExisting && storedName) ||
    storedName ||
    promptForAgent.slice(0, 70) ||
    "Vibe project";

  const writeMeta = async (extra: Record<string, unknown>) => {
    await fs.writeFile(
      path.join(projectRoot, "metadata.json"),
      `${JSON.stringify(
        {
          ...(existingMeta || {}),
          id: projectId,
          name: projectName,
          prompt: storedPrompt || promptForAgent,
          mode: options.planMode
            ? "plan"
            : typeof existingMeta?.mode === "string"
              ? existingMeta.mode
              : "fast",
          status: continueExisting ? "Open" : "Building",
          createdAt:
            typeof existingMeta?.createdAt === "string"
              ? existingMeta.createdAt
              : now,
          updatedAt: now,
          harness: "vibe-coder-m1",
          ...extra,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  // Point host tools at M1's tools directory when available.
  const m1Tools = path.join(
    process.env.CLYRA_M1_ROOT?.trim() ||
      "/Users/lukesimpson/Documents/Coding Projects/Vibe Coder M1 Clyra",
    "agent-canvas",
    "tools",
  );
  process.env.OH_EXTRA_PYTHON_PATH = m1Tools;

  const client = new ConversationClient({
    host: stack.agentUrl,
    apiKey: stack.apiKey,
  });

  // Resume saved chat when reopening — keep history instead of a blank convo.
  if (continueExisting && storedConversationId) {
    try {
      const existing = await client.getConversation<{
        id: string;
        title?: string | null;
      }>(storedConversationId);
      const title =
        (typeof existing.title === "string" && existing.title.trim()) ||
        storedName ||
        projectName;
      await writeMeta({
        name: title,
        conversationId: existing.id,
        conversationTitle: title,
        status: "Open",
      });
      return {
        projectId,
        workspacePath,
        conversationId: existing.id,
        conversationUrl: buildConversationUrl(stack.uiUrl, existing.id, true),
        uiUrl: stack.uiUrl,
        harness: "vibe-coder-m1" as const,
        openedWithoutPrompt: true,
        resumed: true,
      };
    } catch (error) {
      console.warn(
        `[m1-launch] stored conversation ${storedConversationId} unavailable; creating a new one`,
        error,
      );
    }
  }

  // Resume by workspace path when metadata has no conversationId yet.
  if (continueExisting && !storedConversationId) {
    try {
      const search = await client.searchConversations({ limit: 40 });
      const items = (search as { items?: Array<{ id?: string; workspace?: { working_dir?: string }; title?: string }> }).items
        || (search as { conversations?: Array<{ id?: string; workspace?: { working_dir?: string }; title?: string }> }).conversations
        || [];
      const match = items.find((item) => {
        const dir = item.workspace?.working_dir || "";
        return dir.includes(`/projects/${projectId}/`) || dir.endsWith(`/projects/${projectId}/files`);
      });
      if (match?.id) {
        const title =
          (typeof match.title === "string" && match.title.trim()) ||
          storedName ||
          projectName;
        await writeMeta({
          name: title,
          conversationId: match.id,
          conversationTitle: title,
          status: "Open",
        });
        return {
          projectId,
          workspacePath,
          conversationId: match.id,
          conversationUrl: buildConversationUrl(stack.uiUrl, match.id, true),
          uiUrl: stack.uiUrl,
          harness: "vibe-coder-m1" as const,
          openedWithoutPrompt: true,
          resumed: true,
        };
      }
    } catch (error) {
      console.warn("[m1-launch] conversation search failed", error);
    }
  }

  const model =
    process.env.MY_LLM_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4.1-mini");
  const apiKey =
    process.env.MY_LLM_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
  const baseUrl =
    process.env.MY_LLM_BASE_URL ||
    (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined);

  const payload = buildOpenHandsConversationPayload({
    prompt: promptForAgent,
    workspacePath,
    planMode: !!options.planMode,
    model,
    apiKey,
    baseUrl,
    includeInitialMessage: !continueExisting,
  });

  const conversation = await client.createConversation<{
    id: string;
    title?: string | null;
  }>(payload);

  const title =
    (typeof conversation.title === "string" && conversation.title.trim()) ||
    projectName;

  await writeMeta({
    conversationId: conversation.id,
    conversationTitle: title,
    name: continueExisting ? projectName : title,
  });

  return {
    projectId,
    workspacePath,
    conversationId: conversation.id,
    conversationUrl: buildConversationUrl(
      stack.uiUrl,
      conversation.id,
      continueExisting,
    ),
    uiUrl: stack.uiUrl,
    harness: "vibe-coder-m1" as const,
    openedWithoutPrompt: continueExisting,
    resumed: false,
  };
}
