import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { getElectronDesktop, isElectronRuntime, type ElectronSurfaceBounds } from "@/lib/electron-runtime";

type ElectronWebContentsSurfaceProps = {
  source?: string;
  title: string;
  surfaceId: string;
  kind: "browser" | "preview" | "vibe-runtime";
  className?: string;
  active?: boolean;
  fallback?: ReactNode;
};

function changed(previous: ElectronSurfaceBounds | null, next: ElectronSurfaceBounds) {
  if (!previous) return true;
  return Object.keys(next).some((key) => Math.abs(next[key as keyof ElectronSurfaceBounds] - previous[key as keyof ElectronSurfaceBounds]) > 0.5);
}

export function ElectronWebContentsSurface({
  source,
  title,
  surfaceId,
  kind,
  className,
  active = true,
  fallback,
}: ElectronWebContentsSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lastBoundsRef = useRef<ElectronSurfaceBounds | null>(null);
  const frameRef = useRef(0);
  const electron = isElectronRuntime();

  useEffect(() => {
    if (!electron) return;
    const desktop = getElectronDesktop();
    const host = hostRef.current;
    if (!desktop || !host) return;

    let disposed = false;
    let visible = false;
    let occluded = false;
    let hasMeasuredLayout = false;
    const sync = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        if (disposed) return;
        const rect = host.getBoundingClientRect();
        const nextVisible =
          active &&
          !occluded &&
          document.visibilityState === "visible" &&
          rect.width >= 2 &&
          rect.height >= 2 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        const bounds = {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(2, rect.width),
          height: Math.max(2, rect.height),
        };
        // Native Chromium must not be surfaced into the placeholder's initial
        // 2px bounds. Wait for one real layout pass so entering Browser never
        // flashes or looks like a page refresh while React settles.
        if (!hasMeasuredLayout && (rect.width < 8 || rect.height < 8)) return;
        hasMeasuredLayout = true;
        if (!changed(lastBoundsRef.current, bounds) && visible === nextVisible) return;
        lastBoundsRef.current = bounds;
        visible = nextVisible;
        if (kind === "browser") {
          void desktop.browser.setSurface({ bounds, visible: nextVisible });
        } else if (source) {
          void desktop.surfaces.update({ id: surfaceId, url: source, kind, bounds, visible: nextVisible });
        }
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    // Motion controls the adjacent chat-panel width. Forward each animation
    // frame so the native Chromium view tracks the same geometry rather than
    // jumping to its final width after the panel has settled.
    window.addEventListener("clyra:native-surface-layout", sync);
    const handleOcclusion = (event: Event) => {
      occluded = Boolean((event as CustomEvent<{ occluded?: boolean }>).detail?.occluded);
      if (occluded) {
        visible = false;
        if (kind === "browser") void desktop.browser.setSurface({ visible: false });
        else void desktop.surfaces.hide(surfaceId);
      } else {
        sync();
      }
    };
    window.addEventListener("clyra:native-surface-occlusion", handleOcclusion);
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameRef.current);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("clyra:native-surface-layout", sync);
      window.removeEventListener("clyra:native-surface-occlusion", handleOcclusion);
      document.removeEventListener("visibilitychange", sync);
      if (kind === "browser") void desktop.browser.setSurface({ visible: false });
      else void desktop.surfaces.hide(surfaceId);
    };
  }, [active, electron, kind, source, surfaceId]);

  if (!electron) return <>{fallback}</>;
  return <div ref={hostRef} className={cn("relative h-full min-h-0 w-full overflow-hidden bg-white", className)} aria-label={title} />;
}
