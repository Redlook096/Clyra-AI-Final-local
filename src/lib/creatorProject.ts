import { resolveCreatorVoice, type CreatorVoice } from "./creatorMedia";
import { getFakeTextGameplayClip, type FakeTextGameplayCategory } from "../data/fakeTextGameplay";

export const CREATOR_PROJECT_VERSION = 4;
export const WOULD_RATHER_LEAD_IN_MS = 5_200;

export type CreatorProjectType = "would_rather" | "fake_text_story" | "story_video";

export type CreatorProjectBase = {
  version: number;
  id: string;
  type: CreatorProjectType;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: { width: 1080; height: 1920; fps: 30 };
  audio: { musicVolume: number; sfxVolume: number; ducking: number; muted: boolean };
};

export type WouldRatherRound = {
  id: string;
  question: string;
  left: string;
  right: string;
  leftPercent: number;
  leftImage?: string;
  rightImage?: string;
  timerSeconds: number;
  revealSeconds: number;
};

export type WouldRatherProject = CreatorProjectBase & {
  type: "would_rather";
  rounds: WouldRatherRound[];
  voice: CreatorVoice;
  style: {
    topColor: string;
    bottomColor: string;
    textColor: string;
    fontScale: number;
    darkenBackground: number;
    optionAnimation: "scale" | "slide" | "fade";
  };
};

export type StoryParticipant = {
  id: "left" | "right";
  name: string;
  voice: CreatorVoice;
  color: string;
};

export type StoryMessage = {
  id: string;
  side: "left" | "right";
  text: string;
  typingSeconds: number;
  pauseSeconds: number;
  narration: boolean;
};

export type FakeTextProject = CreatorProjectBase & {
  type: "fake_text_story";
  participants: [StoryParticipant, StoryParticipant];
  messages: StoryMessage[];
  theme: "ios_dark" | "ios_light";
  layout: "floating_phone" | "full_chat" | "chat_gameplay";
  background?: string;
  gameplay?: {
    clipId: string;
    category: FakeTextGameplayCategory;
    src: string;
    poster: string;
    durationSeconds: number;
    sourceUrl: string;
  };
  playbackRate: number;
};

export type StoryVideoProject = CreatorProjectBase & {
  type: "story_video";
  title: string;
  body: string;
  voice: CreatorVoice;
};

export type CreatorProject = WouldRatherProject | FakeTextProject | StoryVideoProject;

export type CreatorTimelineItem = {
  id: string;
  label: string;
  track: "visual" | "voice" | "sfx";
  startMs: number;
  durationMs: number;
  color: string;
};

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function base(type: CreatorProjectType, name: string): CreatorProjectBase {
  const timestamp = now();
  return {
    version: CREATOR_PROJECT_VERSION,
    id: id(),
    type,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    canvas: { width: 1080, height: 1920, fps: 30 },
    audio: { musicVolume: 0.18, sfxVolume: 0.7, ducking: 0.62, muted: false },
  };
}

export function createCreatorProject(type: CreatorProjectType): CreatorProject {
  if (type === "would_rather") {
    return {
      ...base(type, "Would You Rather"),
      type,
      rounds: [{
        id: id(),
        question: "Would you rather...",
        left: "Live in a treehouse",
        right: "Live in an underground bunker",
        leftPercent: 73,
        timerSeconds: 3,
        revealSeconds: 1.5,
      }],
      voice: "Ryan",
      style: {
        topColor: "#ef1710",
        bottomColor: "#1598dc",
        textColor: "#ffffff",
        fontScale: 1,
        darkenBackground: 0.2,
        optionAnimation: "scale",
      },
    };
  }
  if (type === "fake_text_story") {
    const gameplay = getFakeTextGameplayClip();
    return {
      ...base(type, "Message Story"),
      type,
      participants: [
        { id: "left", name: "Alex", voice: "Ryan", color: "#2c2c2e" },
        { id: "right", name: "You", voice: "Aiden", color: "#0a84ff" },
      ],
      messages: [
        { id: id(), side: "left", text: "Are you still coming tonight?", typingSeconds: 0.8, pauseSeconds: 0.22, narration: true },
        { id: id(), side: "right", text: "I was about to ask you the same thing.", typingSeconds: 1.1, pauseSeconds: 0.25, narration: true },
        { id: id(), side: "left", text: "Then check the photo I just sent.", typingSeconds: 0.9, pauseSeconds: 0.35, narration: true },
      ],
      theme: "ios_dark",
      layout: "floating_phone",
      gameplay: gameplay ? {
        clipId: gameplay.id,
        category: gameplay.category,
        src: gameplay.src,
        poster: gameplay.poster,
        durationSeconds: gameplay.durationSeconds,
        sourceUrl: gameplay.sourceUrl,
      } : undefined,
      playbackRate: 1,
    };
  }
  return {
    ...base(type, "Story Video"),
    type,
    title: "The one decision that changed everything",
    body: "I nearly stayed home because it was raining. Going out that night changed the course of my life.",
    voice: "Ryan",
  };
}

function finite(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function migrateCreatorProject(raw: unknown, fallbackType: CreatorProjectType): CreatorProject {
  const fallback = createCreatorProject(fallbackType);
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Record<string, any>;
  const type = value.type === "would_rather" || value.type === "fake_text_story" || value.type === "story_video" ? value.type : fallbackType;
  const seed = createCreatorProject(type);
  const common = {
    ...seed,
    ...value,
    version: CREATOR_PROJECT_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now(),
    canvas: { width: 1080 as const, height: 1920 as const, fps: 30 as const },
    audio: { ...seed.audio, ...(value.audio || {}) },
  };
  if (type === "would_rather") {
    const project = common as WouldRatherProject;
    project.style = { ...(seed as WouldRatherProject).style, ...(value.style || {}) };
    project.rounds = (Array.isArray(value.rounds) ? value.rounds : (seed as WouldRatherProject).rounds).slice(0, 40).map((round: Record<string, any>) => ({
      id: typeof round.id === "string" ? round.id : id(),
      question: String(round.question || "Would you rather...").slice(0, 120),
      left: String(round.left || "Option A").slice(0, 120),
      right: String(round.right || "Option B").slice(0, 120),
      leftPercent: Math.max(5, Math.min(95, finite(round.leftPercent, 50))),
      leftImage: typeof round.leftImage === "string" ? round.leftImage : undefined,
      rightImage: typeof round.rightImage === "string" ? round.rightImage : undefined,
      timerSeconds: Math.max(3, Math.min(10, finite(round.timerSeconds, 3))),
      revealSeconds: Math.max(0.8, Math.min(3, finite(round.revealSeconds, 1.5))),
    }));
    project.voice = resolveCreatorVoice(value.voice, (seed as WouldRatherProject).voice);
    return project;
  }
  if (type === "fake_text_story") {
    const project = common as FakeTextProject;
    const participants = Array.isArray(value.participants) && value.participants.length >= 2
      ? value.participants
      : (seed as FakeTextProject).participants;
    project.participants = [
      {
        id: "left",
        name: String(participants[0]?.name || "Alex").slice(0, 30),
        voice: resolveCreatorVoice(participants[0]?.voice, "Ryan"),
        color: String(participants[0]?.color || "#2c2c2e"),
      },
      {
        id: "right",
        name: String(participants[1]?.name || "You").slice(0, 30),
        voice: resolveCreatorVoice(participants[1]?.voice, "Aiden"),
        color: String(participants[1]?.color || "#0a84ff"),
      },
    ];
    project.theme = value.theme === "ios_light" ? "ios_light" : "ios_dark";
    project.layout = "floating_phone";
    const gameplayId = typeof value.gameplay?.clipId === "string" ? value.gameplay.clipId : undefined;
    const selectedGameplay = getFakeTextGameplayClip(gameplayId);
    project.gameplay = selectedGameplay ? {
      clipId: selectedGameplay.id,
      category: selectedGameplay.category,
      src: selectedGameplay.src,
      poster: selectedGameplay.poster,
      durationSeconds: selectedGameplay.durationSeconds,
      sourceUrl: selectedGameplay.sourceUrl,
    } : undefined;
    project.playbackRate = Math.max(0.6, Math.min(1.8, finite(value.playbackRate, 1)));
    project.messages = (Array.isArray(value.messages) ? value.messages : (seed as FakeTextProject).messages).slice(0, 120).map((message: Record<string, any>) => ({
      id: typeof message.id === "string" ? message.id : id(),
      side: message.side === "right" ? "right" as const : "left" as const,
      text: String(message.text || "").slice(0, 600),
      typingSeconds: Math.max(0, Math.min(8, finite(message.typingSeconds, 0.8))),
      pauseSeconds: Math.max(0, Math.min(5, finite(message.pauseSeconds, 0.25))),
      narration: message.narration !== false,
    }));
    return project;
  }
  const story = common as StoryVideoProject;
  story.voice = resolveCreatorVoice(value.voice, (seed as StoryVideoProject).voice);
  return story;
}

export function creatorProjectDuration(project: CreatorProject) {
  if (project.type === "would_rather") {
    return project.rounds.reduce((sum, round) => sum + WOULD_RATHER_LEAD_IN_MS + round.timerSeconds * 1_000 + round.revealSeconds * 1_000, 0);
  }
  if (project.type === "fake_text_story") {
    return project.messages.reduce((sum, message) => {
      const speech = message.narration ? Math.max(850, message.text.split(/\s+/).length * 310) : 0;
      return sum + message.pauseSeconds * 1_000 + speech;
    }, 0);
  }
  return Math.max(3_000, `${project.title} ${project.body}`.split(/\s+/).length * 320);
}

export function creatorTimeline(project: CreatorProject): CreatorTimelineItem[] {
  const items: CreatorTimelineItem[] = [];
  let cursor = 0;
  if (project.type === "would_rather") {
    for (const [index, round] of project.rounds.entries()) {
      const durationMs = WOULD_RATHER_LEAD_IN_MS + round.timerSeconds * 1_000 + round.revealSeconds * 1_000;
      items.push({ id: round.id, label: `Question ${index + 1}`, track: "visual", startMs: cursor, durationMs, color: index % 2 ? "#0ea5e9" : "#f43f5e" });
      items.push({ id: `${round.id}-voice`, label: "Prompt + options", track: "voice", startMs: cursor + 180, durationMs: 4_700, color: "#64748b" });
      cursor += durationMs;
    }
  } else if (project.type === "fake_text_story") {
    for (const [index, message] of project.messages.entries()) {
      const speech = message.narration ? Math.max(850, message.text.split(/\s+/).length * 310) : 0;
      const durationMs = message.pauseSeconds * 1_000 + speech;
      items.push({ id: message.id, label: `Message ${index + 1}`, track: "visual", startMs: cursor, durationMs, color: message.side === "right" ? "#0a84ff" : "#475569" });
      if (message.narration) items.push({ id: `${message.id}-voice`, label: "Voice", track: "voice", startMs: cursor, durationMs: speech, color: "#14b8a6" });
      cursor += durationMs;
    }
  } else {
    items.push({ id: project.id, label: "Story", track: "visual", startMs: 0, durationMs: creatorProjectDuration(project), color: "#f97316" });
  }
  return items;
}

export function saveCreatorProject(project: CreatorProject) {
  const saved = { ...project, version: CREATOR_PROJECT_VERSION, updatedAt: now() } as CreatorProject;
  localStorage.setItem(`clyra.creator.${saved.type}`, JSON.stringify(saved));
  const index = listCreatorProjects().filter((entry) => entry.id !== saved.id);
  index.unshift({ id: saved.id, type: saved.type, name: saved.name, updatedAt: saved.updatedAt });
  localStorage.setItem("clyra.creator.index", JSON.stringify(index.slice(0, 30)));
  return saved;
}

export function loadCreatorProject(type: CreatorProjectType) {
  try {
    const raw = localStorage.getItem(`clyra.creator.${type}`);
    return raw ? migrateCreatorProject(JSON.parse(raw), type) : createCreatorProject(type);
  } catch {
    return createCreatorProject(type);
  }
}

export function listCreatorProjects(): Array<{ id: string; type: CreatorProjectType; name: string; updatedAt: string }> {
  try {
    const value = JSON.parse(localStorage.getItem("clyra.creator.index") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function exportCreatorProject(project: CreatorProject) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clyra-project"}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
