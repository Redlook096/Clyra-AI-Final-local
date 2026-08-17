import { useEffect, useRef, type MutableRefObject } from "react";
import type { VoiceWaveformSignal } from "./voice/VoiceWaveform";

/** Kept for settings compatibility; the physical orb is intentionally blue. */
export type OrbColorTheme = "default" | "ocean" | "sunset" | "forest" | "mono" | "noir";

export type AiOrbState = "idle" | "connecting" | "listening" | "thinking" | "response_ready" | "speaking" | "interrupted" | "error";

type AiOrbProps = {
  colorTheme?: OrbColorTheme;
  introActive?: boolean;
  state?: AiOrbState;
  /** A coarse fallback when an analyser ref is not available. */
  level?: number;
  /** Live mic/TTS spectrum; read in the animation loop without React renders. */
  signalRef?: MutableRefObject<VoiceWaveformSignal>;
  className?: string;
};

type OrbPhysics = {
  energy: number;
  energyVelocity: number;
  flow: number;
  flowVelocity: number;
  pressure: number;
  pressureVelocity: number;
  phase: number;
  lastState: AiOrbState;
  responseStart: number;
};

const TAU = Math.PI * 2;

function clamp(value: number, lower = 0, upper = 1) {
  return Math.min(upper, Math.max(lower, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function stateBaseEnergy(state: AiOrbState) {
  switch (state) {
    case "connecting": return 0.2;
    case "listening": return 0.14;
    case "thinking": return 0.3;
    case "response_ready": return 0.44;
    case "speaking": return 0.24;
    case "interrupted": return 0.36;
    case "error": return 0.1;
    default: return 0.035;
  }
}

function drawPath(context: CanvasRenderingContext2D, center: number, radius: number, time: number, physics: OrbPhysics, state: AiOrbState, bands: Float32Array | undefined) {
  const points = 88;
  const energy = physics.energy;
  const thinking = state === "thinking" ? 1 : 0;
  const speaking = state === "speaking" ? 1 : 0;
  const listening = state === "listening" ? 1 : 0;
  context.beginPath();
  for (let index = 0; index <= points; index += 1) {
    const angle = (index / points) * TAU;
    const spectrum = bands?.length ? bands[Math.floor((index / points) * (bands.length - 1))] ?? 0 : 0;
    const broad = Math.sin(angle * 2 + physics.flow * 1.6) * (0.006 + energy * 0.012);
    const micro = Math.sin(angle * 5 - physics.phase * 1.9) * (0.0015 + energy * 0.006 + spectrum * 0.005);
    const cognition = thinking * Math.sin(angle * 3.1 + physics.phase * 0.72) * 0.011;
    const voicePressure = (listening + speaking) * spectrum * 0.014;
    const asymmetry = Math.cos(angle - physics.flow) * (speaking ? 0.012 : 0.004) * energy;
    const r = radius * (1 + broad + micro + cognition + voicePressure + asymmetry);
    const x = center + Math.cos(angle) * r;
    const y = center + Math.sin(angle) * r;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

function gradient(context: CanvasRenderingContext2D, x0: number, y0: number, r0: number, x1: number, y1: number, r1: number, stops: Array<[number, string]>) {
  const result = context.createRadialGradient(x0, y0, r0, x1, y1, r1);
  stops.forEach(([position, color]) => result.addColorStop(position, color));
  return result;
}

/**
 * A single canvas, shared physics model. The renderer is driven directly by
 * rAF and the existing analyser ref; it never schedules React updates per
 * audio frame. That keeps listening and TTS response smooth under load.
 */
export function AiOrb({
  colorTheme = "default",
  introActive = false,
  state = "idle",
  level = 0,
  signalRef,
  className,
}: AiOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  const signalRefRef = useRef(signalRef);
  const visibleRef = useRef(true);

  stateRef.current = state;
  levelRef.current = level;
  signalRefRef.current = signalRef;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const physics: OrbPhysics = { energy: 0.035, energyVelocity: 0, flow: 0.2, flowVelocity: 0, pressure: 0, pressureVelocity: 0, phase: 0, lastState: stateRef.current, responseStart: 0 };
    let frame = 0;
    let previous = performance.now();
    let size = 0;
    let dpr = 1;
    let disposed = false;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      size = Math.max(1, Math.min(rect.width, rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { visibleRef.current = entry?.isIntersecting ?? true; }, { threshold: 0.02 });
    intersection.observe(canvas);
    resize();

    const render = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(render);
      if (document.hidden || !visibleRef.current || size <= 1) return;
      const dt = Math.min(34, Math.max(8, now - previous)) / 16.667;
      previous = now;
      const currentState = stateRef.current;
      if (currentState !== physics.lastState) {
        if (currentState === "response_ready" || (physics.lastState === "thinking" && currentState === "speaking")) physics.responseStart = now;
        if (currentState === "interrupted") physics.pressureVelocity -= 0.08;
        physics.lastState = currentState;
      }
      const signal = signalRefRef.current?.current;
      const signalFresh = Boolean(signal && now - signal.updatedAt < 480);
      const rawLevel = signalFresh ? signal!.level : levelRef.current;
      const audioEnergy = clamp(Math.pow(Math.max(0, rawLevel), 0.66));
      const bands = signalFresh ? signal!.bands : undefined;
      const targetEnergy = stateBaseEnergy(currentState) + audioEnergy * (currentState === "speaking" ? 0.76 : currentState === "listening" ? 0.66 : 0.12);
      const stiffness = targetEnergy > physics.energy ? 0.2 : 0.065;
      physics.energyVelocity = (physics.energyVelocity + (targetEnergy - physics.energy) * stiffness * dt) * Math.pow(0.72, dt);
      physics.energy = clamp(physics.energy + physics.energyVelocity * dt, 0, 1);
      const flowTarget = currentState === "thinking" ? 0.72 : currentState === "speaking" ? 0.42 + audioEnergy * 0.42 : currentState === "listening" ? 0.2 + audioEnergy * 0.35 : 0.08;
      physics.flowVelocity = (physics.flowVelocity + (flowTarget - physics.flow) * 0.025 * dt) * Math.pow(0.89, dt);
      physics.flow += physics.flowVelocity * dt;
      const responseWave = physics.responseStart ? (1 - smoothstep(0, 440, now - physics.responseStart)) : 0;
      const pressureTarget = audioEnergy * 0.7 + responseWave * 0.55 + (currentState === "interrupted" ? 0.45 : 0);
      physics.pressureVelocity = (physics.pressureVelocity + (pressureTarget - physics.pressure) * 0.13 * dt) * Math.pow(0.68, dt);
      physics.pressure = clamp(physics.pressure + physics.pressureVelocity * dt);
      physics.phase += (0.0022 + physics.flow * 0.012 + audioEnergy * 0.02) * dt;

      context.clearRect(0, 0, size, size);
      const center = size / 2;
      const radius = size * 0.355;
      if (reducedMotion) {
        physics.energy = Math.min(physics.energy, 0.14);
        physics.pressure = 0;
      }

      // Atmospheric light stays close to its source, never reads as neon.
      const haloRadius = radius * (1.5 + physics.energy * 0.22);
      context.fillStyle = gradient(context, center - radius * 0.12, center - radius * 0.18, radius * 0.04, center, center, haloRadius, [
        [0, `rgba(70, 150, 255, ${0.13 + physics.energy * 0.1})`],
        [0.45, `rgba(27, 98, 214, ${0.045 + physics.energy * 0.045})`],
        [1, "rgba(27, 98, 214, 0)"],
      ]);
      context.beginPath(); context.arc(center, center, haloRadius, 0, TAU); context.fill();

      context.save();
      drawPath(context, center, radius, now, physics, currentState, bands);
      context.clip();

      // Deep liquid body with independently drifting optical density.
      context.fillStyle = gradient(context, center - radius * 0.42, center + radius * 0.35, radius * 0.02, center, center, radius * 1.28, [
        [0, "#8bd2ff"], [0.24, "#2588e8"], [0.62, "#0b4ca7"], [1, "#061d52"],
      ]);
      context.fillRect(0, 0, size, size);
      const liquidX = center + Math.cos(physics.phase * 1.25) * radius * 0.24;
      const liquidY = center + Math.sin(physics.phase * 0.9) * radius * 0.19;
      context.globalCompositeOperation = "screen";
      context.fillStyle = gradient(context, liquidX, liquidY, radius * 0.03, liquidX, liquidY, radius * (0.72 + physics.energy * 0.18), [
        [0, `rgba(202, 238, 255, ${0.38 + physics.energy * 0.22})`], [0.34, "rgba(75, 169, 255, .30)"], [1, "rgba(24, 110, 226, 0)"],
      ]);
      context.fillRect(0, 0, size, size);
      const counterX = center + Math.cos(-physics.phase * 0.77 + 1.9) * radius * 0.31;
      const counterY = center + Math.sin(-physics.phase * 1.1 + 0.8) * radius * 0.27;
      context.fillStyle = gradient(context, counterX, counterY, radius * 0.02, counterX, counterY, radius * 0.6, [
        [0, "rgba(18, 75, 181, .68)"], [0.54, "rgba(5, 42, 119, .2)"], [1, "rgba(2, 25, 75, 0)"],
      ]);
      context.fillRect(0, 0, size, size);

      // Slow, folded caustics: not rings, and each drifts on a different phase.
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      for (let index = 0; index < 3; index += 1) {
        const phase = physics.phase * (0.68 + index * 0.13) + index * 2.08;
        context.strokeStyle = `rgba(205, 241, 255, ${0.055 + physics.energy * 0.09})`;
        context.lineWidth = Math.max(0.65, radius * (0.009 + index * 0.002));
        context.beginPath();
        context.moveTo(center - radius * 0.8, center + Math.sin(phase) * radius * 0.34);
        context.bezierCurveTo(
          center - radius * 0.25, center - Math.cos(phase * 1.3) * radius * 0.52,
          center + radius * 0.22, center + Math.sin(phase * 1.7) * radius * 0.5,
          center + radius * 0.8, center - Math.cos(phase * 0.88) * radius * 0.27,
        );
        context.stroke();
      }
      context.restore();

      // The glass membrane is drawn last so all inner behaviour reads as one material.
      drawPath(context, center, radius, now, physics, currentState, bands);
      context.fillStyle = "rgba(255,255,255,.025)";
      context.fill();
      context.strokeStyle = `rgba(202, 236, 255, ${0.38 + physics.energy * 0.24})`;
      context.lineWidth = Math.max(0.9, radius * 0.022);
      context.stroke();
      context.save();
      context.clip();
      context.globalCompositeOperation = "screen";
      context.fillStyle = gradient(context, center - radius * 0.32, center - radius * 0.44, radius * 0.01, center - radius * 0.28, center - radius * 0.38, radius * 0.68, [
        [0, "rgba(255,255,255,.8)"], [0.16, "rgba(224,244,255,.26)"], [0.55, "rgba(153,214,255,0)"], [1, "rgba(153,214,255,0)"],
      ]);
      context.fillRect(0, 0, size, size);
      context.restore();
    };
    frame = requestAnimationFrame(render);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); intersection.disconnect(); };
  }, []);

  return (
    <div
      className={`clyra-ai-orb-shell clyra-ai-orb-shell--liquid${introActive ? " clyra-ai-orb-shell--intro" : ""}${className ? ` ${className}` : ""}`}
      data-orb-state={state}
      data-orb-theme={colorTheme}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="clyra-liquid-orb" />
    </div>
  );
}
