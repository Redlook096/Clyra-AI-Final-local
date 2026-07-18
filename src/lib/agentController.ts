export type AgentControllerState =
  | "queued"
  | "planning"
  | "inspecting"
  | "acting"
  | "waiting"
  | "verifying"
  | "recovering"
  | "needs_approval"
  | "paused_by_user"
  | "user_controlling"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentActionType =
  | "inspect_page"
  | "inspect_region"
  | "inspect_element"
  | "move_cursor"
  | "click"
  | "double_click"
  | "right_click"
  | "hover"
  | "focus"
  | "type_text"
  | "replace_text"
  | "press_key"
  | "press_shortcut"
  | "select_option"
  | "toggle_control"
  | "scroll_page"
  | "scroll_element"
  | "scroll_into_view"
  | "drag_and_drop"
  | "resize_panel"
  | "upload_file"
  | "download_file"
  | "open_menu"
  | "close_modal"
  | "navigate"
  | "go_back"
  | "go_forward"
  | "reload"
  | "open_tab"
  | "close_tab"
  | "switch_tab"
  | "wait_for_element"
  | "wait_for_state"
  | "wait_for_navigation"
  | "wait_for_build"
  | "read_notification"
  | "capture_screenshot"
  | "verify_condition";

export type AgentPlanStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "complete" | "blocked";
};

export type AgentCursorPosition = {
  x: number;
  y: number;
  label: string;
  clicking?: boolean;
};

export type AgentActionRecord = {
  id: string;
  type: AgentActionType;
  target: string;
  resolvedTarget?: string;
  expected: string;
  actual?: string;
  verified?: boolean;
  retry: number;
  timestamp: number;
  durationMs?: number;
};

export type AgentControllerTask = {
  id: string;
  workspaceId: string;
  projectId?: string;
  prompt: string;
  state: AgentControllerState;
  currentAction: string;
  plan: AgentPlanStep[];
  currentStep: number;
  actions: AgentActionRecord[];
  activity: string[];
  startedAt: number;
  updatedAt: number;
  completionEvidence?: string[];
  error?: string;
  manualControl?: boolean;
};

export type AgentControl = {
  id: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  value: string;
  enabled: boolean;
  selected: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  parentRegion: string;
  actions: string[];
};

export type AgentBridgeSnapshot = {
  route: string;
  workspace: string;
  activeTab?: string;
  projectId?: string;
  projectName?: string;
  buildStatus?: string;
  previewReady?: boolean;
  loading: boolean;
  notifications: string[];
  errors: string[];
  controls: AgentControl[];
  scroll: { x: number; y: number; width: number; height: number };
  capturedAt: number;
};

export type AgentBridge = {
  snapshot: () => AgentBridgeSnapshot;
};

declare global {
  interface Window {
    __CLYRA_AGENT_BRIDGE__?: AgentBridge;
  }
}

const STORAGE_KEY = "clyra-agent-controller-tasks-v1";

function storage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function taskKey(messageId: string, agentId: string) {
  return `${messageId}:${agentId}`;
}

export function readAgentTask(key: string): AgentControllerTask | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const tasks = JSON.parse(raw) as Record<string, AgentControllerTask>;
    return tasks[key] ?? null;
  } catch {
    return null;
  }
}

export function persistAgentTask(key: string, task: AgentControllerTask) {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const tasks = raw ? (JSON.parse(raw) as Record<string, AgentControllerTask>) : {};
    tasks[key] = { ...task, updatedAt: Date.now() };
    storage()?.setItem(STORAGE_KEY, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("clyra-agent-task-change", { detail: { key, task: tasks[key] } }));
  } catch {
    // Persistence improves recovery, but unavailable browser storage must not stop control.
  }
}

export function createAgentTask(id: string, workspaceId: string, prompt: string): AgentControllerTask {
  return {
    id,
    workspaceId,
    prompt,
    state: "queued",
    currentAction: "Queued",
    plan: [
      { id: "open", label: "Open Vibe Coder", status: "active" },
      { id: "request", label: "Enter the project request", status: "pending" },
      { id: "build", label: "Start and monitor the build", status: "pending" },
      { id: "preview", label: "Review the live preview", status: "pending" },
      { id: "verify", label: "Verify the result", status: "pending" },
      { id: "save", label: "Save the project", status: "pending" },
    ],
    currentStep: 0,
    actions: [],
    activity: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function updateTaskStep(task: AgentControllerTask, stepId: string, status: AgentPlanStep["status"]) {
  const plan = task.plan.map((step) => step.id === stepId ? { ...step, status } : step);
  const currentStep = Math.max(0, plan.findIndex((step) => step.status === "active"));
  return { ...task, plan, currentStep };
}

export function describeControls(root: Document): AgentControl[] {
  const selector = [
    "[data-agent-id]",
    "[data-testid]",
    "button",
    "input",
    "textarea",
    "select",
    "[role=button]",
    "[role=tab]",
    "[role=menuitem]",
    "[contenteditable=true]",
  ].join(",");
  const seen = new Set<Element>();
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    })
    .slice(0, 140)
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const sensitive = input instanceof HTMLInputElement && input.type === "password";
      const name = element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent?.trim().slice(0, 120) || "";
      return {
        id: element.dataset.agentId || element.dataset.testid || `control-${index}`,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        name,
        text: element.textContent?.trim().slice(0, 180) || "",
        placeholder: "placeholder" in input ? input.placeholder || "" : "",
        value: "value" in input ? (sensitive ? "[redacted]" : String(input.value || "")) : "",
        enabled: !("disabled" in input && input.disabled) && element.getAttribute("aria-disabled") !== "true",
        selected: element.getAttribute("aria-selected") === "true" || ("checked" in input && Boolean(input.checked)),
        visible: true,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        parentRegion: element.closest("[aria-label], main, section, form")?.getAttribute("aria-label") || element.closest("main, section, form")?.tagName.toLowerCase() || "",
        actions: ["focus", "click", "scroll_into_view"],
      };
    });
}
