import { cn } from "../../lib/utils";
import { ShiningText } from "../ShiningText";

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
          "truncate text-[color:var(--text-secondary)]",
          mono && "cc-mono",
          className,
        )}
      >
        {text}
      </span>
    );
  }
  return (
    <ShiningText
      text={text}
      play
      duration={long ? 1.75 : 1.65}
      className={cn(
        "truncate text-[12px]",
        tone === "blue" && "text-[#3977F6]",
        mono && "cc-mono",
        className,
      )}
    />
  );
}
