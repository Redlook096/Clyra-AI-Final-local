import type { StudyBrain, StudyBrainStore, StudySourceNode } from "./types";

export const STUDY_BRAIN_STORAGE_KEY = "clyra.study-brain.v4";
const LEGACY_V3 = "clyra.study-pal.v3";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function emptyBrain(title = "New study space"): StudyBrain {
  const now = Date.now();
  return {
    id: uid(),
    title,
    createdAt: now,
    updatedAt: now,
    sources: [],
    positions: { brain: { x: 420, y: 280 } },
    connections: [],
    messages: [],
    materials: { quiz: null, flashcards: null, guide: null },
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function emptySource(partial: Partial<StudySourceNode> & Pick<StudySourceNode, "kind" | "title">): StudySourceNode {
  return {
    id: partial.id || uid(),
    kind: partial.kind,
    title: partial.title,
    origin: partial.origin || partial.title,
    body: partial.body || "",
    locator: partial.locator,
    status: partial.status || "idle",
    statusDetail: partial.statusDetail,
    connected: partial.connected ?? false,
    enabled: partial.enabled ?? true,
    error: partial.error,
    meta: partial.meta,
    updatedAt: partial.updatedAt || Date.now(),
  };
}

function migrateV3(raw: unknown): StudyBrainStore | null {
  if (!raw || typeof raw !== "object") return null;
  const sessions = (raw as { sessions?: unknown[] }).sessions;
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const brains: StudyBrain[] = sessions.slice(0, 20).map((session: any, index) => {
    const brain = emptyBrain(String(session?.title || `Study ${index + 1}`));
    brain.id = String(session?.id || brain.id);
    brain.createdAt = Number(session?.createdAt) || brain.createdAt;
    brain.updatedAt = Number(session?.updatedAt) || brain.updatedAt;
    brain.sources = (Array.isArray(session?.sources) ? session.sources : []).map((s: any, i: number) =>
      emptySource({
        id: String(s?.id || `src-${i}`),
        kind: "text",
        title: String(s?.title || "Source"),
        origin: String(s?.source || s?.title || "Source"),
        body: String(s?.body || ""),
        status: "ready",
        connected: Boolean(s?.selected),
        enabled: true,
      }),
    );
    brain.connections = brain.sources.filter((s) => s.connected).map((s) => s.id);
    brain.sources.forEach((source, i) => {
      brain.positions[source.id] = { x: 80, y: 80 + i * 110 };
    });
    brain.messages = (Array.isArray(session?.messages) ? session.messages : []).map((m: any) => ({
      id: String(m?.id || uid()),
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content || ""),
      citations: Array.isArray(m?.citations) ? m.citations.map(String) : undefined,
      at: Date.now(),
    }));
    if (session?.notes) {
      brain.materials.guide = {
        title: String(session.notes.title || "Study guide"),
        sections: Array.isArray(session.notes.sections) ? session.notes.sections : [],
        summary: String(session.notes.summary || ""),
        questions: Array.isArray(session.notes.questions) ? session.notes.questions : [],
      };
    }
    return brain;
  });
  return {
    version: 4,
    brains,
    activeBrainId: brains[0]?.id || null,
  };
}

export function loadStudyBrainStore(): StudyBrainStore {
  if (typeof window === "undefined") {
    return { version: 4, brains: [], activeBrainId: null };
  }
  try {
    const raw = window.localStorage.getItem(STUDY_BRAIN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StudyBrainStore;
      if (parsed?.version === 4 && Array.isArray(parsed.brains)) return parsed;
    }
    const legacy = window.localStorage.getItem(LEGACY_V3);
    if (legacy) {
      const migrated = migrateV3(JSON.parse(legacy));
      if (migrated) {
        saveStudyBrainStore(migrated);
        return migrated;
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { version: 4, brains: [], activeBrainId: null };
}

export function saveStudyBrainStore(store: StudyBrainStore) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STUDY_BRAIN_STORAGE_KEY,
      JSON.stringify({
        ...store,
        brains: store.brains.slice(0, 40),
      }),
    );
  } catch {
    /* quota */
  }
}

export function connectedSources(brain: StudyBrain): StudySourceNode[] {
  const linked = new Set(brain.connections);
  return brain.sources.filter((s) => s.enabled && s.status === "ready" && linked.has(s.id) && s.body.trim());
}

export function toAskContext(sources: StudySourceNode[]) {
  return sources.map((s) => ({
    id: s.id,
    title: s.title,
    source: citationLabel(s),
    body: s.body,
  }));
}

/** Citation chip label: "Biology Notes.pdf — page 12" style. */
export function citationLabel(source: StudySourceNode): string {
  if (source.locator) return `${source.title} — ${source.locator}`;
  return source.title;
}

/** Place new sources in a ring around the Brain node. */
export function positionAroundBrain(
  brainPos: { x: number; y: number },
  index: number,
): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index % 8) * (Math.PI / 4);
  const radius = 280 + Math.floor(index / 8) * 48;
  return {
    x: brainPos.x + Math.cos(angle) * radius - 90,
    y: brainPos.y + Math.sin(angle) * radius - 36,
  };
}

export function findSourceByCitation(brain: StudyBrain, citation: string): StudySourceNode | null {
  const needle = citation.trim().toLowerCase();
  if (!needle) return null;
  return (
    brain.sources.find((source) => citationLabel(source).toLowerCase() === needle) ||
    brain.sources.find((source) => source.title.toLowerCase() === needle) ||
    brain.sources.find((source) => needle.includes(source.title.toLowerCase())) ||
    brain.sources.find((source) => source.origin.toLowerCase() === needle) ||
    null
  );
}

/** Skip re-ingesting the same origin (URL or filename). */
export function hasDuplicateOrigin(brain: StudyBrain, origin: string): boolean {
  const key = origin.trim().toLowerCase();
  if (!key) return false;
  return brain.sources.some((source) => source.origin.trim().toLowerCase() === key);
}
