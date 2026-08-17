import {
  Archive, ArrowUp, Bot, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, Clock, FileSearch, FileText, Folder, Globe,
  Headphones, Image, Inbox, LayoutDashboard, LayoutTemplate, ListTodo, MoreHorizontal, Paperclip, PenLine, Plus, Search,
  Star, Table2, Trash2, X, Youtube,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject } from "react";
import { cn } from "../lib/utils";
import { ingestAnyUrl, ingestTextFile } from "../lib/study-brain/ingest";
import { GoogleProductIcon, YouTubeBrandIcon } from "./brand/ProductIcons";
import { ShiningText } from "./ShiningText";

type BlockKind = "text" | "heading" | "todo" | "callout" | "quote" | "divider" | "code" | "calendar";
type WorkspaceBlock = { id: string; kind: BlockKind; content: string; checked?: boolean; dates?: string[] };
type WorkspacePage = { id: string; title: string; icon: string; parentId?: string; updatedAt: number; favorite?: boolean; isFolder?: boolean; trashed?: boolean; blocks: WorkspaceBlock[] };
type WorkspaceStore = { pages: WorkspacePage[]; activePageId: string; inbox: string[] };
type TemplateStyle = "minimal" | "editorial" | "paper" | "professional" | "dark" | "soft" | "academic" | "creative" | "flat" | "glass" | "spatial" | "monochrome";
type TemplateCategory = "Featured" | "Notes" | "Documents" | "Resumes" | "Study" | "Calendars" | "Planners" | "Work" | "Business" | "Projects" | "Dashboards" | "Databases" | "Trackers" | "Forms" | "Research" | "Personal" | "Creative" | "AI";
type TemplateDefinition = { id: string; name: string; description: string; category: TemplateCategory; style: TemplateStyle; tags: string[]; blocks: Array<Omit<WorkspaceBlock, "id">> };
type Source = { id: string; type: "Document" | "YouTube" | "Website" | "Image" | "Audio" | "Text"; title: string; body?: string; status?: "reading" | "ready" | "error"; detail?: string };
type StudyChatEntry = { id: string; role: "user" | "assistant"; content: string; at: number; sources?: string[] };
type GenerationStep = "thinking" | "searching" | "structuring" | "creating" | "complete";

const STORAGE_KEY = "clyra.study-workspace.v1";
const uid = () => Math.random().toString(36).slice(2, 10);
const emptyBlock = (): WorkspaceBlock => ({ id: uid(), kind: "text", content: "" });

const initialStore = (): WorkspaceStore => {
  const dashboardId = uid();
  const chemistryId = uid();
  return {
    activePageId: dashboardId,
    inbox: ["Review the biology flashcards before Thursday"],
    pages: [
      {
        id: dashboardId, title: "Year 12 dashboard", icon: "✦", favorite: true, updatedAt: Date.now(), blocks: [
          { id: uid(), kind: "heading", content: "This week" },
          { id: uid(), kind: "callout", content: "Three focused sessions are enough to move every subject forward." },
          { id: uid(), kind: "todo", content: "Finish the English comparative essay", checked: false },
          { id: uid(), kind: "todo", content: "Revise the chemistry equilibrium notes", checked: true },
          { id: uid(), kind: "heading", content: "Focus areas" },
          { id: uid(), kind: "text", content: "Keep your next action small, visible, and easy to start." },
        ],
      },
      {
        id: chemistryId, title: "Chemistry revision", icon: "◌", parentId: dashboardId, updatedAt: Date.now() - 86400000, blocks: [
          { id: uid(), kind: "heading", content: "Equilibrium" },
          { id: uid(), kind: "text", content: "Le Châtelier’s principle predicts how a system responds to a change in conditions." },
          { id: uid(), kind: "quote", content: "When conditions change, equilibrium shifts to counteract the change." },
        ],
      },
    ],
  };
};

function readStore(): WorkspaceStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as WorkspaceStore | null;
    if (parsed?.pages?.length && parsed.activePageId) return parsed;
  } catch { /* First launch or an older workspace format. */ }
  return initialStore();
}

const commandKinds: Array<{ kind: BlockKind; label: string; hint: string }> = [
  { kind: "text", label: "Text", hint: "Start writing with plain text" },
  { kind: "heading", label: "Heading", hint: "Add a clear section title" },
  { kind: "todo", label: "To-do", hint: "Track an action" },
  { kind: "callout", label: "Callout", hint: "Emphasise a useful note" },
  { kind: "quote", label: "Quote", hint: "Highlight a source or idea" },
  { kind: "code", label: "Code", hint: "Add a code snippet" },
  { kind: "calendar", label: "Calendar", hint: "Plan dates in a live monthly view" },
  { kind: "divider", label: "Divider", hint: "Separate sections" },
];

const slashCommands: Array<{ id: string; label: string; description: string; kind?: BlockKind; action?: "page" | "ai" | "planner" | "timeline"; templateId?: string; aliases?: string[] }> = [
  { id: "text", label: "Text", description: "Start with plain text", kind: "text" },
  { id: "heading", label: "Heading", description: "Create a clear section title", kind: "heading" },
  { id: "todo", label: "To-do list", description: "Track an action with a checkbox", kind: "todo" },
  { id: "callout", label: "Callout", description: "Emphasise a useful note", kind: "callout" },
  { id: "quote", label: "Quote", description: "Highlight a source or idea", kind: "quote" },
  { id: "code", label: "Code", description: "Add a compact code block", kind: "code" },
  { id: "calendar", label: "Calendar", description: "Add a live monthly planning view", kind: "calendar" },
  { id: "planner", label: "Planner", description: "Create a calendar and next actions", action: "planner" },
  { id: "timeline", label: "Timeline", description: "Create a project planning page", action: "timeline" },
  { id: "divider", label: "Divider", description: "Separate two sections", kind: "divider" },
  { id: "page", label: "Page", description: "Create a nested page", action: "page" },
  { id: "ai", label: "Ask Clyra", description: "Create or transform structured content", action: "ai" },
  { id: "document", label: "Document", description: "Start a polished working document", templateId: "blank-document", aliases: ["doc", "write"] },
  { id: "report", label: "Research Report", description: "Question, evidence, analysis and conclusion", templateId: "research-report", aliases: ["academic report", "research"] },
  { id: "resume", label: "Professional Resume", description: "A structured, recruiter-ready CV", templateId: "professional-resume", aliases: ["cv", "career", "application"] },
  { id: "cover-letter", label: "Cover Letter", description: "A focused application letter", templateId: "cover-letter", aliases: ["letter", "job"] },
  { id: "essay", label: "Essay Planner", description: "Thesis, evidence and paragraph plan", templateId: "essay-planner", aliases: ["academic", "argument"] },
  { id: "proposal", label: "Business Proposal", description: "Problem, approach, scope and next steps", templateId: "business-proposal", aliases: ["business plan", "brief"] },
  { id: "calendar-month", label: "Monthly Calendar", description: "A live month view with planning dates", templateId: "monthly-calendar", aliases: ["calendar", "cal", "calendar month"] },
  { id: "calendar-week", label: "Weekly Calendar", description: "Week priorities and scheduled work", templateId: "weekly-planner", aliases: ["calendar week", "schedule"] },
  { id: "assignment-calendar", label: "Assignment Calendar", description: "Deadlines, revision blocks and due work", templateId: "assignment-calendar", aliases: ["study calendar", "exam calendar"] },
  { id: "board", label: "Project Board", description: "A practical project workflow", templateId: "project-board", aliases: ["kanban", "tasks"] },
  { id: "dashboard", label: "Study Dashboard", description: "Calendar, priorities and study progress", templateId: "student-dashboard", aliases: ["workspace", "hub"] },
  { id: "tracker", label: "Assignment Tracker", description: "Track status, due dates and priority", templateId: "assignment-tracker", aliases: ["database", "table"] },
  { id: "meeting", label: "Meeting Minutes", description: "Agenda, decisions and follow-ups", templateId: "meeting", aliases: ["minutes", "agenda"] },
  { id: "cornell", label: "Cornell Notes", description: "Cues, notes and a concise summary", templateId: "cornell", aliases: ["notes", "study notes"] },
];

const templateLibrary: TemplateDefinition[] = [
  { id: "study-hub", name: "Ultimate Study Hub", description: "Subjects, assessment planning and revision in one calm place.", category: "Study", style: "minimal", tags: ["Study", "Dashboard", "Beginner"], blocks: [{ kind: "heading", content: "This week" }, { kind: "callout", content: "Focus on the next assessment first. Small, visible actions build momentum." }, { kind: "heading", content: "Upcoming assessments" }, { kind: "todo", content: "Mathematics · Networks assessment · Friday", checked: false }, { kind: "todo", content: "English · Comparative essay draft · Monday", checked: false }, { kind: "heading", content: "Revision topics" }, { kind: "text", content: "Networks · Finance · Probability" }] },
  { id: "cornell", name: "Cornell Notes", description: "Cue, detailed-note and summary regions for thoughtful revision.", category: "Notes", style: "paper", tags: ["Notes", "Paper", "Study"], blocks: [{ kind: "heading", content: "Network Flow" }, { kind: "callout", content: "Cues: maximum flow · minimum cut · capacity" }, { kind: "heading", content: "Main notes" }, { kind: "text", content: "Maximum flow is the greatest quantity that can travel from a source to a sink through a capacity-constrained network." }, { kind: "quote", content: "The maximum flow equals the capacity of the minimum cut." }, { kind: "heading", content: "Summary" }, { kind: "text", content: "Use residual graphs to find augmenting paths until no more capacity remains." }] },
  { id: "research", name: "AI Research Workspace", description: "Question, evidence, findings and next steps—ready for real sources.", category: "Research", style: "editorial", tags: ["Research", "AI", "Sources"], blocks: [{ kind: "heading", content: "Research question" }, { kind: "text", content: "What evidence best explains the pattern we are investigating?" }, { kind: "heading", content: "Evidence" }, { kind: "callout", content: "Add reliable sources, record the important claim, then compare contradictions." }, { kind: "heading", content: "Findings" }, { kind: "text", content: "Use Clyra to structure sources into arguments, counterpoints and a concise conclusion." }] },
  { id: "meeting", name: "Product Weekly", description: "Agenda, decisions and action items for clear team follow-through.", category: "Work", style: "professional", tags: ["Meeting", "Actions", "Work"], blocks: [{ kind: "heading", content: "Product Weekly" }, { kind: "text", content: "August 16, 2026 · Product team" }, { kind: "heading", content: "Agenda" }, { kind: "todo", content: "Review onboarding progress", checked: false }, { kind: "todo", content: "Decide the beta feedback loop", checked: false }, { kind: "heading", content: "Decisions" }, { kind: "quote", content: "Keep the first-run experience focused on one clear task." }] },
  { id: "project", name: "Minimal Project Plan", description: "A clean project home for milestones, decisions and the next action.", category: "Projects", style: "minimal", tags: ["Projects", "Planning", "Minimal"], blocks: [{ kind: "heading", content: "Project Aurora" }, { kind: "callout", content: "Status · In progress · 64% complete" }, { kind: "heading", content: "Milestones" }, { kind: "todo", content: "Design onboarding", checked: true }, { kind: "todo", content: "Build authentication", checked: false }, { kind: "todo", content: "Launch beta", checked: false }, { kind: "heading", content: "Decisions" }, { kind: "text", content: "Keep the product calm and let the core workflow lead." }] },
  { id: "notes", name: "Minimal Notes", description: "A distraction-free writing page with gentle structure.", category: "Notes", style: "minimal", tags: ["Notes", "Writing", "Simple"], blocks: [{ kind: "heading", content: "A clear thought" }, { kind: "text", content: "Start anywhere. Clyra can help you structure it when you are ready." }, { kind: "divider", content: "" }, { kind: "heading", content: "Next" }, { kind: "text", content: "Write the smallest useful next detail." }] },
  { id: "study-calendar", name: "Study Calendar", description: "Assessments, revision sessions and a calm weekly rhythm.", category: "Calendars", style: "minimal", tags: ["Calendar", "Study", "Planning"], blocks: [{ kind: "heading", content: "Assessment calendar" }, { kind: "calendar", content: "August study plan", dates: [] }, { kind: "heading", content: "This week" }, { kind: "todo", content: "Network Flow revision session", checked: false }, { kind: "todo", content: "English essay checkpoint", checked: false }] },
  { id: "weekly-planner", name: "Weekly Planner", description: "Plan the week with one live calendar and intentional priorities.", category: "Planners", style: "soft", tags: ["Planner", "Weekly", "Personal"], blocks: [{ kind: "heading", content: "A good week" }, { kind: "callout", content: "Choose three priorities, then let the week stay flexible." }, { kind: "calendar", content: "Weekly plan", dates: [] }, { kind: "heading", content: "Priorities" }, { kind: "todo", content: "Finish the most important task", checked: false }, { kind: "todo", content: "Leave space to think", checked: false }] },
  { id: "assignment-calendar", name: "Assignment Calendar", description: "Deadlines, study blocks and focus windows for every subject.", category: "Calendars", style: "professional", tags: ["Calendar", "Assignments", "Student"], blocks: [{ kind: "heading", content: "Semester overview" }, { kind: "calendar", content: "Assignments", dates: [] }, { kind: "heading", content: "Due next" }, { kind: "todo", content: "Mathematics assessment", checked: false }, { kind: "todo", content: "English comparative essay", checked: false }] },
  { id: "project-timeline", name: "Project Timeline", description: "A clear project plan for milestones, decisions and launch work.", category: "Projects", style: "professional", tags: ["Timeline", "Project", "Work"], blocks: [{ kind: "heading", content: "Project Aurora" }, { kind: "calendar", content: "Launch timeline", dates: [] }, { kind: "heading", content: "Milestones" }, { kind: "todo", content: "Complete onboarding", checked: false }, { kind: "todo", content: "Launch beta", checked: false }] },
  { id: "research-report", name: "Research Report", description: "A polished document for question, evidence, analysis and conclusion.", category: "Documents", style: "editorial", tags: ["Document", "Research", "Writing"], blocks: [{ kind: "heading", content: "Research report" }, { kind: "text", content: "A concise executive summary of the question and most important finding." }, { kind: "heading", content: "Evidence" }, { kind: "callout", content: "Add sources, compare evidence, and make contradictions explicit." }, { kind: "heading", content: "Conclusion" }, { kind: "text", content: "State the answer clearly and show what remains uncertain." }] },
  { id: "student-dashboard", name: "Student Dashboard", description: "A complete subject hub with calendar, tasks and recent study material.", category: "Dashboards", style: "minimal", tags: ["Dashboard", "Study", "Calendar"], blocks: [{ kind: "heading", content: "Semester overview" }, { kind: "calendar", content: "Upcoming assessments", dates: [] }, { kind: "heading", content: "Focus next" }, { kind: "todo", content: "Finish science revision notes", checked: false }, { kind: "todo", content: "Plan English draft", checked: false }] },
  { id: "blank-document", name: "Blank Document", description: "A quiet, well-proportioned canvas for a new idea.", category: "Documents", style: "minimal", tags: ["Document", "Minimal", "Writing"], blocks: [{ kind: "heading", content: "Untitled document" }, { kind: "text", content: "Start with the clearest thing you know." }] },
  { id: "professional-resume", name: "Professional Resume", description: "A clean, recruiter-ready resume with an intentional hierarchy.", category: "Resumes", style: "professional", tags: ["Resume", "Career", "Professional"], blocks: [{ kind: "heading", content: "Alex Morgan" }, { kind: "text", content: "Product designer · Sydney, Australia · alex@example.com · portfolio.example" }, { kind: "heading", content: "Professional summary" }, { kind: "text", content: "Product designer who turns ambiguous systems into clear, useful software experiences." }, { kind: "heading", content: "Experience" }, { kind: "text", content: "Senior Product Designer · Northstar Studio · 2023—Present" }, { kind: "todo", content: "Led the redesign of an education workspace used by 40,000 students", checked: false }, { kind: "heading", content: "Education & skills" }, { kind: "text", content: "B.Des · Interaction design · Product strategy · Figma · Research" }] },
  { id: "cover-letter", name: "Cover Letter", description: "A concise, adaptable letter for a thoughtful application.", category: "Resumes", style: "minimal", tags: ["Career", "Letter", "Application"], blocks: [{ kind: "heading", content: "Application for Product Designer" }, { kind: "text", content: "Dear Hiring Team," }, { kind: "text", content: "I am writing to apply because the role combines the product craft and customer empathy I care about most." }, { kind: "heading", content: "Relevant impact" }, { kind: "text", content: "Connect one concrete achievement to the team’s stated need." }, { kind: "text", content: "Kind regards," }, { kind: "text", content: "Alex Morgan" }] },
  { id: "essay-planner", name: "Essay Planner", description: "A focused argument, evidence plan and drafting structure.", category: "Documents", style: "academic", tags: ["Essay", "Academic", "Planning"], blocks: [{ kind: "heading", content: "Essay question" }, { kind: "text", content: "State the question exactly as it has been set." }, { kind: "heading", content: "Thesis" }, { kind: "callout", content: "Make one clear, defensible claim that answers the question." }, { kind: "heading", content: "Evidence plan" }, { kind: "todo", content: "Paragraph 1 · Claim and strongest evidence", checked: false }, { kind: "todo", content: "Paragraph 2 · Counterpoint and analysis", checked: false }, { kind: "todo", content: "Conclusion · Answer the question directly", checked: false }] },
  { id: "business-proposal", name: "Business Proposal", description: "A professional proposal with scope, value and next steps.", category: "Business", style: "professional", tags: ["Business", "Proposal", "Client"], blocks: [{ kind: "heading", content: "Proposal" }, { kind: "text", content: "Prepared for · Client name · August 2026" }, { kind: "heading", content: "Opportunity" }, { kind: "text", content: "Describe the customer problem and the measurable opportunity." }, { kind: "heading", content: "Approach" }, { kind: "todo", content: "Discovery and alignment", checked: false }, { kind: "todo", content: "Delivery plan and milestones", checked: false }, { kind: "heading", content: "Next steps" }, { kind: "text", content: "Confirm scope, owners and start date." }] },
  { id: "monthly-calendar", name: "Monthly Calendar", description: "A live planning calendar with an agenda and next actions.", category: "Calendars", style: "minimal", tags: ["Calendar", "Month", "Planning"], blocks: [{ kind: "heading", content: "Month at a glance" }, { kind: "calendar", content: "Monthly calendar", dates: [] }, { kind: "heading", content: "Upcoming" }, { kind: "todo", content: "Review the highest-priority date", checked: false }] },
  { id: "project-board", name: "Project Board", description: "A calm project workflow for decisions, active work and release.", category: "Projects", style: "flat", tags: ["Project", "Board", "Workflow"], blocks: [{ kind: "heading", content: "Project board" }, { kind: "callout", content: "Now · Design onboarding | Next · Build authentication | Later · Launch beta" }, { kind: "heading", content: "In progress" }, { kind: "todo", content: "Design onboarding", checked: false }, { kind: "heading", content: "Next" }, { kind: "todo", content: "Build authentication", checked: false }, { kind: "heading", content: "Decisions" }, { kind: "text", content: "Capture the decision and why it was made." }] },
  { id: "assignment-tracker", name: "Assignment Tracker", description: "A simple status system for work, due dates and priorities.", category: "Trackers", style: "professional", tags: ["Tracker", "Assignments", "Database"], blocks: [{ kind: "heading", content: "Assignment tracker" }, { kind: "callout", content: "Subject · Due · Status · Priority" }, { kind: "todo", content: "Mathematics · Friday · In progress · High", checked: false }, { kind: "todo", content: "English · Monday · Not started · High", checked: false }, { kind: "todo", content: "Biology · Thursday · Complete · Medium", checked: true }] },
  { id: "content-calendar", name: "Content Calendar", description: "Plan briefs, production and publishing dates in one clear view.", category: "Calendars", style: "creative", tags: ["Calendar", "Content", "Creative"], blocks: [{ kind: "heading", content: "Content calendar" }, { kind: "calendar", content: "Publishing schedule", dates: [] }, { kind: "heading", content: "This week" }, { kind: "todo", content: "Draft launch story", checked: false }, { kind: "todo", content: "Review short-form cut", checked: false }] },
  { id: "resource-library", name: "Resource Library", description: "A calm, searchable home for research, links and source notes.", category: "Databases", style: "minimal", tags: ["Database", "Research", "Library"], blocks: [{ kind: "heading", content: "Resource library" }, { kind: "callout", content: "Title · Type · Topic · Source · Status" }, { kind: "text", content: "Network Flow Explained · Video · Mathematics · YouTube · Reviewed" }, { kind: "text", content: "Renewable Energy Report · PDF · Science · Library · To read" }] },
  { id: "client-intake", name: "Client Intake", description: "A focused form structure for a new client conversation.", category: "Forms", style: "professional", tags: ["Form", "Business", "Client"], blocks: [{ kind: "heading", content: "Client intake" }, { kind: "text", content: "Tell us about the work you would like to do." }, { kind: "heading", content: "Goals" }, { kind: "text", content: "What would a successful outcome look like?" }, { kind: "heading", content: "Timeline & budget" }, { kind: "text", content: "When do you need this, and what range have you allocated?" }] },
  { id: "creative-brief", name: "Creative Brief", description: "A concise direction for a campaign, story or visual project.", category: "Creative", style: "creative", tags: ["Creative", "Brief", "Campaign"], blocks: [{ kind: "heading", content: "Creative brief" }, { kind: "text", content: "Project · Audience · Launch date" }, { kind: "heading", content: "The idea" }, { kind: "callout", content: "Describe the single feeling or message the work should leave behind." }, { kind: "heading", content: "References & deliverables" }, { kind: "todo", content: "Collect references", checked: false }, { kind: "todo", content: "Confirm final deliverables", checked: false }] },
];

const sourceActions: Array<{ type: Source["type"]; label: string; icon: LucideIcon }> = [
  { type: "Document", label: "Document", icon: FileText }, { type: "YouTube", label: "YouTube", icon: Youtube }, { type: "Audio", label: "Audio", icon: Headphones }, { type: "Website", label: "Website", icon: Globe }, { type: "Image", label: "Image", icon: Image },
];

function blockLabel(kind: BlockKind) {
  return commandKinds.find((item) => item.kind === kind)?.label || "Text";
}

/** Converts a grounded model response into real editable objects rather than
 * dropping a Markdown blob into a single text field. */
function blocksFromAnswer(answer: string): WorkspaceBlock[] {
  const blocks: WorkspaceBlock[] = [];
  for (const rawLine of answer.replace(/\*\*/g, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)/);
    const task = line.match(/^(?:[-*]|\d+[.)])\s+(.+)/);
    if (heading) blocks.push({ id: uid(), kind: "heading", content: heading[1] });
    else if (task) blocks.push({ id: uid(), kind: "todo", content: task[1], checked: false });
    else blocks.push({ id: uid(), kind: "text", content: line.replace(/^>\s*/, "") });
  }
  return blocks.slice(0, 32);
}

export default function StudyPalWorkspace({ agentPrompt = "" }: { globalTabsVisible?: boolean; agentPrompt?: string }) {
  const reducedMotion = useReducedMotion();
  const [store, setStore] = useState<WorkspaceStore>(readStore);
  const [section, setSection] = useState<"home" | "document" | "templates" | "search" | "ai" | "inbox" | "trash">(agentPrompt.trim() ? "ai" : "home");
  const [query, setQuery] = useState("");
  const [aiPrompt, setAiPrompt] = useState(agentPrompt);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<Source["type"] | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [templateCategory, setTemplateCategory] = useState<"All" | TemplateDefinition["category"]>("All");
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateStyle, setTemplateStyle] = useState<TemplateStyle>("minimal");
  const [previewTemplate, setPreviewTemplate] = useState<TemplateDefinition | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [slashFor, setSlashFor] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState("");
  const [chatEntries, setChatEntries] = useState<StudyChatEntry[]>([]);
  const [generationStep, setGenerationStep] = useState<GenerationStep | null>(null);
  const [generationSources, setGenerationSources] = useState<string[]>([]);
  const [generatedPage, setGeneratedPage] = useState<{ id: string; title: string } | null>(null);
  const [refreshWave, setRefreshWave] = useState(false);
  const [pageMenuFor, setPageMenuFor] = useState<string | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }, [store]);
  useEffect(() => {
    if (!agentPrompt.trim()) return;
    setSection("ai");
  }, [agentPrompt]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSection("search"); window.setTimeout(() => document.getElementById("study-search")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);

  const page = store.pages.find((item) => item.id === store.activePageId) || store.pages[0];
  const visiblePages = useMemo(() => store.pages.filter((item) => !item.parentId && !item.trashed), [store.pages]);
  const recentPages = useMemo(() => [...store.pages].filter((item) => !item.trashed).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4), [store.pages]);
  const searchResults = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return recentPages;
    return store.pages.filter((item) => !item.trashed && `${item.title} ${item.blocks.map((block) => block.content).join(" ")}`.toLowerCase().includes(term));
  }, [query, recentPages, store.pages]);

  const updateStore = (recipe: (current: WorkspaceStore) => WorkspaceStore) => setStore((current) => recipe(current));
  const openPage = (id: string) => { setStore((current) => ({ ...current, activePageId: id })); setSection("document"); };
  const createPage = (parentId?: string, title = "Untitled") => {
    const next: WorkspacePage = { id: uid(), title, icon: "◌", parentId, updatedAt: Date.now(), blocks: [emptyBlock()] };
    setStore((current) => ({ ...current, pages: [next, ...current.pages], activePageId: next.id })); setSection("document");
  };
  const createFolder = () => {
    const next: WorkspacePage = { id: uid(), title: "Untitled folder", icon: "", isFolder: true, updatedAt: Date.now(), blocks: [emptyBlock()] };
    setStore((current) => ({ ...current, pages: [next, ...current.pages], activePageId: next.id }));
    setRenamingPageId(next.id); setRenameDraft(next.title); setSection("document");
  };
  const updatePage = (pageId: string, patch: Partial<WorkspacePage>) => updateStore((current) => ({ ...current, pages: current.pages.map((item) => item.id === pageId ? { ...item, ...patch, updatedAt: Date.now() } : item) }));
  const updateBlock = (blockId: string, patch: Partial<WorkspaceBlock>) => updatePage(page.id, { blocks: page.blocks.map((item) => item.id === blockId ? { ...item, ...patch } : item) });
  const addBlock = (kind: BlockKind = "text", afterId?: string) => {
    const block = { ...emptyBlock(), kind };
    const index = afterId ? page.blocks.findIndex((item) => item.id === afterId) + 1 : page.blocks.length;
    updatePage(page.id, { blocks: [...page.blocks.slice(0, index), block, ...page.blocks.slice(index)] });
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)?.focus(), 30);
  };
  const deleteBlock = (blockId: string) => updatePage(page.id, { blocks: page.blocks.filter((item) => item.id !== blockId) });
  const movePage = (pageId: string, parentId?: string) => updateStore((current) => ({ ...current, pages: current.pages.map((item) => item.id === pageId ? { ...item, parentId, updatedAt: Date.now() } : item) }));
  const trashPage = (pageId: string) => {
    updateStore((current) => ({ ...current, activePageId: current.activePageId === pageId ? (current.pages.find((item) => !item.trashed && item.id !== pageId)?.id || current.activePageId) : current.activePageId, pages: current.pages.map((item) => item.id === pageId || item.parentId === pageId ? { ...item, trashed: true, updatedAt: Date.now() } : item) }));
    setPageMenuFor(null); setSection("home");
  };
  const commitRename = (pageId: string) => { if (renameDraft.trim()) updatePage(pageId, { title: renameDraft.trim() }); setRenamingPageId(null); };
  const moveBlock = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const blocks = [...page.blocks]; const from = blocks.findIndex((item) => item.id === fromId); const to = blocks.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = blocks.splice(from, 1); blocks.splice(to, 0, moved); updatePage(page.id, { blocks });
  };
  const addSource = (type: Source["type"], title: string, body = "") => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    setSources((current) => [...current, { id: uid(), type, title: cleanTitle, body, status: "ready" }]);
    setSourceDraft(""); setSourcePicker(null); setSourceMenuOpen(false);
  };
  const addSourceFromFile = async (file: File | undefined) => {
    if (!file) return;
    const id = uid();
    const type: Source["type"] = file.type.startsWith("image/") ? "Image" : file.type.startsWith("audio/") ? "Audio" : "Document";
    setSources((current) => [...current, { id, type, title: file.name, status: "reading", detail: "Reading source…" }]);
    try {
      const source = await ingestTextFile(file);
      setSources((current) => current.map((item) => item.id === id ? { ...item, title: source.title || file.name, body: source.body, status: source.status === "error" ? "error" : "ready", detail: source.statusDetail } : item));
    } catch (error) {
      setSources((current) => current.map((item) => item.id === id ? { ...item, status: "error", detail: error instanceof Error ? error.message : "Clyra could not read this file." } : item));
    }
    setSourceDraft(""); setSourcePicker(null); setSourceMenuOpen(false);
  };
  const addLinkedSource = async (type: Extract<Source["type"], "YouTube" | "Website">, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    const id = uid();
    setSources((current) => [...current, { id, type, title: url, body: url, status: "reading", detail: type === "YouTube" ? "Analysing video…" : "Reading website…" }]);
    setSourceDraft(""); setSourcePicker(null); setSourceMenuOpen(false);
    try {
      const source = await ingestAnyUrl(url);
      setSources((current) => current.map((item) => item.id === id ? { ...item, type: source.kind === "youtube" ? "YouTube" : "Website", title: source.title || url, body: source.body, status: source.status === "error" ? "error" : "ready", detail: source.statusDetail } : item));
    } catch (error) {
      setSources((current) => current.map((item) => item.id === id ? { ...item, status: "error", detail: error instanceof Error ? error.message : "Clyra could not read this link." } : item));
    }
  };
  const useTemplate = (template: TemplateDefinition, style = templateStyle) => {
    const next: WorkspacePage = { id: uid(), title: template.name, icon: "◌", updatedAt: Date.now(), favorite: true, blocks: template.blocks.map((block) => ({ ...block, id: uid() })) };
    setStore((current) => ({ ...current, pages: [next, ...current.pages], activePageId: next.id }));
    setPreviewTemplate(null); setSection("document"); setTemplateStyle(style);
  };
  const openNotesType = (title: string) => { setAiPrompt(`Create ${title} from my notes and sources`); setSection("ai"); };
  const filteredTemplates = useMemo(() => templateLibrary.filter((template) => {
    const haystack = `${template.name} ${template.description} ${template.category} ${template.tags.join(" ")} ${template.style}`.toLowerCase();
    return (templateCategory === "All" || template.category === templateCategory) && (!templateQuery.trim() || haystack.includes(templateQuery.toLowerCase().trim()));
  }), [templateCategory, templateQuery]);

  const generateWorkspace = async () => {
    const prompt = aiPrompt.trim(); if (!prompt || aiBusy) return;
    setAiError(null);
    setAiBusy(true);
    setSection("ai");
    setGeneratedPage(null);
    setGenerationSources([]);
    setGenerationStep("thinking");
    setChatEntries((current) => [...current, { id: uid(), role: "user", content: prompt, at: Date.now() }]);
    try {
      const useWeb = sources.length === 0 && /\b(research|sources?|web|online|latest|current|compare|report|study guide|explain)\b/i.test(prompt);
      let webContext = "";
      let foundSources: string[] = [];
      if (useWeb) {
        setGenerationStep("searching");
        try {
          const searchResponse = await fetch("/api/research/web-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: prompt, maxResults: 5, fetchTop: 3 }) });
          const searchPayload = await searchResponse.json().catch(() => ({})) as { ok?: boolean; urls?: string[]; analysisPrompt?: string };
          if (searchResponse.ok && searchPayload.ok) {
            foundSources = Array.isArray(searchPayload.urls) ? searchPayload.urls.map(String).filter(Boolean).slice(0, 5) : [];
            setGenerationSources(foundSources);
            webContext = String(searchPayload.analysisPrompt || "").trim();
          }
        } catch { /* The document request still has a useful local context. */ }
      }
      setGenerationStep("structuring");
      const context = sources.length ? sources.map((source) => ({ id: source.id, title: source.title, source: source.type, body: source.body || source.title })) : [{ id: page.id, title: page.title, source: "Current Study Pal page", body: page.blocks.map((block) => block.content).filter(Boolean).join("\n") || prompt }];
      if (webContext) context.push({ id: "web-research", title: "Clyra web research", source: "Web search", body: webContext });
      setGenerationStep("creating");
      const response = await fetch("/api/study/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: prompt, mode: "plan", context }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false || typeof payload?.answer !== "string") throw new Error(String(payload?.error || "Clyra could not create this workspace."));
      const text = payload.answer;
      const title = prompt.replace(/^(create|make|build|turn)\s+(me\s+)?/i, "").slice(0, 58).replace(/[.?!]$/, "") || "New workspace";
      const next: WorkspacePage = { id: uid(), title: title[0]?.toUpperCase() + title.slice(1), icon: "✦", updatedAt: Date.now(), favorite: true, blocks: [
        { id: uid(), kind: "heading", content: "Overview" }, ...blocksFromAnswer(text),
        { id: uid(), kind: "heading", content: "Next actions" }, { id: uid(), kind: "todo", content: "Review and personalise this workspace", checked: false },
        { id: uid(), kind: "todo", content: "Add your source material and deadlines", checked: false },
      ] };
      setStore((current) => ({ ...current, pages: [next, ...current.pages], activePageId: next.id }));
      setChatEntries((current) => [...current, { id: uid(), role: "assistant", content: `I created **${next.title}** as an editable workspace. I structured the key sections and next actions so you can start from a useful first draft.`, at: Date.now(), sources: foundSources }]);
      setGeneratedPage({ id: next.id, title: next.title });
      setAiPrompt(""); setSources([]); setAssistantOpen(false); setGenerationStep("complete");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "Clyra could not create this workspace. Please try again.");
      setGenerationStep(null);
    } finally { setAiBusy(false); }
  };

  const nav = [
    ["home", "Home", FileText], ["search", "Search", Search], ["ai", "Clyra", Bot], ["inbox", "Inbox", Inbox],
  ] as const;

  return (
    <div className="study-workspace h-full min-h-0 w-full bg-[#fafaf9] text-[#292a2e]" onClick={() => setPaletteFor(null)}>
      <aside className="study-workspace__sidebar">
        <div className="study-workspace__brand"><span className="study-workspace__brand-mark">C</span><span>Study Pal</span><ChevronDown size={13} /></div>
        <button type="button" className="study-workspace__new" onClick={() => createPage()}><Plus size={16} />Create document</button>
        <nav className="study-workspace__nav" aria-label="Workspace navigation">
          {nav.map(([id, label, Icon]) => <button type="button" key={id} className={cn(section === id && "is-active")} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span>{label === "Search" ? <kbd>⌘K</kbd> : null}</button>)}
        </nav>
        <div className="study-workspace__section-title"><span>Projects</span><button type="button" onClick={createFolder} aria-label="New folder"><Plus size={14} /></button></div>
        <div className="study-workspace__pages">
          {visiblePages.map((item) => <div key={item.id}>
            <SidebarPageRow item={item} active={item.id === page.id && section === "document"} child={false} folders={visiblePages.filter((candidate) => candidate.isFolder && candidate.id !== item.id)} menuOpen={pageMenuFor === item.id} renaming={renamingPageId === item.id} renameDraft={renameDraft} setRenameDraft={setRenameDraft} onOpen={() => openPage(item.id)} onToggleMenu={() => setPageMenuFor((current) => current === item.id ? null : item.id)} onRename={() => { setRenamingPageId(item.id); setRenameDraft(item.title); setPageMenuFor(null); }} onCommitRename={() => commitRename(item.id)} onMove={movePage} onDelete={() => trashPage(item.id)} />
            {store.pages.filter((child) => child.parentId === item.id && !child.trashed).map((child) => <SidebarPageRow key={child.id} item={child} active={child.id === page.id && section === "document"} child folders={visiblePages.filter((candidate) => candidate.isFolder && candidate.id !== child.id)} menuOpen={pageMenuFor === child.id} renaming={renamingPageId === child.id} renameDraft={renameDraft} setRenameDraft={setRenameDraft} onOpen={() => openPage(child.id)} onToggleMenu={() => setPageMenuFor((current) => current === child.id ? null : child.id)} onRename={() => { setRenamingPageId(child.id); setRenameDraft(child.title); setPageMenuFor(null); }} onCommitRename={() => commitRename(child.id)} onMove={movePage} onDelete={() => trashPage(child.id)} />)}
          </div>)}
        </div>
        <div className="study-workspace__sidebar-bottom"><button type="button" onClick={() => setSection("templates")}><LayoutTemplate size={15} />Templates</button><button type="button" onClick={() => setSection("trash")}><Trash2 size={15} />Trash</button></div>
      </aside>
      <main className="study-workspace__main">
        <AnimatePresence mode="wait" initial={false}>
          {section === "home" ? <HomeCanvas key="home" reducedMotion={reducedMotion} sources={sources} sourceMenuOpen={sourceMenuOpen} sourcePicker={sourcePicker} sourceDraft={sourceDraft} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} setSourceMenuOpen={setSourceMenuOpen} setSourcePicker={setSourcePicker} setSourceDraft={setSourceDraft} addSource={addSource} addLinkedSource={addLinkedSource} addSourceFromFile={addSourceFromFile} removeSource={(id) => setSources((current) => current.filter((source) => source.id !== id))} generateWorkspace={generateWorkspace} aiBusy={aiBusy} aiError={aiError} recentPages={recentPages} openPage={openPage} setSection={setSection} openNotesType={openNotesType} /> : section === "templates" ? <TemplateLibrary key="templates" reducedMotion={reducedMotion} query={templateQuery} setQuery={setTemplateQuery} category={templateCategory} setCategory={setTemplateCategory} style={templateStyle} setStyle={setTemplateStyle} templates={filteredTemplates} previewTemplate={previewTemplate} setPreviewTemplate={setPreviewTemplate} onUse={useTemplate} onCreateWithAI={() => { setAiPrompt("Create a premium workspace for "); setSection("ai"); }} /> : section === "ai" ? <StudyChat key="ai" reducedMotion={reducedMotion} entries={chatEntries} busy={aiBusy} step={generationStep} sources={generationSources} completed={generatedPage} value={aiPrompt} setValue={setAiPrompt} onSubmit={generateWorkspace} error={aiError} onOpen={(id) => { setRefreshWave(true); openPage(id); window.setTimeout(() => setRefreshWave(false), 1050); }} /> : section === "search" ? <motion.section key="search" {...viewMotion(reducedMotion)} className="study-workspace__search-view"><div><span className="study-workspace__eyebrow"><Search size={15} />Search everything</span><h1>Find a thought, task, or page.</h1><div className="study-workspace__search-field"><Search size={17} /><input id="study-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages and blocks…" /><kbd>Esc</kbd></div></div><div className="study-workspace__search-results">{searchResults.map((item) => <button type="button" key={item.id} onClick={() => openPage(item.id)}><span>{item.icon}</span><div><strong>{item.title}</strong><small>{item.blocks.find((block) => block.content)?.content || "Empty page"}</small></div><ChevronRight size={15} /></button>)}</div></motion.section> : section === "inbox" ? <motion.section key="inbox" {...viewMotion(reducedMotion)} className="study-workspace__search-view"><div><span className="study-workspace__eyebrow"><Inbox size={15} />Inbox</span><h1>Things to sort out.</h1></div><div className="study-workspace__inbox">{store.inbox.map((item, index) => <div key={item}><ListTodo size={16} /><span>{item}</span><button type="button" onClick={() => setStore((current) => ({ ...current, inbox: current.inbox.filter((_, position) => position !== index) }))}>Done</button></div>)}{store.inbox.length === 0 ? <p>Inbox zero. Add a thought whenever it arrives.</p> : null}</div></motion.section> : section === "trash" ? <motion.section key="trash" {...viewMotion(reducedMotion)} className="study-workspace__search-view"><div><span className="study-workspace__eyebrow"><Trash2 size={15} />Trash</span><h1>{store.pages.some((item) => item.trashed) ? "Recently deleted" : "Nothing here yet."}</h1><p className="study-workspace__quiet">Deleted pages wait here until you restore them.</p></div><div className="study-workspace__search-results">{store.pages.filter((item) => item.trashed).map((item) => <button type="button" key={item.id} onClick={() => { updatePage(item.id, { trashed: false }); openPage(item.id); }}><span>{item.isFolder ? <Folder size={15} /> : item.icon}</span><div><strong>{item.title}</strong><small>Restore this {item.isFolder ? "folder" : "document"}</small></div><ChevronRight size={15} /></button>)}</div></motion.section> : <motion.section key={page.id} {...viewMotion(reducedMotion)} className="study-workspace__document">
            <header className="study-workspace__document-head"><div className="study-workspace__crumb"><Folder size={14} />Projects <ChevronRight size={13} />{page.title}</div><div><button type="button" aria-label="Favourite page" onClick={() => updatePage(page.id, { favorite: !page.favorite })}><Star size={16} fill={page.favorite ? "currentColor" : "none"} /></button><button type="button" aria-label="Ask AI about this page" onClick={() => { setSection("ai"); setAiPrompt(`Improve the structure and visual hierarchy of ${page.title}`); }}><Bot size={16} /></button></div></header>
            <div className="study-workspace__document-canvas"><button type="button" className="study-workspace__page-icon" onClick={() => updatePage(page.id, { icon: page.icon === "✦" ? "◌" : "✦" })}>{page.icon}</button><input className="study-workspace__title" value={page.title} onChange={(event) => updatePage(page.id, { title: event.target.value })} aria-label="Page title" />
              <div className="study-workspace__blocks">{page.blocks.map((block) => <BlockRow key={block.id} block={block} paletteOpen={paletteFor === block.id} slashOpen={slashFor === block.id} slashQuery={slashFor === block.id ? slashQuery : ""} onPalette={(event) => { event.stopPropagation(); setPaletteFor((current) => current === block.id ? null : block.id); }} onSlash={(value) => { if (value === null) { setSlashFor(null); setSlashQuery(""); } else { setSlashFor(block.id); setSlashQuery(value); } }} onCommand={(command) => { setSlashFor(null); setSlashQuery(""); if (command.kind) updateBlock(block.id, { kind: command.kind, content: command.kind === "calendar" ? "Monthly plan" : "", dates: command.kind === "calendar" ? [] : undefined }); else if (command.action === "page") createPage(page.id, "Untitled subpage"); else if (command.templateId || command.action === "planner" || command.action === "timeline") { const template = templateLibrary.find((item) => item.id === (command.templateId || (command.action === "planner" ? "weekly-planner" : "project-timeline"))); if (template) useTemplate(template); } else { setAiPrompt(`Help me improve ${page.title}: `); setSection("ai"); } }} onChange={(patch) => updateBlock(block.id, patch)} onDelete={() => deleteBlock(block.id)} onAdd={(kind) => { addBlock(kind, block.id); setPaletteFor(null); }} dragId={dragId} setDragId={setDragId} onDrop={(fromId) => moveBlock(fromId, block.id)} />)}</div>
              <button type="button" className="study-workspace__add-block" onClick={() => addBlock()}><Plus size={15} />Add a block</button>
            </div>
          </motion.section>}
        </AnimatePresence>
        {section === "document" ? <FloatingClyra open={assistantOpen} setOpen={setAssistantOpen} value={aiPrompt} setValue={setAiPrompt} onSubmit={() => { setAssistantOpen(false); generateWorkspace(); }} /> : null}
      </main>
      <AnimatePresence>{refreshWave ? <StudyRefreshWave reducedMotion={reducedMotion} /> : null}</AnimatePresence>
    </div>
  );
}

function SidebarPageRow({ item, active, child, folders, menuOpen, renaming, renameDraft, setRenameDraft, onOpen, onToggleMenu, onRename, onCommitRename, onMove, onDelete }: { item: WorkspacePage; active: boolean; child: boolean; folders: WorkspacePage[]; menuOpen: boolean; renaming: boolean; renameDraft: string; setRenameDraft: (value: string) => void; onOpen: () => void; onToggleMenu: () => void; onRename: () => void; onCommitRename: () => void; onMove: (id: string, parentId?: string) => void; onDelete: () => void }) {
  return <div className={cn("study-workspace__page-row", child && "is-child", menuOpen && "is-menu-open")}>
    <button type="button" className={cn("study-workspace__page-link", child && "is-child", active && "is-active")} onClick={onOpen}>{item.isFolder ? <Folder size={14} /> : child ? <ChevronRight size={12} /> : <span>{item.icon}</span>}{renaming ? <input autoFocus aria-label={`Rename ${item.title}`} value={renameDraft} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={onCommitRename} onKeyDown={(event) => { if (event.key === "Enter") onCommitRename(); if (event.key === "Escape") onCommitRename(); }} /> : <span>{item.title}</span>}</button>
    <button type="button" className="study-workspace__page-more" aria-label={`Manage ${item.title}`} onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}><MoreHorizontal size={14} /></button>
    <AnimatePresence>{menuOpen ? <motion.div className="study-workspace__page-menu" initial={{ opacity: 0, y: -3, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -2, scale: .98 }} transition={{ duration: .14, ease: [0.22, 1, .36, 1] }} onClick={(event) => event.stopPropagation()}><button type="button" onClick={onRename}>Rename</button>{item.parentId ? <button type="button" onClick={() => onMove(item.id)}>Move to Projects</button> : null}{folders.length ? <div><span>Move to folder</span>{folders.map((folder) => <button type="button" key={folder.id} onClick={() => onMove(item.id, folder.id)}>{folder.title}</button>)}</div> : null}<button type="button" className="is-danger" onClick={onDelete}>Delete</button></motion.div> : null}</AnimatePresence>
  </div>;
}

function viewMotion(reduced: boolean | null) { return reduced ? {} : { initial: { opacity: 0, y: 5 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -3 }, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } }; }

function StudyChat({ reducedMotion, entries, busy, step, sources, completed, value, setValue, onSubmit, error, onOpen }: { reducedMotion: boolean | null; entries: StudyChatEntry[]; busy: boolean; step: GenerationStep | null; sources: string[]; completed: { id: string; title: string } | null; value: string; setValue: (value: string) => void; onSubmit: () => void; error: string | null; onOpen: (id: string) => void }) {
  const labels: Record<Exclude<GenerationStep, "complete">, string> = { thinking: "Thinking", searching: "Searching the web", structuring: "Structuring the document", creating: "Creating your workspace" };
  return <motion.section key="study-chat" {...viewMotion(reducedMotion)} className={cn("study-chat", entries.length && "has-thread")}>
    <div className="study-chat__scroll">
      {entries.length === 0 ? <div className="study-chat__welcome"><span className="study-workspace__eyebrow"><Bot size={15} />Clyra AI</span><h1>What would you like to make?</h1><p>Describe the outcome, attach sources, or ask Clyra to research a topic. Your result becomes an editable document, calendar, planner, or workspace.</p><div className="study-chat__starter-row"><button type="button" onClick={() => setValue("Create a study calendar for ")}><CalendarDays size={15} />Study calendar</button><button type="button" onClick={() => setValue("Create a research report about ")}><FileSearch size={15} />Research report</button><button type="button" onClick={() => setValue("Build a project workspace for ")}><LayoutDashboard size={15} />Project workspace</button></div></div> : <div className="study-chat__thread">{entries.map((entry) => <motion.article key={entry.id} className={cn("study-chat__message", `is-${entry.role}`)} initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .2, ease: [0.22, 1, .36, 1] }}>{entry.role === "assistant" ? <div className="study-chat__assistant-mark"><Bot size={14} /></div> : null}<div><p>{entry.content.replace(/\*\*/g, "")}</p>{entry.sources?.length ? <div className="study-chat__sources">{entry.sources.slice(0, 4).map((source) => { let label = source; try { label = new URL(source).hostname.replace(/^www\./, ""); } catch { /* use source */ } return <span key={source}><Globe size={12} />{label}</span>; })}</div> : null}</div></motion.article>)}</div>}
      {busy && step && step !== "complete" ? <motion.div className="study-chat__activity" initial={reducedMotion ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}><span className="study-chat__activity-dot" /><ShiningText text={labels[step]} play className="text-[13px] font-medium" />{step === "searching" ? <small>Finding recent, relevant sources before drafting.</small> : step === "structuring" ? <small>Turning the brief into an editable document structure.</small> : step === "creating" ? <small>Writing the first version and its next actions.</small> : null}</motion.div> : null}
      {busy && generationSourcesPlaceholder(sources) ? <div className="study-chat__sources is-searching">{sources.slice(0, 4).map((source) => <span key={source}><Globe size={12} />{safeHostname(source)}</span>)}</div> : null}
      {completed ? <motion.div className="study-chat__complete" initial={reducedMotion ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}><span><Check size={15} /></span><div><strong>{completed.title} is ready</strong><small>Created as a fully editable Clyra document.</small></div><button type="button" onClick={() => onOpen(completed.id)}>Open document <ChevronRight size={14} /></button></motion.div> : null}
      {error ? <p className="study-workspace__ai-error" role="status">{error}</p> : null}
    </div>
    <div className="study-chat__composer"><Bot size={15} /><input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }} placeholder="Ask Clyra to create, research, or improve something…" /><button type="button" aria-label="Send to Clyra" disabled={!value.trim() || busy} onClick={onSubmit}>{busy ? <span className="study-workspace__mini-spinner" /> : <ArrowUp size={16} />}</button></div>
  </motion.section>;
}

function safeHostname(source: string) { try { return new URL(source).hostname.replace(/^www\./, ""); } catch { return source; } }
function generationSourcesPlaceholder(sources: string[]) { return sources.length > 0; }

/** A single local, top-edge pressure pass when Clyra hands a generated page
 * back to the editor. It never captures input or changes document geometry. */
function StudyRefreshWave({ reducedMotion }: { reducedMotion: boolean | null }) {
  if (reducedMotion) return <motion.div className="study-refresh-wave study-refresh-wave--reduced" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: .55 }} exit={{ opacity: 0 }} transition={{ duration: .18 }} />;
  const travel = { y: ["-14vh", "-4vh", "calc(100vh + 16vh)"], opacity: [1, 1, .92] };
  return <div className="study-refresh-wave" aria-hidden><motion.div className="study-refresh-wave__charge" initial={{ scaleX: .14, opacity: .1 }} animate={{ scaleX: [0.14, .56, 1], opacity: [0.12, .9, 0] }} transition={{ duration: .2, ease: [0.22, 1, .36, 1], times: [0, .8, 1] }} /><motion.div className="study-refresh-wave__crest" initial={{ y: "-14vh" }} animate={travel} transition={{ duration: 1.02, ease: [0.22, .75, .25, 1], times: [0, .18, 1] }} /><motion.div className="study-refresh-wave__recoil" initial={{ y: "-16vh", opacity: 0 }} animate={{ y: ["-16vh", "-2vh", "calc(100vh + 14vh)"], opacity: [0, .26, 0] }} transition={{ duration: .92, delay: .08, ease: [0.22, .75, .25, 1], times: [0, .22, 1] }} /></div>;
}

function HomeCanvas({ reducedMotion, sources, sourceMenuOpen, sourcePicker, sourceDraft, aiPrompt, setAiPrompt, setSourceMenuOpen, setSourcePicker, setSourceDraft, addSource, addLinkedSource, addSourceFromFile, removeSource, generateWorkspace, aiBusy, aiError, recentPages, openPage, setSection, openNotesType }: { reducedMotion: boolean | null; sources: Source[]; sourceMenuOpen: boolean; sourcePicker: Source["type"] | null; sourceDraft: string; aiPrompt: string; setAiPrompt: (value: string) => void; setSourceMenuOpen: (value: boolean) => void; setSourcePicker: (value: Source["type"] | null) => void; setSourceDraft: (value: string) => void; addSource: (type: Source["type"], title: string, body?: string) => void; addLinkedSource: (type: Extract<Source["type"], "YouTube" | "Website">, url: string) => void; addSourceFromFile: (file: File | undefined) => Promise<void>; removeSource: (id: string) => void; generateWorkspace: () => void; aiBusy: boolean; aiError: string | null; recentPages: WorkspacePage[]; openPage: (id: string) => void; setSection: (value: "ai" | "templates") => void; openNotesType: (title: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceIcon = (type: Source["type"]) => sourceActions.find((item) => item.type === type)?.icon || Paperclip;
  const actions = [["Notes", "Capture or structure ideas", BookOpen], ["Study Guide", "Turn sources into revision material", ListTodo], ["Document", "Create polished written work", FileText], ["Research", "Organise evidence and findings", FileSearch], ["Workspace", "Build a complete project hub", LayoutDashboard], ["Calendar", "Plan dates, deadlines and study", CalendarDays], ["Planner", "Create a daily, weekly or project plan", Clock]] as const;
  return <motion.section key="home" {...viewMotion(reducedMotion)} className="study-home">
    <div className="study-home__hero"><div className="study-workspace__eyebrow"><Bot size={14} />Clyra AI</div><h1>What are we working on?</h1><p>Create notes, turn sources into knowledge, or continue where you left off.</p>
      <div className="study-home__composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addSourceFromFile(event.dataTransfer.files[0]); }}>
        <div className="study-home__source-chips">{sources.map((source) => { const Icon = sourceIcon(source.type); return <span key={source.id} data-status={source.status}><Icon size={13} /><b>{source.title}</b>{source.status === "reading" ? <i>Reading…</i> : source.status === "error" ? <i title={source.detail}>Needs attention</i> : null}<button type="button" aria-label={`Remove ${source.title}`} onClick={() => removeSource(source.id)}><X size={11} /></button></span>; })}</div>
        <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); generateWorkspace(); } }} placeholder="Ask Clyra to create notes, a document, study guide, research page…" />
        <div className="study-home__composer-footer"><div className="study-home__source-control"><button type="button" onClick={() => setSourceMenuOpen(!sourceMenuOpen)}><Plus size={15} />Add sources</button><input ref={fileInputRef} type="file" className="sr-only" onChange={(event) => addSourceFromFile(event.target.files?.[0])} />
          <AnimatePresence>{sourceMenuOpen ? <motion.div className="study-home__source-menu" initial={{ opacity: 0, y: 4, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .985 }} transition={{ duration: .14, ease: [0.22, 1, .36, 1] }}>{sourcePicker ? <div className="study-home__source-entry"><strong>Add {sourcePicker}</strong><input autoFocus value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} placeholder={sourcePicker === "YouTube" || sourcePicker === "Website" ? "Paste a link…" : "Paste text or a title…"} onKeyDown={(event) => { if (event.key === "Enter") (sourcePicker === "YouTube" || sourcePicker === "Website") ? addLinkedSource(sourcePicker, sourceDraft) : addSource(sourcePicker, sourceDraft, sourceDraft); }} /><button type="button" onClick={() => (sourcePicker === "YouTube" || sourcePicker === "Website") ? addLinkedSource(sourcePicker, sourceDraft) : addSource(sourcePicker, sourceDraft, sourceDraft)}>Add</button></div> : <>{sourceActions.map(({ type, label, icon: Icon }) => <button type="button" key={type} onClick={() => (type === "Document" || type === "Image" || type === "Audio") ? fileInputRef.current?.click() : setSourcePicker(type)}><Icon size={15} /><span><strong>{label}</strong><small>{type === "YouTube" ? "Paste a video or playlist link" : type === "Website" ? "Add an article or webpage" : type === "Document" ? "PDF, DOCX, TXT and Markdown" : type === "Audio" ? "Lecture, meeting or voice recording" : "Screenshots, diagrams or notes"}</small></span></button>)}<button type="button" onClick={() => setSourcePicker("Text")}><Paperclip size={15} /><span><strong>Paste text</strong><small>Quickly add copied notes or source material</small></span></button></>}</motion.div> : null}</AnimatePresence>
        </div><span>⌘↵ to create</span><button type="button" aria-label="Create workspace" className="study-workspace__send" disabled={!aiPrompt.trim() || aiBusy} onClick={generateWorkspace}>{aiBusy ? <span className="study-workspace__mini-spinner" /> : <ChevronRight size={17} />}</button></div>
      </div>{aiError ? <p className="study-workspace__ai-error" role="status">{aiError}</p> : null}
      <div className="study-home__source-row">{sourceActions.map(({ type, label, icon: Icon }) => <button type="button" key={type} onClick={() => type === "Document" || type === "Audio" || type === "Image" ? fileInputRef.current?.click() : (setSourcePicker(type), setSourceMenuOpen(true))}>{type === "YouTube" ? <YouTubeBrandIcon className="h-3.5 w-3.5" /> : <Icon size={14} />}{label}</button>)}<button type="button" onClick={() => { setSourcePicker("Website"); setSourceMenuOpen(true); }}><GoogleProductIcon product="docs" className="h-3.5 w-3.5" />Google Docs</button><button type="button" onClick={() => { setAiPrompt("Create a calendar for "); }}><GoogleProductIcon product="calendar" className="h-3.5 w-3.5" />Calendar</button></div>
    </div>
    <div className="study-home__content"><div className="study-home__section-head"><h2>Create something</h2><span>Documents, plans and connected workspaces</span></div><div className="study-home__creation-grid">{actions.map(([title, description, Icon]) => <button type="button" key={title} onClick={() => title === "Notes" ? openNotesType("structured notes") : title === "Workspace" ? setSection("templates") : title === "Calendar" ? setAiPrompt("Create a study calendar for ") : title === "Planner" ? setAiPrompt("Create a weekly planner for ") : setAiPrompt(`Create a ${title.toLowerCase()} for `)}><Icon size={17} /><span><strong>{title}</strong><small>{description}</small></span><ChevronRight size={15} /></button>)}</div>
      {recentPages[0] ? <div className="study-home__continue"><div><span>Continue working</span><strong>{recentPages[0].title}</strong><small>{recentPages[0].blocks.find((block) => block.content)?.content || "Editable workspace"}</small></div><button type="button" onClick={() => openPage(recentPages[0].id)}>Continue <ChevronRight size={14} /></button></div> : null}
      <div className="study-home__section-head"><h2>Recent</h2><button type="button" onClick={() => setSection("templates")}>Browse templates <ChevronRight size={13} /></button></div><div className="study-home__recent-grid">{recentPages.slice(0, 4).map((recent) => <button type="button" key={recent.id} onClick={() => openPage(recent.id)}><span>{recent.icon}</span><strong>{recent.title}</strong><small>{recent.blocks.find((block) => block.content)?.content || "Empty page"}</small><em>Edited recently</em></button>)}</div>
    </div>
  </motion.section>;
}

function TemplateLibrary({ reducedMotion, query, setQuery, category, setCategory, style, setStyle, templates, previewTemplate, setPreviewTemplate, onUse, onCreateWithAI }: { reducedMotion: boolean | null; query: string; setQuery: (value: string) => void; category: "All" | TemplateDefinition["category"]; setCategory: (value: "All" | TemplateDefinition["category"]) => void; style: TemplateStyle; setStyle: (style: TemplateStyle) => void; templates: TemplateDefinition[]; previewTemplate: TemplateDefinition | null; setPreviewTemplate: (template: TemplateDefinition | null) => void; onUse: (template: TemplateDefinition, style?: TemplateStyle) => void; onCreateWithAI: () => void }) {
  const categories: Array<"All" | TemplateDefinition["category"]> = ["All", "Featured", "Notes", "Documents", "Resumes", "Calendars", "Planners", "Study", "Business", "Projects", "Dashboards", "Databases", "Trackers", "Forms", "Research", "Work", "Personal", "Creative", "AI"];
  const featured = templates.filter((template) => template.category === "Calendars" || template.category === "Study").slice(0, 3);
  return <motion.section key="templates" {...viewMotion(reducedMotion)} className="study-templates"><header><div><span className="study-workspace__eyebrow"><LayoutTemplate size={15} />Template Library</span><h1>Templates</h1><p>Start with a polished structure, then make it yours.</p></div><button type="button" className="study-templates__create" onClick={onCreateWithAI}><Bot size={15} />Create with AI</button></header><div className="study-templates__search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search resumes, calendars, notes, reports, planners…" /><button type="button" aria-label="Ask AI for a template" onClick={onCreateWithAI}><Bot size={16} /></button></div><div className="study-templates__tabs">{categories.map((item) => <button type="button" key={item} className={cn(item === category && "is-active")} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="study-templates__style"><span>Style</span>{(["minimal", "professional", "editorial", "academic", "paper", "dark", "soft", "creative"] as TemplateStyle[]).map((item) => <button type="button" key={item} className={cn(style === item && "is-active")} onClick={() => setStyle(item)}>{item}</button>)}</div>{!query && category === "All" ? <section className="study-templates__featured"><div><h2>Start with a focused system</h2><p>Three complete starting points for study, plans and deadlines.</p></div><div>{featured.map((template) => <button type="button" key={template.id} onClick={() => setPreviewTemplate(template)}><TemplateMini template={template} style={style} /><span><strong>{template.name}</strong><small>{template.description}</small></span><ChevronRight size={14} /></button>)}</div></section> : null}<div className="study-templates__grid">{templates.map((template) => <TemplateCard key={template.id} template={template} style={style} onPreview={() => setPreviewTemplate(template)} onUse={() => onUse(template, style)} />)}</div><AnimatePresence>{previewTemplate ? <TemplatePreview template={previewTemplate} style={style} setStyle={setStyle} onClose={() => setPreviewTemplate(null)} onUse={() => onUse(previewTemplate, style)} onCustomize={onCreateWithAI} /> : null}</AnimatePresence></motion.section>;
}

function TemplateCard({ template, style, onPreview, onUse }: { template: TemplateDefinition; style: TemplateStyle; onPreview: () => void; onUse: () => void }) { return <article className="study-template-card"><TemplateMini template={template} style={style} /><div><strong>{template.name}</strong><p>{template.description}</p><small>{template.tags.join(" · ")}</small></div><footer><button type="button" onClick={onPreview}>Preview</button><button type="button" onClick={onUse}>Use template <ChevronRight size={13} /></button></footer></article>; }
function TemplateMini({ template, style }: { template: TemplateDefinition; style: TemplateStyle }) {
  const hasCalendar = template.blocks.some((block) => block.kind === "calendar");
  const isCornell = template.id === "cornell";
  const isDashboard = template.id === "student-dashboard" || template.id === "study-hub";
  const isResume = template.category === "Resumes";
  return <div className={cn("study-template-mini", `is-${style}`, hasCalendar && "has-calendar", isCornell && "is-cornell", isDashboard && "is-dashboard", isResume && "is-resume")}>{hasCalendar ? <><div className="study-template-mini__calendar-head"><span>{template.name}</span><i>August</i></div><div className="study-template-mini__calendar-grid">{Array.from({ length: 28 }, (_, index) => <i key={index} className={cn(index === 4 || index === 12 || index === 19 ? "is-event" : "")}>{index % 7 === 0 ? index / 7 + 1 : ""}</i>)}</div><div className="study-template-mini__agenda"><span /><span /><span /></div></> : isCornell ? <><div className="study-template-mini__cornell"><aside>Cues<br />Maximum flow<br />Minimum cut<br />Capacity</aside><main><strong>Network Flow</strong><i>Maximum flow is the greatest quantity that can travel from a source to sink through a constrained network.</i><i>The maximum flow equals the capacity of the minimum cut.</i></main></div><div className="study-template-mini__cornell-summary">Summary · Find augmenting paths until none remain.</div></> : isResume ? <div className="study-template-mini__resume"><aside><b>AM</b><i>CONTACT</i><i>SKILLS</i><i>EDUCATION</i></aside><main><strong>Alex Morgan</strong><small>Product designer</small><b>Experience</b><i>Senior Product Designer · 2023—Present</i><i>Led product work across research and delivery.</i></main></div> : <>{template.blocks.slice(0, 5).map((block, index) => <div className={`is-${block.kind}`} key={`${block.kind}-${index}`}><span>{block.kind === "todo" ? "□" : block.kind === "callout" ? "·" : ""}</span><i>{block.content || ""}</i></div>)}</>}</div>;
}
function TemplatePreview({ template, style, setStyle, onClose, onUse, onCustomize }: { template: TemplateDefinition; style: TemplateStyle; setStyle: (style: TemplateStyle) => void; onClose: () => void; onUse: () => void; onCustomize: () => void }) { return <motion.div className="study-template-modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}><motion.div initial={{ opacity: 0, scale: .985, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .985, y: 8 }} transition={{ duration: .2, ease: [0.22, 1, .36, 1] }} onClick={(event) => event.stopPropagation()}><button type="button" className="study-template-modal__close" aria-label="Close template preview" onClick={onClose}><X size={17} /></button><div className="study-template-modal__preview"><TemplateMini template={template} style={style} /></div><aside><span className="study-workspace__eyebrow">{template.category}</span><h2>{template.name}</h2><p>{template.description}</p><dl><div><dt>Best for</dt><dd>{template.tags.join(" · ")}</dd></div><div><dt>Includes</dt><dd>{template.blocks.length} editable blocks</dd></div></dl><label>Style<select value={style} onChange={(event) => setStyle(event.target.value as TemplateStyle)}>{(["minimal", "professional", "editorial", "academic", "paper", "dark", "soft", "creative", "flat", "glass", "spatial", "monochrome"] as TemplateStyle[]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label><button type="button" className="study-template-modal__primary" onClick={onUse}>Use template</button><button type="button" className="study-template-modal__secondary" onClick={onCustomize}>Customize with AI</button></aside></motion.div></motion.div>; }

function FloatingClyra({ open, setOpen, value, setValue, onSubmit }: { open: boolean; setOpen: (open: boolean) => void; value: string; setValue: (value: string) => void; onSubmit: () => void }) {
  const collapseTimer = useRef<number | null>(null);
  const cancelCollapse = () => { if (collapseTimer.current !== null) { window.clearTimeout(collapseTimer.current); collapseTimer.current = null; } };
  const collapseSoon = () => {
    cancelCollapse();
    // Preserve the user’s pointer path from the compact mark into the input.
    collapseTimer.current = window.setTimeout(() => { if (!value.trim()) setOpen(false); }, 420);
  };
  useEffect(() => () => cancelCollapse(), []);
  return <motion.div className={cn("study-floating-clyra", open && "is-open")} layout transition={{ type: "spring", bounce: 0, duration: .28 }} onMouseEnter={() => { cancelCollapse(); setOpen(true); }} onMouseLeave={collapseSoon} onFocus={() => { cancelCollapse(); setOpen(true); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) collapseSoon(); }}><AnimatePresence initial={false}>{open ? <motion.div initial={{ opacity: 0, width: 42 }} animate={{ opacity: 1, width: 390 }} exit={{ opacity: 0, width: 42 }} transition={{ duration: .18, ease: [0.22, 1, .36, 1] }}><Bot size={15} /><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (value.trim()) onSubmit(); } if (event.key === "Escape") setOpen(false); }} placeholder="Ask Clyra about this page…" /><button type="button" aria-label="Ask Clyra" disabled={!value.trim()} onClick={onSubmit}><ChevronRight size={15} /></button></motion.div> : <button type="button" aria-label="Open Clyra" onClick={() => setOpen(true)}><Bot size={17} /></button>}</AnimatePresence></motion.div>;
}

function BlockRow({ block, paletteOpen, slashOpen, slashQuery, onPalette, onSlash, onCommand, onChange, onDelete, onAdd, dragId, setDragId, onDrop }: { block: WorkspaceBlock; paletteOpen: boolean; slashOpen: boolean; slashQuery: string; onPalette: (event: MouseEvent<HTMLButtonElement>) => void; onSlash: (value: string | null) => void; onCommand: (command: (typeof slashCommands)[number]) => void; onChange: (patch: Partial<WorkspaceBlock>) => void; onDelete: () => void; onAdd: (kind: BlockKind) => void; dragId: string | null; setDragId: (id: string | null) => void; onDrop: (id: string) => void }) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const matchingCommands = slashCommands.filter((command) => `${command.label} ${command.description} ${command.id} ${(command.aliases || []).join(" ")}`.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 7);
  const common = { value: block.content, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { const value = event.target.value; onChange({ content: value }); if (value.startsWith("/")) onSlash(value.slice(1)); else onSlash(null); }, onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (slashOpen && event.key === "Escape") { event.preventDefault(); onSlash(null); return; } if (slashOpen && event.key === "Enter" && matchingCommands[0]) { event.preventDefault(); onCommand(matchingCommands[0]); return; } if (event.key === "Enter" && !event.shiftKey && block.kind !== "code") { event.preventDefault(); onAdd("text"); } if (event.key === "Backspace" && !block.content) onDelete(); } };
  return <div className={cn("study-workspace__block", `is-${block.kind}`, dragId === block.id && "is-dragging")} draggable onDragStart={() => setDragId(block.id)} onDragEnd={() => setDragId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => dragId && onDrop(dragId)}>
    <button type="button" className="study-workspace__handle" onClick={onPalette} aria-label={`Change ${blockLabel(block.kind)} block`}><span>⠿</span></button>
    {block.kind === "todo" ? <label><input type="checkbox" checked={Boolean(block.checked)} onChange={(event) => onChange({ checked: event.target.checked })} /><input ref={inputRef as RefObject<HTMLInputElement>} {...common} placeholder="To-do" /></label> : block.kind === "calendar" ? <CalendarBlock block={block} onChange={onChange} /> : block.kind === "divider" ? <button type="button" className="study-workspace__divider" onClick={onPalette} aria-label="Change divider block" /> : block.kind === "code" ? <textarea ref={inputRef as RefObject<HTMLTextAreaElement>} {...common} placeholder="Write code…" spellCheck={false} /> : <input ref={inputRef as RefObject<HTMLInputElement>} {...common} placeholder={block.kind === "heading" ? "Heading" : block.kind === "callout" ? "A useful note…" : "Write something…"} />}
    <AnimatePresence>{slashOpen ? <motion.div className="study-workspace__slash-menu" initial={{ opacity: 0, y: 4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 2, scale: .98 }} transition={{ duration: .13, ease: [0.22, 1, .36, 1] }}><span>Suggested</span>{matchingCommands.map((command) => <button type="button" key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onCommand(command)}><span><strong>{command.label}</strong><small>{command.description}</small></span><ChevronRight size={13} /></button>)}</motion.div> : null}{paletteOpen ? <motion.div className="study-workspace__block-menu" initial={{ opacity: 0, y: 4, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 2, scale: .985 }} transition={{ duration: .15, ease: [0.22, 1, .36, 1] }} onClick={(event) => event.stopPropagation()}>{commandKinds.map((item) => <button type="button" key={item.kind} onClick={(event) => { onChange({ kind: item.kind, content: item.kind === "divider" ? "" : block.content }); onPalette(event); }}><span><strong>{item.label}</strong><small>{item.hint}</small></span>{item.kind === block.kind ? <span className="study-workspace__menu-check">✓</span> : null}</button>)}<button type="button" className="is-danger" onClick={onDelete}><span><strong>Delete</strong><small>Remove this block</small></span><X size={14} /></button></motion.div> : null}</AnimatePresence>
  </div>;
}

function CalendarBlock({ block, onChange }: { block: WorkspaceBlock; onChange: (patch: Partial<WorkspaceBlock>) => void }) {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const padding = (month.getDay() + 6) % 7;
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const selected = new Set(block.dates || []);
  const label = month.toLocaleString(undefined, { month: "long", year: "numeric" });
  return <div className="study-workspace__calendar" aria-label={block.content || "Calendar"}><header><span><CalendarDays size={15} />{block.content || "Monthly plan"}</span><small>{label}</small></header><div className="study-workspace__calendar-weekdays">{"MTWTFSS".split("").map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="study-workspace__calendar-grid">{Array.from({ length: padding }, (_, index) => <i key={`pad-${index}`} />)}{Array.from({ length: days }, (_, index) => { const day = String(index + 1); const active = selected.has(day); return <button type="button" key={day} className={cn(active && "is-selected")} aria-pressed={active} onClick={() => { const dates = active ? (block.dates || []).filter((value) => value !== day) : [...(block.dates || []), day]; onChange({ dates }); }}>{day}</button>; })}</div><small className="study-workspace__calendar-hint">Select dates to mark your plan.</small></div>;
}
