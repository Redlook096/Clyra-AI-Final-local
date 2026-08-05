import { useMemo, useState } from "react";
import { ChevronDown, FolderGit2, Plus, Settings2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { VibeProject } from "./api";

function ClyraMark() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--accent-blue)]">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M9.5 3.4A4.1 4.1 0 1 0 9.5 8.6"
          stroke="white"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function Sidebar({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
}: {
  projects: VibeProject[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => {
    const sorted = [...projects];
    const activeIndex = sorted.findIndex((p) => p.id === activeProjectId);
    if (activeIndex >= 4) {
      const [active] = sorted.splice(activeIndex, 1);
      sorted.unshift(active);
    }
    return sorted.slice(0, 4);
  }, [projects, activeProjectId]);

  return (
    <aside className="flex h-full w-[280px] min-w-[220px] shrink-0 flex-col bg-[color:var(--sidebar-background)]">
      <div className="px-4 pt-4">
        <ClyraMark />
        <button
          type="button"
          onClick={onNewProject}
          className="mt-4 flex h-[36px] w-full items-center gap-2 rounded-[9px] border border-[color:var(--border-medium)] bg-white/85 px-3 text-[13px] font-medium text-[color:var(--text-primary)] shadow-none transition-colors duration-100 hover:bg-white active:scale-[0.99]"
        >
          <Plus className="h-[15px] w-[15px] text-[color:var(--text-secondary)]" strokeWidth={2} />
          New project
          <kbd className="cc-mono ml-auto text-[10.5px] text-[color:var(--text-tertiary)]">⌘N</kbd>
        </button>
      </div>

      <div className="mt-5 min-h-0 flex-1 px-2.5">
        <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[color:var(--text-tertiary)]">
          Projects
        </div>
        {visible.length === 0 ? (
          <div className="px-1.5 py-2 text-[12px] leading-[1.5] text-[color:var(--text-tertiary)]">
            No projects yet.
          </div>
        ) : (
          visible.map((project) => {
            const selected = project.id === activeProjectId;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-[8px] px-2 py-[7px] text-left transition-colors duration-100",
                  selected
                    ? "bg-[color:var(--surface-selected)]"
                    : "hover:bg-[color:var(--surface-hover)]",
                )}
              >
                <FolderGit2
                  className="h-[16px] w-[16px] shrink-0 text-[color:var(--text-tertiary)]"
                  strokeWidth={1.7}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[color:var(--text-primary)]">
                    {project.name || project.id}
                  </span>
                  <span className="cc-mono block truncate text-[10.5px] text-[color:var(--text-tertiary)]">
                    projects/{project.id}
                  </span>
                </span>
                {selected ? (
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[color:var(--accent-blue)]" />
                ) : null}
              </button>
            );
          })
        )}
        {projects.length > 4 ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 flex w-full items-center gap-1.5 rounded-[8px] px-2 py-[5px] text-[12px] text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)]"
            >
              View all projects
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", showAll && "rotate-180")}
              />
            </button>
            {showAll ? (
              <div className="cc-scroll mt-1 max-h-56 overflow-y-auto rounded-[10px] border border-[color:var(--border-subtle)] bg-white py-1 shadow-[0_8px_24px_rgba(15,23,42,0.08)]">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      onSelectProject(project.id);
                      setShowAll(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-[6px] text-left text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)]",
                      project.id === activeProjectId && "text-[color:var(--accent-blue)]",
                    )}
                  >
                    <span className="truncate">{project.name || project.id}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2.5 border-t border-[color:var(--border-subtle)] px-4 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--surface-selected)] text-[11px] font-semibold text-[color:var(--text-secondary)]">
          L
        </span>
        <span className="flex-1 truncate text-[12.5px] font-medium text-[color:var(--text-primary)]">
          Luke
        </span>
        <button
          type="button"
          aria-label="Settings"
          className="rounded-[7px] p-1 text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          <Settings2 className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </button>
      </div>
    </aside>
  );
}
