import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FolderGit2, Plus, Settings2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { VibeProject } from "./api";

function ClyraMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-full bg-[color:var(--accent-blue)]",
        compact ? "h-7 w-7" : "h-6 w-6",
      )}
    >
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
  collapsed = false,
  onToggleCollapsed,
}: {
  projects: VibeProject[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--sidebar-background)] transition-[width] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "w-[56px] min-w-[56px]" : "w-[240px] min-w-[200px]",
      )}
    >
      <div className={cn("pt-4", collapsed ? "px-2" : "px-4")}>
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {collapsed ? (
            <ClyraMark compact />
          ) : (
            <div className="min-w-0">
              <p className="text-[13px] font-medium tracking-[-0.015em] text-[color:var(--text-primary)]">Clyra Code</p>
            </div>
          )}
          {onToggleCollapsed ? (
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={onToggleCollapsed}
              className={cn(
                "rounded-[7px] p-1.5 text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--text-primary)]",
                collapsed && "absolute right-[-13px] top-4 z-20 border border-[color:var(--border-subtle)] bg-white shadow-[0_4px_12px_rgba(15,23,42,0.08)]",
              )}
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
        {!collapsed ? (
          <button
            type="button"
            onClick={onNewProject}
            className="mt-4 flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-[12.5px] font-medium text-[color:var(--text-primary)] transition-colors duration-100 hover:bg-[color:var(--surface-hover)] active:scale-[0.99]"
          >
            <Plus className="h-[15px] w-[15px] text-[color:var(--text-secondary)]" strokeWidth={1.75} />
            New project
          </button>
        ) : (
          <button
            type="button"
            aria-label="New project"
            onClick={onNewProject}
            className="mt-3 mx-auto flex h-8 w-8 items-center justify-center rounded-[8px] border border-[color:var(--border-medium)] bg-white text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
          </button>
        )}
      </div>

      {!collapsed ? (
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
      ) : (
        <div className="mt-4 flex min-h-0 flex-1 flex-col items-center gap-1.5 px-1.5">
          {visible.slice(0, 5).map((project) => {
            const selected = project.id === activeProjectId;
            return (
              <button
                key={project.id}
                type="button"
                title={project.name || project.id}
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-[9px] transition-colors",
                  selected
                    ? "bg-[color:var(--surface-selected)] text-[color:var(--accent-blue)]"
                    : "text-[color:var(--text-tertiary)] hover:bg-[color:var(--surface-hover)]",
                )}
              >
                <FolderGit2 className="h-4 w-4" strokeWidth={1.7} />
              </button>
            );
          })}
        </div>
      )}

      <div className={cn("flex items-center border-t border-[color:var(--border-subtle)] py-3", collapsed ? "justify-center px-1" : "gap-2.5 px-4")}>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--surface-selected)] text-[11px] font-semibold text-[color:var(--text-secondary)]">
          L
        </span>
        {!collapsed ? (
          <>
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
          </>
        ) : null}
      </div>
    </aside>
  );
}
