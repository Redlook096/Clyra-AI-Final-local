import { CLIP_EDITOR, CLIP_EDITOR_FONT } from "./tokens";

/**
 * Determinate SVG circular progress ring with an accurate percent label.
 *
 * Replaces every indeterminate spinner in the clipper: the ring only moves
 * when the pipeline reports real stage progress, so the fill is honest.
 */
export default function ProgressRing({
  percent,
  size = 108,
  strokeWidth = 6,
  color = CLIP_EDITOR.blue,
  trackColor = "#EDF1F7",
  label,
}: {
  percent: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  /** Optional caption under the percent (e.g. stage name). */
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 260ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center" style={{ fontFamily: CLIP_EDITOR_FONT }}>
        <div>
          <p className="tabular-nums font-semibold" style={{ color: CLIP_EDITOR.textPrimary, fontSize: size >= 96 ? 20 : 14, letterSpacing: "-0.02em" }}>
            {Math.round(clamped)}%
          </p>
          {label ? (
            <p className="mt-0.5 truncate px-2" style={{ color: CLIP_EDITOR.textMuted, fontSize: 10, maxWidth: size - 16 }}>{label}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
