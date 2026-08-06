/** Clyra Study Brain — shared types (canvas + materials). */

export type SourceKind =
  | "pdf"
  | "doc"
  | "slides"
  | "sheet"
  | "text"
  | "markdown"
  | "image"
  | "note"
  | "web"
  | "youtube"
  | "gdoc"
  | "gslides"
  | "gsheet"
  | "gdrive"
  | "audio"
  | "video";

export type SourceStatus = "idle" | "uploading" | "extracting" | "indexing" | "ready" | "error";

export type StudySourceNode = {
  id: string;
  kind: SourceKind;
  title: string;
  /** Human-readable origin (URL, filename, "Pasted note"). */
  origin: string;
  body: string;
  /** Optional locator for citations (page, slide, timestamp, range). */
  locator?: string;
  status: SourceStatus;
  statusDetail?: string;
  connected: boolean;
  enabled: boolean;
  error?: string;
  meta?: Record<string, string>;
  updatedAt: number;
};

export type StudyChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  at: number;
};

export type QuizQuestion = {
  id: string;
  question: string;
  options: string[];
  correct: number;
  hint: string;
  explanation: string;
};

export type FlashCard = {
  id: string;
  front: string;
  back: string;
  tag: string;
  /** 1–5 confidence; used for light spaced review. */
  confidence?: number;
  dueAt?: number;
};

export type StudyGuide = {
  title: string;
  sections: { heading: string; cue: string; points: string[] }[];
  summary: string;
  questions: { q: string; a: string }[];
};

export type StudyMaterials = {
  quiz: { topic: string; questions: QuizQuestion[] } | null;
  flashcards: { topic: string; cards: FlashCard[] } | null;
  guide: StudyGuide | null;
};

export type StudyBrain = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sources: StudySourceNode[];
  /** React Flow node positions keyed by node id (`brain` or source id). */
  positions: Record<string, { x: number; y: number }>;
  /** Edges from source id → brain. */
  connections: string[];
  messages: StudyChatMessage[];
  materials: StudyMaterials;
  viewport?: { x: number; y: number; zoom: number };
};

export type StudyBrainStore = {
  version: 4;
  brains: StudyBrain[];
  activeBrainId: string | null;
};

export type BrainAction =
  | "ask"
  | "quiz"
  | "flashcards"
  | "guide"
  | "notes"
  | "summary"
  | "explain"
  | "plan";

export const BRAIN_ACTIONS: Array<{ id: BrainAction; label: string; hint: string }> = [
  { id: "ask", label: "Ask Brain", hint: "Grounded Q&A" },
  { id: "quiz", label: "Quiz", hint: "Multiple choice" },
  { id: "flashcards", label: "Flashcards", hint: "Active recall" },
  { id: "guide", label: "Study guide", hint: "Cornell notes" },
  { id: "summary", label: "Summary", hint: "Key concepts" },
  { id: "explain", label: "Teach me", hint: "Socratic tutor" },
  { id: "plan", label: "Revision plan", hint: "Study schedule" },
];
