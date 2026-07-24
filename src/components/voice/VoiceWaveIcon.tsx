import { cn } from "../../lib/utils";

export function VoiceWaveIcon({ className }: { className?: string }) {
  const bars = [0.42, 0.68, 1, 0.68, 0.42];
  return (
    <span
      className={cn(
        "inline-flex h-[14px] w-[14px] items-center justify-center gap-[1.5px]",
        className,
      )}
      aria-hidden
    >
      {bars.map((scale, index) => (
        <span
          key={index}
          className="w-[2px] rounded-full bg-current"
          style={{ height: `${Math.round(14 * scale)}px` }}
        />
      ))}
    </span>
  );
}
