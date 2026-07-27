type WelcomeMessage = { role: string; content: string };

export type WelcomeConversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: WelcomeMessage[];
};

export type WelcomeRow = {
  id: string;
  kind: "recent" | "continue" | "new";
  title: string;
  preview: string;
  timestamp?: string;
  prompt?: string;
};

const compact = (value: string) => value.replace(/\s+/g, " ").trim();

/** Produces useful next steps from saved chats without adding a second store. */
export function buildWelcomeRows(chats: WelcomeConversation[]): WelcomeRow[] {
  const saved = chats
    .filter((chat) => chat.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = saved[0];
  if (!latest) return [];

  const userText = compact(latest.messages.filter((message) => message.role === "user").map((message) => message.content).join(" "));
  const title = compact(latest.title) || "your last conversation";
  const greetingOnly = /^(hi|hello|hey|hiya|good (morning|afternoon|evening))[!. ]*$/i.test(userText);
  const date = new Date(latest.updatedAt);
  const timestamp = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const recent: WelcomeRow = {
    id: `recent-${latest.id}`,
    kind: "recent",
    title,
    preview: compact(userText || latest.messages.at(-1)?.content || "Continue this conversation"),
    timestamp,
  };
  const continueRow: WelcomeRow = greetingOnly
    ? {
        id: `continue-${latest.id}`,
        kind: "continue",
        title: "Continue getting to know each other",
        preview: "Pick up the conversation and share what you would like help with.",
        prompt: "I'd like to continue getting to know each other. ",
      }
    : {
        id: `continue-${latest.id}`,
        kind: "continue",
        title: `Build on ${title}`,
        preview: "Continue the last thread with a focused next step.",
        prompt: `Continue helping me with ${title}. Next, `,
      };
  const newRow: WelcomeRow = {
    id: `new-${latest.id}`,
    kind: "new",
    title: greetingOnly ? "Start a fresh conversation" : `Explore a new angle on ${title}`,
    preview: greetingOnly
      ? "Ask Clyra a question, start a task, or share an idea."
      : "Use the context from your recent work to begin something new.",
    prompt: greetingOnly ? "I'd like help with " : `Using what we discussed about ${title}, help me explore a new direction: `,
  };
  return [recent, continueRow, newRow];
}
