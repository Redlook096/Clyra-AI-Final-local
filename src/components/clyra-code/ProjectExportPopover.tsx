import { useState } from "react";
import { Download, FileArchive, FileCode2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

type Props = { projectId: string; projectName: string; ios?: boolean };

/**
 * A small, truthful export surface. Project source is zipped on the local
 * service; Apple signing is deliberately kept separate from this local export
 * instead of implying that an unsigned archive is an installable IPA.
 */
export function ProjectExportPopover({ projectId, projectName, ios = false }: Props) {
  const [open, setOpen] = useState(false);
  const href = `/api/vibe/projects/${encodeURIComponent(projectId)}/export`;
  const title = ios ? "Export iOS project" : "Export project";

  return (
    <div className="relative z-50">
      <button
        type="button"
        aria-label={title}
        title={title}
        onClick={() => setOpen((value) => !value)}
        className="flex h-[31px] w-[31px] items-center justify-center rounded-[9px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045] hover:text-[#27282C]"
      >
        <Download className="h-[16px] w-[16px]" strokeWidth={1.7} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 5, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-[38px] w-[320px] overflow-hidden rounded-[10px] border border-black/[0.08] bg-white py-2 shadow-[0_12px_30px_rgba(15,23,42,0.11)]"
          >
            <div className="flex items-start gap-2 px-3 pb-2">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-black/[0.04] text-[#303136]"><Download className="h-[14px] w-[14px]" strokeWidth={1.65} /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[#292A2E]">Export</p>
                <p className="mt-0.5 truncate text-[11.5px] text-[#818388]">{projectName}</p>
              </div>
              <button type="button" aria-label="Close export" onClick={() => setOpen(false)} className="-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-[7px] text-[#96989D] transition-colors hover:bg-black/[0.04] hover:text-[#4C4E53]"><X className="h-[13px] w-[13px]" /></button>
            </div>
            <div className="border-t border-black/[0.055] px-2 py-1">
              <a href={href} download className="flex min-h-9 items-center gap-2 rounded-[7px] px-2.5 text-[12px] text-[#3C3E43] transition-colors hover:bg-black/[0.035]">
                <FileArchive className="h-[14px] w-[14px] text-[#64666B]" strokeWidth={1.55} />
                <span className="min-w-0 flex-1">Export project ZIP</span>
              </a>
              {ios ? (
                <a href={href} download className="flex min-h-9 items-center gap-2 rounded-[7px] px-2.5 text-[12px] text-[#3C3E43] transition-colors hover:bg-black/[0.035]">
                  <FileCode2 className="h-[14px] w-[14px] text-[#64666B]" strokeWidth={1.55} />
                  <span className="min-w-0 flex-1">Export Xcode source</span>
                </a>
              ) : null}
            </div>
            {ios ? <p className="border-t border-black/[0.055] px-3 pt-2 text-[10.75px] leading-[1.45] text-[#8A8D92]">Source exports are ready locally. IPA signing and App Store delivery require a configured Apple build provider.</p> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
