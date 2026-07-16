import { ShiningText } from "../../ui/shining-text";

export function PreviewSkeletonLayout({ message }: { message?: string }) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5">
      <div aria-hidden className="preview-skeleton-scan pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-blue-400/70 shadow-[0_0_18px_5px_rgba(59,130,246,.16)]" />
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="h-3 w-24 rounded-full bg-slate-200/80 preview-skeleton-shimmer" />
        <div className="flex gap-2">
          <div className="h-7 w-16 rounded-full bg-slate-200/70 preview-skeleton-shimmer" />
          <div className="h-7 w-20 rounded-full bg-slate-900/90 preview-skeleton-shimmer" />
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="h-4 w-40 rounded-full bg-slate-200/80 preview-skeleton-shimmer" />
        <div className="h-8 w-full max-w-md rounded-2xl bg-slate-200/75 preview-skeleton-shimmer" />
        <div className="h-4 w-64 max-w-full rounded-full bg-slate-100 preview-skeleton-shimmer" />
        <div className="mt-2 flex gap-2">
          <div className="h-9 w-28 rounded-full bg-slate-900/85 preview-skeleton-shimmer" />
          <div className="h-9 w-24 rounded-full bg-slate-200/80 preview-skeleton-shimmer" />
        </div>
      </div>

      <div className="mt-auto grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="preview-skeleton-morph rounded-2xl border border-slate-200/60 bg-white/70 p-3 shadow-sm" style={{ animationDelay: `${index * 180}ms` }}>
            <div className="mb-2 h-8 w-8 rounded-xl bg-slate-200/75 preview-skeleton-shimmer" />
            <div className="mb-1.5 h-3 w-20 rounded-full bg-slate-200/80 preview-skeleton-shimmer" />
            <div className="h-2.5 w-full rounded-full bg-slate-100 preview-skeleton-shimmer" />
          </div>
        ))}
      </div>

      {message ? (
        <div className="mt-4 text-center">
          <ShiningText text={message} className="text-[13px]" />
        </div>
      ) : null}
    </div>
  );
}
