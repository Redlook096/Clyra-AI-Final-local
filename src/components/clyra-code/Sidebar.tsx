import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronDown,
  PanelLeftClose,
  Folder,
  Globe2,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Smartphone,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { VibeProject } from "./api";

export type ChatThread = {
  id: string;
  title: string;
  time?: { created?: number; updated?: number };
};

export function ClyraMark({ compact = false, size = 18 }: { compact?: boolean; size?: number }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-[#3977F6]", compact && "h-6 w-6")} style={compact ? undefined : { width: size, height: size }} aria-hidden>
      <svg width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} viewBox="0 0 20 20" fill="none">
        <rect x="2.75" y="3.5" width="14.5" height="12.5" rx="2.2" stroke="white" strokeWidth="1.45" />
        <path d="m6.2 7.15 2.55 2.35-2.55 2.35M10.9 12.25h2.85" stroke="white" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

type Menu = { kind: "project"; projectId: string } | { kind: "chat"; projectId: string; chatId: string } | null;

export function Sidebar({
  projects, threadsByProject, activeProjectId, activeSessionId, onSelectProject, onSelectChat, onNewProject, onNewChat,
  onRenameProject, onRenameChat, onDeleteChat, onRemoveProject, collapsed = false, onToggleCollapsed,
}: {
  projects: VibeProject[];
  threadsByProject: Record<string, ChatThread[]>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectChat: (projectId: string, chatId: string) => void;
  onNewProject: () => void;
  onNewChat: (projectId: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onRenameChat: (projectId: string, chatId: string, title: string) => void;
  onDeleteChat: (projectId: string, chatId: string) => void;
  onRemoveProject: (projectId: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeProjectId ? [activeProjectId] : []));
  const [menu, setMenu] = useState<Menu>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ type: "project" | "chat"; projectId: string; chatId?: string; value: string } | null>(null);
  const editRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (activeProjectId) setExpanded((old) => new Set([...old, activeProjectId])); }, [activeProjectId]);
  useEffect(() => { editRef.current?.focus(); editRef.current?.select(); }, [editing]);

  const orderedProjects = useMemo(() => [...projects].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)), [projects]);
  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return orderedProjects;
    return orderedProjects.filter((project) => {
      const threads = threadsByProject[project.id] ?? [];
      return project.name.toLocaleLowerCase().includes(needle) || threads.some((thread) => thread.title.toLocaleLowerCase().includes(needle));
    });
  }, [orderedProjects, query, threadsByProject]);
  const highlight = (value: string) => {
    const needle = query.trim();
    const start = needle ? value.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
    if (start < 0) return value;
    return <>{value.slice(0, start)}<span className="text-[#3977F6]">{value.slice(start, start + needle.length)}</span>{value.slice(start + needle.length)}</>;
  };
  useEffect(() => {
    if (!query.trim()) return;
    setExpanded(new Set(filteredProjects.map((project) => project.id)));
  }, [filteredProjects, query]);
  const commitEdit = () => {
    if (!editing) return;
    const value = editing.value.trim();
    if (value) {
      if (editing.type === "project") onRenameProject(editing.projectId, value);
      else if (editing.chatId) onRenameChat(editing.projectId, editing.chatId, value);
    }
    setEditing(null);
  };
  const openProjectMenu = (event: React.MouseEvent, projectId: string) => { event.stopPropagation(); setMenu({ kind: "project", projectId }); };
  const openChatMenu = (event: React.MouseEvent, projectId: string, chatId: string) => { event.stopPropagation(); setMenu({ kind: "chat", projectId, chatId }); };

  return (
    <motion.aside
      aria-hidden={collapsed || undefined}
      initial={false}
      animate={{ width: collapsed ? 0 : 236, opacity: collapsed ? 0 : 1, x: collapsed ? -8 : 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={cn("relative flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-black/[0.055] bg-[#F8F8F7] font-[-apple-system,BlinkMacSystemFont,Inter,Segoe_UI,sans-serif]", collapsed && "pointer-events-none border-r-0")}>
      <div className={cn("px-3 pt-1.5", collapsed && "px-1.5")}>
        <div className={cn("flex h-[46px] items-center", collapsed ? "justify-center" : "gap-1.5")}>
          {!collapsed && !searchOpen ? <span className="min-w-0 flex-1 whitespace-nowrap text-[15px] font-medium tracking-[-0.02em] text-[#2E3035]">Vibe Coder</span> : null}
          {!collapsed ? <div className="relative shrink-0">
            {searchOpen ? <div className="flex h-8 w-[174px] items-center gap-1.5 rounded-[8px] bg-white px-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.07]">
              <Search className="h-3.5 w-3.5 shrink-0 text-[#77797E]" strokeWidth={1.7} />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }} placeholder="Search projects" className="min-w-0 flex-1 bg-transparent text-[11.5px] text-[#34363A] outline-none placeholder:text-[#A0A2A6]" />
              <button type="button" aria-label="Close search" onClick={() => { setQuery(""); setSearchOpen(false); }} className="text-[#96989D] hover:text-[#505258]">×</button>
            </div> : <button type="button" aria-label="Search projects" onClick={() => setSearchOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[#77797E] transition-colors duration-150 hover:bg-black/[0.045] hover:text-[#34363A]"><Search className="h-[17px] w-[17px]" strokeWidth={1.65} /></button>}
          </div> : null}
          {onToggleCollapsed ? <button type="button" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onToggleCollapsed} className="flex h-[31px] w-[31px] items-center justify-center rounded-[9px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045] hover:text-[#34363A]"><PanelLeftClose className="h-[16px] w-[16px]" strokeWidth={1.6} /></button> : null}
        </div>
        <button type="button" onClick={onNewProject} aria-label="New project" className={cn("mt-1 flex h-8 items-center gap-1.5 rounded-[7px] text-[12px] font-[450] text-[#45474C] transition-colors duration-100 hover:bg-black/[0.035] active:scale-[0.99]", collapsed ? "mx-auto w-8 justify-center" : "w-full px-1.5")}><Plus className="h-3.5 w-3.5 text-[#5F6368]" strokeWidth={1.75} />{!collapsed ? "New project" : null}</button>
      </div>

      {!collapsed ? <div className="cc-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" onClick={() => setMenu(null)}>
        {filteredProjects.length === 0 ? <div className="px-1.5 py-1.5 text-[11.5px] leading-[1.45] text-[#96989D]">No matching projects.</div> : filteredProjects.map((project) => {
          const projectThreads = threadsByProject[project.id] ?? [];
          const isExpanded = expanded.has(project.id);
          const selected = project.id === activeProjectId;
          const projectEditing = editing?.type === "project" && editing.projectId === project.id;
          return <div key={project.id} className="group/project relative mb-2.5 last:mb-1">
            <div role="button" tabIndex={0} onClick={() => { setExpanded((old) => { const next = new Set(old); next.has(project.id) ? next.delete(project.id) : next.add(project.id); return next; }); onSelectProject(project.id); }} onKeyDown={(event) => event.key === "Enter" && onSelectProject(project.id)} className={cn("flex h-[30px] w-full cursor-pointer select-none items-center gap-1 rounded-[7px] px-1.5 text-left transition-colors duration-[120ms] ease-out", selected ? "bg-black/[0.045]" : "hover:bg-black/[0.03] active:bg-black/[0.04]")}>
              <ChevronDown className={cn("h-3 w-3 shrink-0 text-[#929499] transition-transform duration-150", !isExpanded && "-rotate-90")} strokeWidth={1.7} />
              <Folder className="h-[13px] w-[13px] shrink-0 text-[#77797E]" strokeWidth={1.65} />
              {projectEditing ? <input ref={editRef} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={commitEdit} onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }} onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1 rounded-[4px] bg-white px-1 text-[12px] text-[#303136] outline-none ring-1 ring-[#3977F6]/35" /> : <span className="min-w-0 flex-1 truncate text-[12px] font-[450] text-[#45474C]">{highlight(project.name || project.id)}</span>}
              <button type="button" aria-label={`New chat in ${project.name}`} onClick={(e) => { e.stopPropagation(); onNewChat(project.id); }} className="invisible flex h-5 w-5 items-center justify-center rounded-[5px] text-[#76787D] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-black/[0.05] group-hover/project:visible group-hover/project:opacity-100"><Plus className="h-3 w-3" /></button>
              <button type="button" aria-label={`Project menu for ${project.name}`} onClick={(e) => openProjectMenu(e, project.id)} className="invisible flex h-5 w-5 items-center justify-center rounded-[5px] text-[#76787D] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-black/[0.05] group-hover/project:visible group-hover/project:opacity-100"><MoreHorizontal className="h-3 w-3" /></button>
            </div>
            <AnimatePresence initial={false}>
            {isExpanded ? <motion.div initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.19, ease: [0.22, 1, 0.36, 1] }} className="ml-[17px] overflow-hidden border-l border-black/[0.055] py-0.5 pl-1">{projectThreads.length ? projectThreads.map((thread) => {
              const threadSelected = project.id === activeProjectId && thread.id === activeSessionId;
              const chatEditing = editing?.type === "chat" && editing.projectId === project.id && editing.chatId === thread.id;
              return <div key={thread.id} role="button" tabIndex={0} onClick={() => onSelectChat(project.id, thread.id)} onContextMenu={(e) => { e.preventDefault(); openChatMenu(e, project.id, thread.id); }} className={cn("group/chat relative flex h-[29px] w-full cursor-pointer select-none items-center gap-1 rounded-[7px] pl-2 pr-1 text-left transition-colors duration-[120ms] ease-out", threadSelected ? "bg-black/[0.045]" : "hover:bg-black/[0.03] active:bg-black/[0.04]")}>{chatEditing ? <input ref={editRef} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={commitEdit} onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }} onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1 rounded-[4px] bg-white px-1 text-[12px] text-[#303136] outline-none ring-1 ring-[#3977F6]/35" /> : <><span className="min-w-0 flex-1 truncate text-[12px] text-[#5B5D62]">{highlight(thread.title || "New chat")}</span>{threadSelected ? <span className="h-[4px] w-[4px] rounded-full bg-[#3977F6]" /> : null}</>}<button type="button" aria-label={`Chat menu for ${thread.title}`} onClick={(e) => openChatMenu(e, project.id, thread.id)} className="invisible absolute right-1 flex h-5 w-5 items-center justify-center rounded-[5px] bg-[#F7F7F6] text-[#76787D] opacity-0 transition-opacity duration-100 hover:bg-black/[0.05] group-hover/chat:visible group-hover/chat:opacity-100"><MoreHorizontal className="h-3 w-3" /></button></div>;
            }) : <button type="button" onClick={() => onNewChat(project.id)} className="flex h-[27px] w-full items-center px-2 text-[11.5px] text-[#93959A] transition-colors hover:text-[#57595E]">New chat</button>}</motion.div> : null}
            </AnimatePresence>
          </div>;
        })}
        {menu?.kind === "project" ? <Menu items={[{ label: "New chat", action: () => onNewChat(menu.projectId) }, { label: "Rename project", action: () => { const project = projects.find((item) => item.id === menu.projectId); setEditing({ type: "project", projectId: menu.projectId, value: project?.name || "" }); } }, { label: "Open folder", action: () => void navigator.clipboard.writeText(projects.find((item) => item.id === menu.projectId)?.id || "") }, { label: "Remove from Clyra", action: () => onRemoveProject(menu.projectId), destructive: true }]} /> : null}
        {menu?.kind === "chat" ? <Menu items={[{ label: "Rename", action: () => { const thread = (threadsByProject[menu.projectId] ?? []).find((item) => item.id === menu.chatId); setEditing({ type: "chat", projectId: menu.projectId, chatId: menu.chatId, value: thread?.title || "" }); } }, { label: "Delete", action: () => onDeleteChat(menu.projectId, menu.chatId), destructive: true }]} /> : null}
      </div> : <div className="mt-2 flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto px-1">{orderedProjects.map((project) => { const selected = project.id === activeProjectId; return <button key={project.id} type="button" title={project.name || project.id} onClick={() => onSelectProject(project.id)} className={cn("flex h-7 w-7 items-center justify-center rounded-[7px] transition-colors", selected ? "bg-black/[0.045] text-[#3977F6]" : "text-[#96989D] hover:bg-black/[0.03]")}>{project.platform === "ios" ? <Smartphone className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}</button>; })}</div>}

      <div className={cn("flex h-[42px] items-center border-t border-black/[0.05]", collapsed ? "justify-center px-1" : "gap-1.5 px-2.5")}><span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#E8E8E7] text-[9px] font-semibold text-[#505258]">L</span>{!collapsed ? <><span className="flex-1 truncate text-[11.5px] text-[#505258]">Luke</span><button type="button" aria-label="Settings" className="rounded-[6px] p-0.5 text-[#96989D] transition-colors hover:bg-black/[0.035]"><Settings2 className="h-[13px] w-[13px]" strokeWidth={1.7} /></button></> : null}</div>
    </motion.aside>
  );
}

function Menu({ items }: { items: Array<{ label: string; action: () => void; destructive?: boolean }> }) {
  return <div className="absolute left-5 top-11 z-40 w-[150px] rounded-[8px] border border-black/[0.08] bg-white p-1 shadow-[0_10px_24px_rgba(15,23,42,0.1)]">{items.map((item) => <button key={item.label} type="button" onClick={item.action} className={cn("flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[11.5px] transition-colors hover:bg-black/[0.035]", item.destructive ? "text-[#B94B4B]" : "text-[#4C4E53]")}>{item.label}</button>)}</div>;
}
