import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Layout shell for the existing App composer surface.
 * Keeps composer state/handlers in App; only repositions/styles the rail.
 */
export function ChatComposerShell({
  mode,
  children,
  className,
}: {
  mode: "welcome" | "thread";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "clyra-chat-composer-shell w-full",
        mode === "welcome"
          ? "relative z-20 max-w-[840px]"
          : "absolute inset-x-0 bottom-0 z-20 mx-auto max-w-3xl px-5 pb-0 sm:px-8",
        className,
      )}
      data-composer-mode={mode}
    >
      {children}
    </div>
  );
}
