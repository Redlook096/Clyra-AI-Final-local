import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Settings2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { VibeProject } from "./api";

function ClyraMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-full bg-[#2563eb]",
        compact ? "h-6 w-6" : "h-[18px] w-[18px]",
      )}
      aria-hidden
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
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
        "relative flex h-full shrink-0 flex-col bg-[#F7F7F6] transition-[width] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "w-[52px] min-w-[52px]" : "w-[208px] min-w-[188px]",
      )}
    >
      <div className={cn("pt-3", collapsed ? "px-1.5" : "px-2.5")}>
        <div className={cn("flex h-7 items-center", collapsed ? "justify-center" : "justify-between gap-1.5")}>
          {collapsed ? (
            <ClyraMark compact />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <ClyraMark />
              <p className="truncate text-[12.5px] font-medium tracking-[-0.015em] text-[#171717]">
                Clyra
              </p>
            </div>
          )}
          {onToggleCollapsed ? (
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={onToggleCollapsed}
              className={cn(
                "rounded-[6px] p-1 text-[#8A8A8A] transition-colors hover:bg-[#EEEEEC] hover:text-[#171717]",
                collapsed && "absolute right-[-11px] top-3 z-20 border border-[#EEEEEC] bg-white",
              )}
            >
              {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
            </button>
          ) : null}
        </div>
        {!collapsed ? (
          <button
            type="button"
            onClick={onNewProject}
            className="mt-2 flex h-7 w-full items-center gap-1.5 rounded-[7px] px-1.5 text-[12px] text-[#171717] transition-colors duration-100 hover:bg-[#EEEEEC] active:scale-[0.99]"
          >
            <Plus className="h-3.5 w-3.5 text-[#5F6368]" strokeWidth={1.75} />
            New project
          </button>
        ) : (
          <button
            type="button"
            aria-label="New project"
            onClick={onNewProject}
            className="mt-2 mx-auto flex h-7 w-7 items-center justify-center rounded-[7px] text-[#5F6368] transition-colors hover:bg-[#EEEEEC]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      {!collapsed ? (
        <div className="mt-3 min-h-0 flex-1 px-1.5">
          {visible.length === 0 ? (
            <div className="px-1.5 py-1.5 text-[11.5px] leading-[1.45] text-[#8A8A8A]">
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
                    "flex h-7 w-full items-center gap-1.5 rounded-[7px] px-1.5 text-left transition-colors duration-100",
                    selected ? "bg-[#EEEEEC]" : "hover:bg-[#F0F0EE]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#171717]">
                    {project.name || project.id}
                  </span>
                  {selected ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#2563eb]" />
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
                className="mt-0.5 flex h-6 w-full items-center gap-1 rounded-[7px] px-1.5 text-[11.5px] text-[#8A8A8A] transition-colors hover:bg-[#F0F0EE]"
              >
                View all
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", showAll && "rotate-180")}
                />
              </button>
              {showAll ? (
                <div className="cc-scroll mt-0.5 max-h-52 overflow-y-auto rounded-[8px] border border-[#EEEEEC] bg-white py-0.5">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => {
                        onSelectProject(project.id);
                        setShowAll(false);
                      }}
                      className={cn(
                        "flex h-6 w-full items-center px-2 text-left text-[12px] transition-colors hover:bg-[#F6F6F5]",
                        project.id === activeProjectId && "text-[#2563eb]",
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
        <div className="mt-2 flex min-h-0 flex-1 flex-col items-center gap-0.5 px-1">
          {visible.map((project) => {
            const selected = project.id === activeProjectId;
            const initial = (project.name || project.id).slice(0, 1).toUpperCase();
            return (
              <button
                key={project.id}
                type="button"
                title={project.name || project.id}
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-[7px] text-[10.5px] font-medium transition-colors",
                  selected
                    ? "bg-[#EEEEEC] text-[#2563eb]"
                    : "text-[#8A8A8A] hover:bg-[#F0F0EE]",
                )}
              >
                {initial}
              </button>
            );
          })}
        </div>
      )}

      <div className={cn("flex h-10 items-center border-t border-[#EEEEEC]", collapsed ? "justify-center px-1" : "gap-1.5 px-2.5")}>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#EEEEEC] text-[10px] font-semibold text-[#5F6368]">
          L
        </span>
        {!collapsed ? (
          <>
            <span className="flex-1 truncate text-[12px] text-[#171717]">Luke</span>
            <button
              type="button"
              aria-label="Settings"
              className="rounded-[6px] p-0.5 text-[#8A8A8A] transition-colors hover:bg-[#EEEEEC]"
            >
              <Settings2 className="h-3.5 w-3.5" strokeWidth={1.7} />
            </button>
          </>
        ) : null}
      </div>
    </aside>
  );
}
