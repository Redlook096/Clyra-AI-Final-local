import { useCallback, useEffect, useState } from "react";
import { Check, CircleDot, GitBranch, GitCommitHorizontal, Github, Loader2, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { api, type ProjectGitStatus } from "./api";

type Props = { projectId: string; projectName: string; onStatusChange?: (status: ProjectGitStatus) => void };

const statusText = (status: ProjectGitStatus | null) => {
  if (!status?.initialized) return "Not published";
  if (!status.changes.length) return status.remoteUrl ? "Synced locally" : "Ready to publish";
  const newFiles = status.changes.filter((change) => change.status === "A").length;
  const modified = status.changes.length - newFiles;
  return `${status.changes.length} change${status.changes.length === 1 ? "" : "s"}${modified ? ` · ${modified} modified` : ""}${newFiles ? ` · ${newFiles} new` : ""}`;
};

/** Compact, project-scoped source control. Credentials never enter this UI. */
export function GitHubPopover({ projectId, projectName, onStatusChange }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [account, setAccount] = useState<{ connected: boolean; authAvailable: boolean; message: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"init" | "commit" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, nextAccount] = await Promise.all([
      api.projectGitStatus(projectId),
      api.githubStatus(),
    ]);
    setStatus(nextStatus);
    setAccount(nextAccount);
    onStatusChange?.(nextStatus);
  }, [onStatusChange, projectId]);

  useEffect(() => { if (open) void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "Could not load source control.")); }, [open, refresh]);

  const initialize = async () => {
    setBusy("init"); setNotice(null);
    try {
      const next = await api.initProjectGit(projectId);
      setStatus(next); onStatusChange?.(next);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not initialise source control."); }
    finally { setBusy(null); }
  };

  const commit = async () => {
    setBusy("commit"); setNotice(null);
    try {
      const result = await api.commitProjectGit(projectId, message || `Update ${projectName}`);
      setStatus(result.status); onStatusChange?.(result.status); setMessage("");
      setNotice(`Committed ${result.oid.slice(0, 7)} locally.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not create a commit."); }
    finally { setBusy(null); }
  };

  const changes = status?.changes ?? [];
  return (
    <div className="relative z-50">
      <button
        type="button"
        aria-label="GitHub source control"
        title="GitHub"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-[31px] w-[31px] items-center justify-center rounded-[9px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045] hover:text-[#27282C]"
      >
        <Github className="h-[16px] w-[16px]" strokeWidth={1.7} />
        {status?.changes.length ? <span className="absolute right-[5px] top-[5px] h-[4px] w-[4px] rounded-full bg-[#3977F6]" /> : null}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 5, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-[38px] w-[350px] overflow-hidden rounded-[10px] border border-black/[0.08] bg-white py-2 shadow-[0_12px_30px_rgba(15,23,42,0.11)]"
          >
            <div className="flex items-start gap-2 px-3 pb-2">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-black/[0.04] text-[#303136]"><Github className="h-[14px] w-[14px]" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[#292A2E]">GitHub</p>
                <p className="mt-0.5 truncate text-[11.5px] text-[#818388]">{status?.remoteUrl || projectName}</p>
              </div>
              <button type="button" aria-label="Close GitHub" onClick={() => setOpen(false)} className="-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-[7px] text-[#96989D] hover:bg-black/[0.04] hover:text-[#4C4E53]"><X className="h-[13px] w-[13px]" /></button>
            </div>
            <div className="border-t border-black/[0.055] px-3 py-2">
              {!status?.initialized ? (
                <>
                  <p className="text-[12px] leading-[1.45] text-[#67696E]">Create local source control first, then connect GitHub to publish and sync this project.</p>
                  <button type="button" disabled={busy !== null} onClick={() => void initialize()} className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-[7px] bg-[#292A2E] px-2.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[#17181B] disabled:opacity-50">
                    {busy === "init" ? <Loader2 className="h-[12px] w-[12px] animate-spin" /> : <GitBranch className="h-[12px] w-[12px]" />} Initialise source control
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-[11.5px] text-[#66686D]">
                    <GitBranch className="h-[12px] w-[12px]" />
                    <span className="font-medium text-[#45474C]">{status.branch || "main"}</span>
                    <span className="text-[#B0B1B5]">·</span>
                    <span>{statusText(status)}</span>
                    <button type="button" aria-label="Refresh Git status" onClick={() => void refresh()} className="ml-auto rounded-[5px] p-1 text-[#8A8D92] transition-colors hover:bg-black/[0.04] hover:text-[#4A4C51]"><RefreshCw className="h-[12px] w-[12px]" /></button>
                  </div>
                  {changes.length ? <div className="mt-2 max-h-[102px] space-y-0.5 overflow-y-auto border-y border-black/[0.045] py-1.5">
                    {changes.slice(0, 8).map((change) => <div key={change.path} className="flex h-5 items-center gap-2 rounded-[5px] px-1.5 text-[11px] hover:bg-black/[0.025]"><span className={change.status === "D" ? "text-[#C24646]" : change.status === "A" ? "text-[#268A50]" : "text-[#3977F6]"}>{change.status}</span><span className="min-w-0 flex-1 truncate text-[#66686D]">{change.path}</span>{change.staged ? <Check className="h-[11px] w-[11px] text-[#268A50]" /> : null}</div>)}
                  </div> : null}
                  <div className="mt-2 flex gap-1.5">
                    <input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && changes.length) void commit(); }} placeholder="Describe your changes…" className="h-7 min-w-0 flex-1 rounded-[7px] border border-black/[0.08] bg-white px-2 text-[11.5px] text-[#333438] outline-none placeholder:text-[#A0A2A6] focus:border-black/[0.18]" />
                    <button type="button" disabled={!changes.length || busy !== null} onClick={() => void commit()} className="flex h-7 shrink-0 items-center gap-1 rounded-[7px] bg-[#292A2E] px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#17181B] disabled:cursor-not-allowed disabled:opacity-40">{busy === "commit" ? <Loader2 className="h-[12px] w-[12px] animate-spin" /> : <GitCommitHorizontal className="h-[12px] w-[12px]" />} Commit</button>
                  </div>
                </>
              )}
            </div>
            <div className="px-3 pt-1.5">
              {account?.connected ? <p className="flex items-center gap-1.5 text-[11px] text-[#6B6D72]"><CircleDot className="h-[11px] w-[11px] text-[#268A50]" /> Connected to GitHub</p> : <p className="text-[11px] leading-[1.4] text-[#8A8D92]">{account?.authAvailable ? "Connect GitHub to push this project." : "GitHub publishing needs a server-side OAuth App configuration."}</p>}
              {notice ? <p className="mt-1 text-[11px] leading-[1.4] text-[#3977F6]">{notice}</p> : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
