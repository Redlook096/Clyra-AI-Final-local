import { motion } from "motion/react";
import { X } from "lucide-react";
import { AGENT_EASE } from "./motion";

/**
 * Inspect selection payload — serialized from the real preview DOM. Carries
 * the structured context that reference chips embed for the coding agent.
 */
export type InspectRule = {
  file: string | null;
  selector: string;
  declarations: Record<string, string>;
};

export type InspectPayload = {
  elId?: number;
  platform?: "web";
  tag?: string;
  kind?: string;
  name?: string;
  label?: string;
  text?: string;
  bounds?: { left: number; top: number; width: number; height: number };
  styles?: Record<string, string>;
  rules?: InspectRule[];
  domPath?: string;
  url?: string;
  sourceHint?: string | null;
  sourceLine?: number | null;
};

export function selectionChipLabel(payload: InspectPayload) {
  return `▣ ${payload.kind ?? "Element"} · ${payload.label ?? payload.name ?? "element"}`;
}

export function selectionContextDetail(payload: InspectPayload) {
  return JSON.stringify(
    {
      selectedPreviewElement: true,
      platform: payload.platform ?? "web",
      elementType: payload.kind,
      elementTag: payload.tag,
      visibleText: payload.text,
      componentName: payload.name,
      label: payload.label,
      sourceFile: payload.sourceHint ?? payload.rules?.find((rule) => rule.file)?.file ?? null,
      sourceLine: payload.sourceLine ?? null,
      cssSelectors: payload.rules?.map((rule) => rule.selector).slice(0, 6),
      styles: payload.styles ?? {},
      bounds: payload.bounds,
      domPath: payload.domPath,
      instructions:
        "The user is referring to THIS selected element. Locate its real source (component/CSS) and make the requested change to it.",
    },
    null,
    2,
  );
}

const COLOR_PROPS = [
  { prop: "color", label: "Text" },
  { prop: "backgroundColor", label: "Background" },
  { prop: "borderColor", label: "Border" },
] as const;

const NUMBER_PROPS = [
  { prop: "width", label: "Width", suffix: "px" },
  { prop: "height", label: "Height", suffix: "px" },
  { prop: "paddingTop", label: "Padding", suffix: "px" },
  { prop: "marginTop", label: "Margin", suffix: "px" },
  { prop: "gap", label: "Gap", suffix: "px" },
  { prop: "borderRadius", label: "Radius", suffix: "px" },
  { prop: "borderWidth", label: "Border", suffix: "px" },
  { prop: "fontSize", label: "Font size", suffix: "px" },
  { prop: "fontWeight", label: "Weight", suffix: "" },
  { prop: "opacity", label: "Opacity", suffix: "" },
] as const;

const SELECT_PROPS = [
  { prop: "display", label: "Display", options: ["block", "flex", "grid", "inline-block", "none"] },
  { prop: "flexDirection", label: "Direction", options: ["row", "column", "row-reverse", "column-reverse"] },
  { prop: "alignItems", label: "Align", options: ["stretch", "center", "flex-start", "flex-end", "baseline"] },
  { prop: "justifyContent", label: "Justify", options: ["flex-start", "center", "flex-end", "space-between", "space-around"] },
  { prop: "position", label: "Position", options: ["static", "relative", "absolute", "fixed"] },
  { prop: "objectFit", label: "Image fit", options: ["cover", "contain", "fill", "none"] },
] as const;

function px(value: string) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstUnit(value: string) {
  const match = String(value).match(/[a-z%]+$/i);
  return match ? match[0] : "px";
}

/** Compact floating inspector — Cursor/Figma-style, real source updates. */
export function VisualInspector({
  payload,
  onClose,
  onChange,
}: {
  payload: InspectPayload;
  onClose: () => void;
  onChange: (property: string, value: string, liveStyles?: Record<string, string>) => void;
}) {
  const styles = payload.styles ?? {};

  const sourceHint = payload.sourceHint ?? payload.rules?.find((rule) => rule.file)?.file ?? null;

  const commitNumber = (prop: string, raw: string, suffix: string) => {
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return;
    const unit = suffix || firstUnit(styles[prop] || "px");
    const next = `${value}${unit}`;
    onChange(prop, next, { [prop]: next });
  };

  const applyColor = (prop: string, value: string) => {
    if (!value) return;
    onChange(prop, value, { [prop]: value });
  };

  const applySelect = (prop: string, value: string) => {
    onChange(prop, value, { [prop]: value });
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: AGENT_EASE }}
      className="absolute right-3 top-[52px] z-30 w-[236px] rounded-[10px] border border-black/[0.07] bg-white/98 p-2.5 shadow-[0_2px_4px_rgba(0,0,0,0.03),0_10px_28px_rgba(0,0,0,0.09)] backdrop-blur"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[#343539]">
          {payload.label ?? payload.name}
        </span>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
          className="rounded-[5px] p-0.5 text-[#96989D] transition-colors hover:bg-black/[0.04] hover:text-[#202124]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {sourceHint ? (
        <p className="cc-mono mt-0.5 truncate text-[9.5px] text-[#A0A2A6]" title={sourceHint}>
          {sourceHint}
        </p>
      ) : null}

      <div className="cc-scroll mt-1.5 flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-0.5">
        <div className="grid grid-cols-2 gap-1.5">
          {COLOR_PROPS.map((entry) => (
            <label key={entry.prop} className="flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 transition-colors hover:bg-black/[0.025]">
              <input
                type="color"
                value={normalizeColor(styles[entry.prop] ?? "")}
                onChange={(event) => applyColor(entry.prop, event.target.value)}
                className="h-5 w-6 shrink-0 cursor-pointer rounded-[4px] border border-black/[0.08] bg-transparent p-0"
              />
              <span className="truncate text-[10.5px] text-[#686A70]">{entry.label}</span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {NUMBER_PROPS.map((entry) => (
            <label key={entry.prop} className="flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 transition-colors hover:bg-black/[0.025]">
              <span className="w-[52px] shrink-0 truncate text-[10.5px] text-[#686A70]">{entry.label}</span>
              <input
                type="number"
                defaultValue={styles[entry.prop] ? String(px(styles[entry.prop])) : ""}
                placeholder="–"
                step={entry.prop === "opacity" ? 0.05 : entry.prop === "fontWeight" ? 100 : 1}
                min={entry.prop === "opacity" ? 0 : 0}
                max={entry.prop === "opacity" ? 1 : undefined}
                onBlur={(event) => commitNumber(entry.prop, event.target.value, entry.suffix)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitNumber(entry.prop, (event.target as HTMLInputElement).value, entry.suffix);
                    (event.target as HTMLInputElement).blur();
                  }
                }}
                className="min-w-0 flex-1 rounded-[5px] border border-black/[0.08] bg-white px-1.5 py-[3px] text-[10.5px] tabular-nums outline-none focus:border-black/[0.14]"
              />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {SELECT_PROPS.filter((entry) => styles[entry.prop]).map((entry) => (
            <label key={entry.prop} className="flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 transition-colors hover:bg-black/[0.025]">
              <span className="w-[52px] shrink-0 truncate text-[10.5px] text-[#686A70]">{entry.label}</span>
              <select
                defaultValue={styles[entry.prop]}
                onChange={(event) => applySelect(entry.prop, event.target.value)}
                className="min-w-0 flex-1 rounded-[5px] border border-black/[0.08] bg-white px-1 py-[3px] text-[10.5px] outline-none focus:border-black/[0.14]"
              >
                {entry.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {sourceHint ? (
          <p className="mt-0.5 text-[9.5px] leading-[1.4] text-[#A0A2A6]">
            Changes write directly to {sourceHint.split("/").pop()} and the preview refreshes live.
          </p>
        ) : (
          <p className="mt-0.5 text-[9.5px] leading-[1.4] text-[#A0A2A6]">
            No CSS file mapping — changes are applied through the coding agent.
          </p>
        )}
      </div>
    </motion.div>
  );
}

function normalizeColor(value: string) {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) return value;
  if (/^rgb\(/.test(value)) {
    const match = value.match(/\d+/g);
    if (match && match.length >= 3) {
      return `#${match
        .slice(0, 3)
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`;
    }
  }
  return "#000000";
}
