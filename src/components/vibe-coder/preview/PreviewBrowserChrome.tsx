import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { PreviewUrlInput } from "./PreviewUrlInput";

export function PreviewBrowserChrome({
  title,
  address,
  canNavigate,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  onRestart,
  onOpenExternal,
  onCopyUrl,
  isFullscreen,
  onToggleFullscreen,
  statusLabel,
}: {
  title: string;
  address: string;
  canNavigate: boolean;
  onAddressChange: (value: string) => void;
  onNavigate: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onRestart: () => void;
  onOpenExternal: () => void;
  onCopyUrl: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  statusLabel?: string;
}) {
  const routeLabel = (() => {
    try {
      if (!address) return "/";
      const url = new URL(address);
      return `${url.pathname}${url.search}` || "/";
    } catch {
      return address || "/";
    }
  })();

  return (
    <div className="relative z-10 shrink-0 border-b border-slate-200/80 bg-white">
      <div className="flex h-[50px] items-center gap-2 px-3">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onBack}
            disabled={!canNavigate}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900 disabled:opacity-35"
            aria-label="Go back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onForward}
            disabled={!canNavigate}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900 disabled:opacity-35"
            aria-label="Go forward"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900"
            aria-label="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <PreviewUrlInput
            value={address}
            onChange={onAddressChange}
            onNavigate={onNavigate}
            placeholder={routeLabel}
          />
        </div>

        <div className="hidden min-w-0 max-w-[140px] truncate text-[12px] font-medium text-slate-500 sm:block" title={title}>
          {title}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenExternal}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900"
            aria-label="Open in browser"
            title="Open externally"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900"
            aria-label="Restart preview"
            title="Restart development server"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900"
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen preview"}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onCopyUrl}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f1f5f9] hover:text-slate-900"
            aria-label="More preview actions"
            title="Copy preview URL"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {statusLabel ? (
        <div className="flex h-7 items-center gap-2 border-t border-slate-100 bg-[#f8fafc] px-3 text-[11.5px] font-medium text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500/80" aria-hidden />
          {statusLabel}
        </div>
      ) : null}
    </div>
  );
}
