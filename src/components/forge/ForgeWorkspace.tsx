import {
  Activity,
  AudioLines,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Code2,
  Component,
  Cuboid,
  FolderOpen,
  Gamepad2,
  Gauge,
  Grid3X3,
  Layers3,
  Lightbulb,
  MousePointer2,
  Move3D,
  Pause,
  Play,
  Plus,
  Redo2,
  Rotate3D,
  Search,
  Sparkles,
  SquareDashedMousePointer,
  StopCircle,
  TerminalSquare,
  Trash2,
  Undo2,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
loader.config({ monaco });
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/utils";
import { AiOrb } from "../AiOrb";
import { createPersistedForgeProject, forgeExportUrl, loadForgeFiles, runForgeAgent, saveForgeFile } from "./api";
import { Forge2DViewport } from "./Forge2DViewport";
import { Forge3DViewport } from "./Forge3DViewport";
import { buildForgeSourceFiles, manifestFromPrompt, type ForgeSourceFile } from "./projectGenerator";
import {
  activeScene,
  buildSemanticScene,
  cloneProject,
  createStarterProject,
  getRenderTelemetry,
  validateScene,
  type ForgeEntity,
  type ForgeMode,
  type ForgeProject,
  type ForgeReport,
  type ForgeRuntimeState,
} from "./model";

type LeftTab = "hierarchy" | "scenes" | "assets";
type BottomTab = "assets" | "ai" | "code" | "console" | "animation" | "audio" | "profiler";
type ForgeTool = "select" | "move" | "rotate" | "scale" | "tile" | "collision" | "path" | "trigger" | "camera";

type ForgeActivity = {
  id: string;
  label: string;
  detail?: string;
  state: "active" | "complete" | "warning";
};

const templates: Array<{ name: string; detail: string; mode: ForgeMode; className: string }> = [
  { name: "Rooftop Platformer", detail: "Movement, checkpoints, drone patrol", mode: "2d", className: "is-rooftop" },
  { name: "Top-down Adventure", detail: "Interaction, inventory, navigation", mode: "2d", className: "is-topdown" },
  { name: "Atmospheric Horror", detail: "First-person controller, light, doors", mode: "3d", className: "is-horror" },
  { name: "Coastal Exploration", detail: "Terrain, modular village, water", mode: "3d", className: "is-coastal" },
];

const toolItems: Array<{ id: ForgeTool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "move", label: "Move", icon: Move3D },
  { id: "rotate", label: "Rotate", icon: Rotate3D },
  { id: "scale", label: "Scale", icon: Box },
];

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function entityIcon(kind: ForgeEntity["kind"]) {
  if (kind === "character") return Gamepad2;
  if (kind === "platform") return Layers3;
  if (kind === "enemy") return Component;
  if (kind === "camera") return CirclePlay;
  if (kind === "light") return Lightbulb;
  if (kind === "trigger") return SquareDashedMousePointer;
  return Cuboid;
}

function ForgeWelcome({ onCreate }: { onCreate: (prompt: string, mode?: ForgeMode) => void }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ForgeMode>("2d");
  const submit = () => onCreate(prompt.trim() || (mode === "2d" ? "A stylised 2D platformer set on rooftops at night" : "A low-poly coastal exploration game"), mode);
  return (
    <div className="forge-welcome">
      <div className="forge-welcome__identity"><span><Gamepad2 size={16} /></span>Clyra Forge</div>
      <div className="forge-welcome__hero">
        <h1>Build a world.</h1>
        <span>Describe a game, mechanic, level, or world.</span>
      </div>
      <div className="forge-welcome__composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Describe your game…"
          aria-label="Describe your game"
        />
        <div>
          <div className="forge-welcome__modes" aria-label="Game dimensions">
            {(["2d", "3d"] as const).map((item) => <button key={item} type="button" className={mode === item ? "is-active" : ""} onClick={() => setMode(item)}>{item.toUpperCase()}</button>)}
          </div>
          <button type="button" className="forge-primary-button" onClick={submit}>Create <ChevronRight size={15} /></button>
        </div>
      </div>
      <section className="forge-welcome__templates">
        <header><div><strong>Playable templates</strong><span>Start from an editable source project</span></div></header>
        <div>
          {templates.map((template) => (
            <button key={template.name} type="button" onClick={() => onCreate(`Create a ${template.name.toLowerCase()}`, template.mode)}>
              <span className={cn("forge-template-preview", template.className)}><i /><i /><i /><i /></span>
              <strong>{template.name}</strong>
              <small>{template.detail}</small>
              <em>{template.mode.toUpperCase()}</em>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ForgeViewport({
  project,
  selectedId,
  tool,
  runtime,
  onSelect,
  onMove,
}: {
  project: ForgeProject;
  selectedId: string | null;
  tool: ForgeTool;
  runtime: ForgeRuntimeState;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const scene = activeScene(project);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const toWorld = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width * scene.width,
      y: (event.clientY - rect.top) / rect.height * scene.height,
    };
  }, [scene.height, scene.width]);
  const begin = (event: ReactPointerEvent<SVGElement>, entity: ForgeEntity) => {
    event.stopPropagation();
    onSelect(entity.id);
    if ((tool === "select" || tool === "move") && !entity.locked && runtime !== "playing") {
      const root = svgRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width * scene.width;
      const y = (event.clientY - rect.top) / rect.height * scene.height;
      dragRef.current = { id: entity.id, offsetX: x - entity.transform.position.x, offsetY: y - entity.transform.position.y };
      root.setPointerCapture(event.pointerId);
    }
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toWorld(event);
    onMove(drag.id, Math.round((point.x - drag.offsetX) / 8) * 8, Math.round((point.y - drag.offsetY) / 8) * 8);
  };
  const end = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <svg
      ref={svgRef}
      className={cn("forge-viewport", project.mode === "3d" && "is-3d")}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={() => onSelect(null)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      aria-label={`${scene.name} visual editor`}
    >
      <defs>
        <linearGradient id="forge-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={scene.background} /><stop offset="1" stopColor={project.mode === "3d" ? "#dce6e8" : "#243a5d"} /></linearGradient>
        <filter id="forge-glow"><feGaussianBlur stdDeviation="9" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <pattern id="forge-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(255,255,255,.065)" strokeWidth="1" /></pattern>
      </defs>
      <rect width={scene.width} height={scene.height} fill="url(#forge-sky)" />
      <rect width={scene.width} height={scene.height} fill="url(#forge-grid)" />
      {project.mode === "3d" ? <path d="M 0 560 L 640 340 L 1280 560 L 1280 720 L 0 720 Z" fill="rgba(255,255,255,.13)" /> : null}
      {scene.entities.filter((entity) => entity.visible && entity.kind !== "camera").map((entity) => {
        const selected = entity.id === selectedId;
        const x = entity.transform.position.x - entity.size.x / 2;
        const y = entity.transform.position.y - entity.size.y / 2;
        if (project.mode === "3d" && entity.kind === "platform") {
          const depth = Math.min(92, Math.max(24, entity.size.z * 0.18));
          return (
            <g key={entity.id} onPointerDown={(event) => begin(event, entity)} className="forge-entity">
              <path d={`M ${x} ${y + depth} L ${x + entity.size.x} ${y} L ${x + entity.size.x} ${y + entity.size.y} L ${x} ${y + entity.size.y + depth} Z`} fill={entity.color} opacity=".88" />
              <path d={`M ${x} ${y + depth} L ${x + depth} ${y} L ${x + entity.size.x} ${y} L ${x + entity.size.x - depth} ${y + depth} Z`} fill="rgba(255,255,255,.25)" />
              {selected ? <rect x={x - 8} y={y - 8} width={entity.size.x + 16} height={entity.size.y + depth + 16} rx="8" fill="none" stroke="#69a7ff" strokeWidth="3" strokeDasharray="9 7" /> : null}
            </g>
          );
        }
        return (
          <g key={entity.id} onPointerDown={(event) => begin(event, entity)} className={cn("forge-entity", runtime === "playing" && entity.kind === "character" && "is-running")}>
            {entity.kind === "light" ? <circle cx={entity.transform.position.x} cy={entity.transform.position.y} r="80" fill={entity.color} opacity=".12" filter="url(#forge-glow)" /> : null}
            {entity.kind === "enemy" ? (
              <><ellipse cx={entity.transform.position.x} cy={entity.transform.position.y} rx={entity.size.x / 2} ry={entity.size.y / 2} fill={entity.color} /><circle cx={entity.transform.position.x} cy={entity.transform.position.y} r="6" fill="#eaf4ff" /></>
            ) : entity.kind === "trigger" ? (
              <rect x={x} y={y} width={entity.size.x} height={entity.size.y} rx="8" fill="rgba(102,213,196,.15)" stroke={entity.color} strokeWidth="3" strokeDasharray="8 7" />
            ) : entity.kind === "light" ? (
              <circle cx={entity.transform.position.x} cy={entity.transform.position.y} r={entity.size.x / 2} fill={entity.color} />
            ) : (
              <rect x={x} y={y} width={entity.size.x} height={entity.size.y} rx={entity.kind === "character" ? 15 : 8} fill={entity.color} />
            )}
            {selected ? <rect x={x - 8} y={y - 8} width={entity.size.x + 16} height={entity.size.y + 16} rx="8" fill="none" stroke="#69a7ff" strokeWidth="3" strokeDasharray="9 7" /> : null}
          </g>
        );
      })}
      {runtime !== "stopped" ? <text x="24" y="690" fill="rgba(255,255,255,.78)" fontSize="18" fontFamily="system-ui">Runtime · {runtime}</text> : null}
    </svg>
  );
}

function ReportView({ report }: { report: ForgeReport }) {
  return <div className={cn("forge-report", report.passed ? "is-pass" : "is-warning")}>
    <span>{report.passed ? <Check size={14} /> : <Activity size={14} />}</span>
    <div><strong>{report.title}</strong><p>{report.summary}</p>{report.warnings.map((warning) => <small key={warning}>{warning}</small>)}</div>
  </div>;
}

function ForgeBuildChat({ prompt, activities, error, onCancel }: { prompt: string; activities: ForgeActivity[]; error: string | null; onCancel: () => void }) {
  return (
    <div className="forge-build-chat">
      <header><div className="forge-welcome__identity"><span><Gamepad2 size={15} /></span>Clyra Forge</div><button type="button" onClick={onCancel}>Cancel</button></header>
      <main>
        <div className="forge-build-chat__user"><small>You</small><p>{prompt}</p></div>
        <div className="forge-build-chat__assistant">
          <AiOrb state={error ? "error" : "thinking"} className="forge-build-chat__orb" />
          <div>
            <strong>{error ? "Build stopped" : "Building first playable"}</strong>
            <div className="forge-build-chat__stream">
              {activities.map((activity) => <div key={activity.id} className={cn("forge-build-chat__row", `is-${activity.state}`)}><span>{activity.state === "complete" ? <Check size={13} /> : activity.state === "warning" ? <Activity size={13} /> : <span className="forge-build-chat__pulse" />}</span><div><b>{activity.label}</b>{activity.detail ? <small>{activity.detail}</small> : null}</div></div>)}
            </div>
            {error ? <p className="forge-build-chat__error">{error}</p> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function ForgeWorkspace() {
  const reduceMotion = useReducedMotion();
  const [project, setProject] = useState<ForgeProject | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("hierarchy");
  const [bottomTab, setBottomTab] = useState<BottomTab>("ai");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [tool, setTool] = useState<ForgeTool>("select");
  const [runtime, setRuntime] = useState<ForgeRuntimeState>("stopped");
  const [command, setCommand] = useState("");
  const [activities, setActivities] = useState<ForgeActivity[]>([]);
  const [history, setHistory] = useState<ForgeProject[]>([]);
  const [future, setFuture] = useState<ForgeProject[]>([]);
  const [buildPrompt, setBuildPrompt] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<ForgeSourceFile[]>([]);
  const [activeFile, setActiveFile] = useState("src/main.ts");
  const [savingFile, setSavingFile] = useState(false);

  const scene = project ? activeScene(project) : null;
  const selected = scene?.entities.find((entity) => entity.id === selectedId) ?? null;
  const telemetry = useMemo(() => scene ? getRenderTelemetry(scene) : null, [scene]);
  const validation = useMemo(() => scene ? validateScene(scene) : null, [scene]);
  const semantic = useMemo(() => scene ? buildSemanticScene(scene) : "", [scene]);

  const create = async (prompt: string, mode: ForgeMode = "2d") => {
    const manifest = manifestFromPrompt(prompt, mode);
    const next = createStarterProject(prompt, manifest.mode);
    next.name = manifest.title;
    next.artStyle.name = manifest.artStyle;
    const files = buildForgeSourceFiles(next, prompt, manifest);
    setBuildPrompt(prompt);
    setBuildError(null);
    setProject(null);
    setActivities([{ id: "understand", label: "Understanding game", detail: `${manifest.genre} · ${manifest.mode.toUpperCase()}`, state: "complete" }, { id: "project", label: "Creating source project", state: "active" }]);
    try {
      const persisted = await createPersistedForgeProject(next.name, prompt, files, (file, index) => {
        setActivities((items) => {
          const withoutActiveFile = items.filter((item) => item.id !== "file");
          return [...withoutActiveFile.map((item) => item.id === "project" ? { ...item, state: "complete" as const } : item), {
            id: "file",
            label: index === files.length - 1 ? "Created game source" : `Writing ${file.path}`,
            detail: `${index + 1} / ${files.length} files`,
            state: index === files.length - 1 ? "complete" : "active",
          }];
        });
      });
      const validationResult = validateScene(next.scenes[0]);
      setActivities((items) => [...items, { id: "validate", label: validationResult.passed ? "Traversal validation passed" : "Validation found issues", detail: validationResult.summary, state: validationResult.passed ? "complete" : "warning" }, { id: "ready", label: "First playable ready", detail: "Opening the editor", state: "complete" }]);
      setSourceProjectId(persisted.project.id);
      setSourceFiles(files);
      setActiveFile("src/main.ts");
      setHistory([]);
      setFuture([]);
      setSelectedId("player");
      setProject(next);
      setBuildPrompt(null);
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Forge could not create the source project");
      setActivities((items) => items.map((item) => item.state === "active" ? { ...item, state: "warning" } : item));
    }
  };

  const commit = useCallback((producer: (draft: ForgeProject) => void) => {
    setProject((current) => {
      if (!current) return current;
      const before = cloneProject(current);
      const next = cloneProject(current);
      producer(next);
      setHistory((items) => [...items.slice(-39), before]);
      setFuture([]);
      return next;
    });
  }, []);

  const undo = () => {
    if (!history.length || !project) return;
    const previous = history[history.length - 1];
    setFuture((items) => [cloneProject(project), ...items]);
    setHistory((items) => items.slice(0, -1));
    setProject(previous);
  };
  const redo = () => {
    if (!future.length || !project) return;
    const next = future[0];
    setHistory((items) => [...items, cloneProject(project)]);
    setFuture((items) => items.slice(1));
    setProject(next);
  };

  const updateSelectedTransform = (axis: "x" | "y" | "z", value: number) => {
    if (!selectedId) return;
    commit((draft) => {
      const entity = activeScene(draft).entities.find((item) => item.id === selectedId);
      if (entity) entity.transform.position[axis] = value;
    });
  };

  const moveEntity = (id: string, x: number, y: number) => {
    setProject((current) => {
      if (!current) return current;
      const next = cloneProject(current);
      const entity = activeScene(next).entities.find((item) => item.id === id);
      if (entity) entity.transform.position = { ...entity.transform.position, x, y };
      return next;
    });
  };

  const transformEntity = (id: string, transform: ForgeEntity["transform"]) => {
    setProject((current) => {
      if (!current) return current;
      const next = cloneProject(current);
      const entity = activeScene(next).entities.find((item) => item.id === id);
      if (entity) entity.transform = structuredClone(transform);
      return next;
    });
  };

  const updateSourceFile = (path: string, content: string) => {
    setSourceFiles((files) => files.map((file) => file.path === path ? { ...file, content } : file));
  };

  const persistActiveFile = async () => {
    if (!sourceProjectId) return;
    const file = sourceFiles.find((item) => item.path === activeFile);
    if (!file) return;
    setSavingFile(true);
    try {
      await saveForgeFile(sourceProjectId, file);
    } finally {
      setSavingFile(false);
    }
  };

  const addEntity = () => {
    if (!project) return;
    const id = `prop-${crypto.randomUUID()}`;
    commit((draft) => activeScene(draft).entities.push({
      id,
      name: "New Prop",
      kind: "prop",
      transform: { position: { x: 640, y: 380, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      size: { x: 72, y: 72, z: 72 },
      color: "#8ea3b7",
      visible: true,
      components: [],
    }));
    setSelectedId(id);
  };

  const addScene = () => {
    if (!project) return;
    const id = `scene-${crypto.randomUUID()}`;
    commit((draft) => {
      const source = activeScene(draft);
      draft.scenes.push({ ...structuredClone(source), id, name: `Scene_${draft.scenes.length + 1}`, entities: [] });
      draft.activeSceneId = id;
    });
    setSelectedId(null);
  };

  const addComponent = () => {
    if (!selectedId) return;
    commit((draft) => {
      const entity = activeScene(draft).entities.find((item) => item.id === selectedId);
      if (entity) entity.components.push({ id: `script-${crypto.randomUUID()}`, type: "Script", enabled: true, properties: { entry: `${entity.name.replace(/\s+/g, "")}Controller.ts` } });
    });
  };

  const removeSelected = () => {
    if (!selectedId || selected?.locked) return;
    commit((draft) => {
      const draftScene = activeScene(draft);
      draftScene.entities = draftScene.entities.filter((item) => item.id !== selectedId);
    });
    setSelectedId(null);
  };

  const runCommand = async () => {
    if (!project || !sourceProjectId || !command.trim()) return;
    const request = command.trim();
    const activityId = crypto.randomUUID();
    setActivities((items) => [...items, { id: activityId, label: "Starting Clyra agent", detail: request, state: "active" }]);
    setCommand("");
    try {
      const session = await runForgeAgent(sourceProjectId, request);
      setActivities((items) => items.map((item) => item.id === activityId ? { ...item, label: "Clyra agent working", detail: `Session ${session.id.slice(0, 8)} · source changes stream through Vibe Coder`, state: "complete" } : item));
      window.setTimeout(() => {
        void loadForgeFiles(sourceProjectId).then((files) => setSourceFiles(files)).catch(() => undefined);
      }, 2_500);
    } catch (error) {
      setActivities((items) => items.map((item) => item.id === activityId ? { ...item, label: "Agent could not start", detail: error instanceof Error ? error.message : "OpenCode runtime unavailable", state: "warning" } : item));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) removeSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!project || !sourceProjectId) return;
    const timer = window.setTimeout(() => {
      const content = JSON.stringify(activeScene(project), null, 2);
      setSourceFiles((files) => files.map((file) => file.path === "src/scene.json" ? { ...file, content } : file));
      void saveForgeFile(sourceProjectId, { path: "src/scene.json", content });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [project, sourceProjectId]);

  if (buildPrompt) return <ForgeBuildChat prompt={buildPrompt} activities={activities} error={buildError} onCancel={() => { setBuildPrompt(null); setBuildError(null); }} />;
  if (!project) return <ForgeWelcome onCreate={(prompt, mode) => { void create(prompt, mode); }} />;

  return (
    <div className="forge-shell" style={{ "--forge-bottom-height": bottomOpen ? "224px" : "38px" } as CSSProperties}>
      <header className="forge-topbar">
        <button type="button" className="forge-project-button" onClick={() => setProject(null)}><span><Gamepad2 size={14} /></span><div><strong>{project.name}</strong><small>{scene?.name}</small></div><ChevronDown size={13} /></button>
        <div className="forge-history-controls">
          <button type="button" onClick={undo} disabled={!history.length} aria-label="Undo"><Undo2 size={15} /></button>
          <button type="button" onClick={redo} disabled={!future.length} aria-label="Redo"><Redo2 size={15} /></button>
        </div>
        <div className="forge-runtime-controls">
          {runtime === "stopped" ? <button type="button" className="is-play" onClick={() => setRuntime("playing")}><Play size={14} fill="currentColor" /> Play</button> : <>
            <button type="button" onClick={() => setRuntime((state) => state === "paused" ? "playing" : "paused")}>{runtime === "paused" ? <Play size={14} /> : <Pause size={14} />} {runtime === "paused" ? "Resume" : "Pause"}</button>
            <button type="button" onClick={() => setRuntime("stopped")}><StopCircle size={14} /> Stop</button>
          </>}
        </div>
        {sourceProjectId ? <a className="forge-build-button" href={forgeExportUrl(sourceProjectId)} download><Braces size={13} /> Source</a> : null}
        <button type="button" className="forge-clyra-button" onClick={() => { setBottomOpen(true); setBottomTab("ai"); }}><Sparkles size={14} /> Clyra</button>
      </header>

      <aside className="forge-left-panel">
        <nav>{(["hierarchy", "scenes", "assets"] as const).map((tab) => <button key={tab} type="button" className={leftTab === tab ? "is-active" : ""} onClick={() => setLeftTab(tab)}>{tab}</button>)}</nav>
        {leftTab === "hierarchy" ? <>
          <div className="forge-panel-search"><Search size={13} /><input aria-label="Search hierarchy" placeholder="Filter entities" /></div>
          <div className="forge-hierarchy">
            <button type="button" className="forge-hierarchy__scene"><ChevronDown size={13} /><Layers3 size={14} />{scene?.name}<span>{scene?.entities.length}</span></button>
            {scene?.entities.map((entity) => {
              const Icon = entityIcon(entity.kind);
              return <button type="button" key={entity.id} className={entity.id === selectedId ? "is-selected" : ""} onClick={() => setSelectedId(entity.id)}><Icon size={14} /><span>{entity.name}</span>{entity.locked ? <small>locked</small> : null}</button>;
            })}
          </div>
          <button type="button" className="forge-add-row" onClick={addEntity}><Plus size={14} /> Add entity</button>
        </> : leftTab === "scenes" ? <div className="forge-simple-list">{project.scenes.map((item) => <button type="button" onClick={() => commit((draft) => { draft.activeSceneId = item.id; })} className={item.id === project.activeSceneId ? "is-selected" : ""} key={item.id}><Layers3 size={14} /><span>{item.name}</span><small>{item.mode.toUpperCase()}</small></button>)}<button type="button" onClick={addScene}><Plus size={14} />New scene</button></div> : <div className="forge-simple-list">{project.assets.map((asset) => <div className="forge-asset-row" key={asset.id}><FolderOpen size={14} /><span>{asset.name}</span><small>{asset.type}</small></div>)}</div>}
      </aside>

      <main className="forge-stage">
        <div className="forge-viewport-topline">
          <span className="forge-camera-mode">{project.mode === "3d" ? "Perspective" : "Orthographic"}</span>
          <div className="forge-toolstrip">{toolItems.map((item) => { const Icon = item.icon; return <button type="button" title={item.label} aria-label={item.label} key={item.id} className={tool === item.id ? "is-active" : ""} onClick={() => setTool(item.id)}><Icon size={15} /></button>; })}</div>
          <div className="forge-mode-switch">{(["2d", "3d"] as const).map((mode) => <button type="button" key={mode} className={project.mode === mode ? "is-active" : ""} onClick={() => commit((draft) => { draft.mode = mode; activeScene(draft).mode = mode; })}>{mode.toUpperCase()}</button>)}</div>
        </div>
        {project.mode === "3d" ? <Forge3DViewport project={project} selectedId={selectedId} tool={tool === "rotate" || tool === "scale" || tool === "move" ? tool : "select"} runtime={runtime} onSelect={setSelectedId} onTransform={transformEntity} /> : <Forge2DViewport project={project} selectedId={selectedId} runtime={runtime} onSelect={setSelectedId} onMove={moveEntity} />}
        <div className="forge-viewport-status"><span>Grid 8px</span><span>{scene?.entities.length} entities</span><span>{telemetry?.report.metrics.drawCallsEstimate} draw calls</span></div>
      </main>

      <aside className="forge-inspector">
        <header><div><strong>Inspector</strong><span>{selected ? selected.kind : "Scene"}</span></div></header>
        {selected ? <div className="forge-inspector__body">
          <div className="forge-selected-name"><span style={{ background: selected.color }} /><input value={selected.name} onChange={(event) => commit((draft) => { const item = activeScene(draft).entities.find((entity) => entity.id === selected.id); if (item) item.name = event.target.value; })} /></div>
          <section className="forge-inspector-section is-open"><header><strong>Transform</strong><ChevronDown size={13} /></header><div className="forge-vector-grid"><span>Position</span>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><i>{axis.toUpperCase()}</i><input aria-label={`${axis} position`} type="number" value={Math.round(selected.transform.position[axis] * 10) / 10} onChange={(event) => updateSelectedTransform(axis, numberValue(event.target.value))} /></label>)}</div></section>
          {selected.components.map((item) => <section key={item.id} className="forge-inspector-section is-open"><header><strong>{item.type}</strong><ChevronDown size={13} /></header><div className="forge-property-list">{Object.entries(item.properties).map(([key, value]) => <label key={key}><span>{key}</span><input value={String(value)} onChange={(event) => commit((draft) => { const entity = activeScene(draft).entities.find((candidate) => candidate.id === selected.id); const component = entity?.components.find((candidate) => candidate.id === item.id); if (component) component.properties[key] = typeof value === "number" ? numberValue(event.target.value) : typeof value === "boolean" ? event.target.value === "true" : event.target.value; })} /></label>)}</div></section>)}
          <button type="button" className="forge-add-component" onClick={addComponent}><Plus size={13} /> Add component</button>
          <button type="button" className="forge-delete-entity" disabled={selected.locked} onClick={removeSelected}><Trash2 size={13} /> Delete entity</button>
        </div> : <div className="forge-inspector-empty"><MousePointer2 size={18} /><strong>Select an entity</strong><span>Inspect its semantic components and editable values.</span></div>}
      </aside>

      <section className={cn("forge-bottom-panel", bottomOpen && "is-open")}>
        <nav>{(["assets", "ai", "code", "console", "profiler"] as const).map((tab) => <button type="button" key={tab} className={bottomTab === tab ? "is-active" : ""} onClick={() => { setBottomTab(tab); setBottomOpen(true); }}>{tab}</button>)}<button type="button" className="forge-bottom-toggle" onClick={() => setBottomOpen((open) => !open)}>{bottomOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></nav>
        <AnimatePresence initial={false} mode="wait">
          {bottomOpen ? <motion.div key={bottomTab} className="forge-bottom-content" initial={reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}>
            {bottomTab === "ai" ? <div className="forge-ai-panel"><div className="forge-ai-stream">{activities.slice(-5).map((item) => <div key={item.id} className={cn("forge-ai-activity", `is-${item.state}`)}><span>{item.state === "complete" ? <Check size={13} /> : item.state === "warning" ? <Activity size={13} /> : <Wand2 size={13} />}</span><div><strong>{item.label}</strong>{item.detail ? <small>{item.detail}</small> : null}</div></div>)}</div><div className="forge-ai-composer"><span><AiOrb state="idle" className="forge-ai-composer__orb" /></span><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runCommand(); }} placeholder={selected ? `Ask Forge to change ${selected.name}…` : "Ask Forge to change your game…"} /><button type="button" onClick={() => { void runCommand(); }} disabled={!command.trim()}><ChevronRight size={15} /></button></div></div>
            : bottomTab === "console" ? <div className="forge-console"><ReportView report={validation!} /><ReportView report={telemetry!.report} /></div>
            : bottomTab === "code" ? <div className="forge-code-workbench"><aside>{sourceFiles.map((file) => <button type="button" key={file.path} className={activeFile === file.path ? "is-active" : ""} onClick={() => setActiveFile(file.path)}><Code2 size={12} /><span>{file.path}</span></button>)}</aside><div><header><span>{activeFile}</span><button type="button" onClick={() => { void persistActiveFile(); }} disabled={savingFile}>{savingFile ? "Saving…" : "Save"}</button></header><Editor height="100%" path={activeFile} value={sourceFiles.find((file) => file.path === activeFile)?.content ?? ""} language={activeFile.endsWith(".json") ? "json" : activeFile.endsWith(".md") ? "markdown" : activeFile.endsWith(".html") ? "html" : "typescript"} onChange={(value) => updateSourceFile(activeFile, value ?? "")} options={{ minimap: { enabled: false }, fontSize: 12, lineHeight: 19, glyphMargin: false, folding: true, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 8 }, wordWrap: "on" }} /></div></div>
            : bottomTab === "assets" ? <div className="forge-asset-grid">{project.assets.map((asset) => <div key={asset.id}><span><Braces size={18} /></span><strong>{asset.name}</strong><small>{asset.type} · semantic recipe</small></div>)}</div>
            : bottomTab === "profiler" ? <div className="forge-metrics"><div><Gauge size={17} /><strong>16.7ms</strong><span>target frame</span></div><div><Activity size={17} /><strong>{telemetry?.report.metrics.drawCallsEstimate}</strong><span>draw calls</span></div><div><Cuboid size={17} /><strong>{telemetry?.report.metrics.triangleEstimate}</strong><span>triangles</span></div></div>
            : null}
          </motion.div> : null}
        </AnimatePresence>
      </section>
    </div>
  );
}
