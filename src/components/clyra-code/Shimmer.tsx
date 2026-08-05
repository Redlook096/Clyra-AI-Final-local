import { cn } from "../../lib/utils";

/**
 * Masked glyph shimmer for active harness targets (filenames, commands,
 * search queries). Same visual family as the Clyra thinking shimmer — light
 * passes across the text itself. When inactive, renders static text.
 */
export function ShimmerText({
  text,
  active,
  tone = "neutral",
  className,
  mono = false,
}: {
  text: string;
  active: boolean;
  tone?: "neutral" | "blue";
  className?: string;
  mono?: boolean;
}) {
  const long = text.length > 32;
  if (!active) {
    return (
      <span
        className={cn(
          "truncate",
          mono && "cc-mono",
          tone === "blue" ? "text-[color:var(--accent-blue)]" : "text-[color:var(--text-primary)]",
          className,
        )}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "cc-shimmer truncate",
        tone === "blue" && "cc-shimmer--blue",
        long && "cc-shimmer--long",
        mono && "cc-mono",
        className,
      )}
    >
      {text}
    </span>
  );
}
