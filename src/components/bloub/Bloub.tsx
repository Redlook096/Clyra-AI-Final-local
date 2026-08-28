import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BotEngine,
  DEMI_VIEWBOX,
  RAYON,
  NOTIF_BLUE,
  SHAPE_BY_ID,
  EXPRESSION_BY_ID,
  STATE_BY_ID,
  DEFAULT_SHAPE,
  DEFAULT_EXPRESSION,
  mixHex,
  lookTarget,
  tourLook,
  TOUR_TIME,
  TURN_TIME,
  type BotFrame,
  type BloubState,
  type BloubShape,
  type BloubExpression,
  type Look,
} from "./engine";
import { clamp, easings, lerp } from "./engine/math";

export type {
  BloubState,
  BloubShape,
  BloubExpression,
  AiAvatarState,
} from "./engine";
export { mapAiState, DEFAULT_AI_STATE_MAP } from "./engine";

export interface BloubProps {
  /** Current catalogue animation. Defaults to "idle". */
  state?: BloubState;
  /** Rendered pixel size (square). Defaults to 160. */
  size?: number;
  /** Body / eye-mask ink colour, any CSS hex. Defaults to a near-black ink. */
  color?: string;
  /** Body silhouette used by states with `baseBody: true`. Defaults to "circle". */
  shape?: BloubShape;
  /** Rest-face expression, used only by `baseFace` states (idle). */
  expression?: BloubExpression;
  /**
   * Colour behind the avatar. Used to fog burst particles as they recede
   * and to back the eye-holes so occluded decor (rings passing behind the
   * body) doesn't bleed through them. Match your page background.
   */
  background?: string;
  /** Damped pointer-following gaze. Only applies while a base-face state (idle) is active. */
  followPointer?: boolean;
  /**
   * Plays the entrance sequence once on mount / on the rising edge: the
   * round body appears alone, the eyes sweep a full turn around the sphere,
   * then it settles and morphs smoothly into the configured `shape`.
   */
  animateEntrance?: boolean;
  /** Respect prefers-reduced-motion by dropping large moving sequences. Defaults to true. */
  respectReducedMotion?: boolean;
  /**
   * Whether the eye holes are cut at all. Defaults to `true`. Set to
   * `false` to render the bare silhouette with no eyes (e.g. while a boot
   * sequence is still loading); flipping it back to `true` plays a smooth
   * reveal followed automatically by a single wake-up blink, rather than
   * snapping the holes in.
   */
  eyesVisible?: boolean;
  /**
   * Live 0–1 voice amplitude. While set and the active state is a base-face
   * one (idle), it adds a small audio-reactive pulse on top of the normal
   * breathing — the closest thing this eyes-only character has to "talking",
   * driven by the real signal rather than a fake animation.
   */
  audioLevel?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Overrides the auto-generated aria-label. */
  ariaLabel?: string;
}

export interface BloubHandle {
  setState: (state: BloubState) => void;
  setShape: (shape: BloubShape) => void;
  setExpression: (expression: BloubExpression) => void;
  setColor: (hex: string) => void;
  /**
   * Manual gaze override (absolute yaw/pitch, degrees). Wins over
   * pointer-follow and entrance. `roll` is optional and off by default
   * (the state's own signature head-tilt is kept) — pass 0 to force the
   * head upright instead. `wander` (0–1, default 0) layers the normal idle
   * micro-drift/saccades back on top of the fixed direction — 0 holds
   * perfectly still, higher values read as more alive.
   */
  setGaze: (yaw: number, pitch: number, roll?: number, wander?: number) => void;
  /** Releases a manual gaze set via `setGaze`, handing control back to pointer-follow / the state's own pose. */
  releaseGaze: () => void;
  /** Restarts the entrance sequence programmatically. */
  playEntrance: () => void;
  /** Freezes the current frame; gaze/state/shape setters still take effect on resume. */
  pause: () => void;
  resume: () => void;
  /** Forces a single blink pulse (close-open, ~0.2s) right now. */
  blink: () => void;
}

const REDUCED_MOTION_STATES = new Set<BloubState>(["orbit", "comet", "play", "swirl", "burst"]);

function useReducedMotion(enabled: boolean): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [enabled]);
  return enabled && reduced;
}

/** Renders a single decor dot: either a plain circle or a custom shape (`d`), e.g. the alert teardrop. */
function DotShape({
  dot,
  ink,
  background,
}: {
  dot: BotFrame["dots"][number];
  ink: string;
  background: string;
}) {
  const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex(background, ink, dot.depth));
  if (dot.d) {
    return (
      <path
        d={dot.d}
        fill={fill}
        opacity={dot.opacity}
        transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
      />
    );
  }
  return <circle cx={dot.x} cy={dot.y} r={dot.r} fill={fill} opacity={dot.opacity} />;
}

export const Bloub = forwardRef<BloubHandle, BloubProps>(function Bloub(
  {
    state = "idle",
    size = 160,
    color = "#0a0a0c",
    shape = DEFAULT_SHAPE,
    expression = DEFAULT_EXPRESSION,
    background = "#ffffff",
    followPointer = false,
    animateEntrance = false,
    respectReducedMotion = true,
    eyesVisible = true,
    audioLevel = 0,
    className,
    style,
    ariaLabel,
  },
  ref,
) {
  const reducedMotion = useReducedMotion(respectReducedMotion);

  const shapeRadii = useMemo(() => SHAPE_BY_ID.get(shape)?.radii ?? null, [shape]);
  const expressionDef = useMemo(() => EXPRESSION_BY_ID.get(expression) ?? null, [expression]);

  const engineRef = useRef<BotEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new BotEngine(RAYON, state, shapeRadii, expressionDef);
  }
  const engine = engineRef.current;

  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));
  const [colorState, setColorState] = useState(color);
  useEffect(() => setColorState(color), [color]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const uid = useMemo(() => Math.random().toString(36).slice(2, 8), []);
  const maskId = `bloub-mask-${uid}`;

  const clockRef = useRef(0);
  const lastRef = useRef(0);
  const rafRef = useRef(0);
  const runningRef = useRef(true);

  // pointer tracking
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const aimingRef = useRef(false);
  const turnSinceRef = useRef(0);

  // entrance script
  const entranceActiveRef = useRef(false);
  const entranceSinceRef = useRef(0);
  const entranceMorphedRef = useRef(false);

  // manual gaze override
  const manualGazeRef = useRef(false);

  // eye reveal envelope (bare silhouette <-> eyes cut), plus the one
  // automatic wake-up blink that follows a hidden -> visible flip
  const EYE_REVEAL_DURATION = 0.26;
  const eyesVisibleRef = useRef(eyesVisible);
  const eyeRevealValueRef = useRef(eyesVisible ? 1 : 0);
  const eyeRevealFromRef = useRef(eyesVisible ? 1 : 0);
  const eyeRevealSinceRef = useRef(-10);
  const eyeRevealWakeQueuedRef = useRef(false);

  // smoothed voice-amplitude pulse (base-face states only)
  const audioLevelRef = useRef(audioLevel);
  audioLevelRef.current = audioLevel;
  const audioPulseRef = useRef(0);

  const redraw = () => setFrame(engine.sample(clockRef.current));

  // --- imperative handle ---------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      setState: (next) => {
        engine.setState(next, clockRef.current);
        redraw();
      },
      setShape: (next) => {
        engine.setShape(SHAPE_BY_ID.get(next)?.radii ?? null, clockRef.current);
        redraw();
      },
      setExpression: (next) => {
        engine.setExpression(EXPRESSION_BY_ID.get(next) ?? null, clockRef.current);
        redraw();
      },
      setColor: (hex) => setColorState(hex),
      setGaze: (yaw, pitch, roll, wander = 0) => {
        manualGazeRef.current = true;
        engine.setLook({ yaw, pitch, mix: 1, spin: 0, wander, roll }, clockRef.current);
        redraw();
      },
      releaseGaze: () => {
        manualGazeRef.current = false;
        engine.setLook(null, clockRef.current);
        redraw();
      },
      playEntrance: () => {
        entranceActiveRef.current = true;
        entranceMorphedRef.current = false;
        entranceSinceRef.current = clockRef.current;
        engine.reset("idle", clockRef.current);
        engine.setShape(null, clockRef.current);
      },
      pause: () => {
        runningRef.current = false;
        cancelAnimationFrame(rafRef.current);
      },
      resume: () => {
        if (runningRef.current) return;
        runningRef.current = true;
        lastRef.current = 0;
        rafRef.current = requestAnimationFrame(stepRef.current!);
      },
      blink: () => {
        engine.blink(clockRef.current);
        redraw();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine],
  );

  // --- prop-driven engine updates --------------------------------------
  const stateRef = useRef(state);
  useEffect(() => {
    if (stateRef.current === state) return;
    stateRef.current = state;
    engine.setState(state, clockRef.current);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const shapeKeyRef = useRef(shapeRadii);
  useEffect(() => {
    if (shapeKeyRef.current === shapeRadii) return;
    shapeKeyRef.current = shapeRadii;
    // Entrance owns the shape while it is morphing in; let it finish first.
    if (entranceActiveRef.current && !entranceMorphedRef.current) return;
    engine.setShape(shapeRadii, clockRef.current);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeRadii]);

  const exprKeyRef = useRef(expressionDef);
  useEffect(() => {
    if (exprKeyRef.current === expressionDef) return;
    exprKeyRef.current = expressionDef;
    engine.setExpression(expressionDef, clockRef.current);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expressionDef]);

  useEffect(() => {
    if (eyesVisibleRef.current === eyesVisible) return;
    const wasVisible = eyesVisibleRef.current;
    eyesVisibleRef.current = eyesVisible;
    eyeRevealFromRef.current = eyeRevealValueRef.current;
    eyeRevealSinceRef.current = clockRef.current;
    // Waking up (hidden -> visible) ends in a single blink, once the reveal
    // has finished opening the holes — closing them again immediately would
    // read as a flicker, not a blink.
    if (eyesVisible && !wasVisible) eyeRevealWakeQueuedRef.current = true;
  }, [eyesVisible]);

  // --- entrance sequence -------------------------------------------------
  useEffect(() => {
    if (!animateEntrance) {
      entranceActiveRef.current = false;
      return;
    }
    entranceActiveRef.current = true;
    entranceMorphedRef.current = false;
    entranceSinceRef.current = clockRef.current;
    engine.reset("idle", clockRef.current);
    engine.setShape(null, clockRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animateEntrance]);

  // --- pointer listeners ---------------------------------------------
  useEffect(() => {
    if (!followPointer) return;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (aimingRef.current) {
        engine.setLook(null, clockRef.current, TURN_TIME);
        aimingRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followPointer]);

  // --- animation loop --------------------------------------------------
  // `tick` closes over this render's props (followPointer, reducedMotion...);
  // it is stashed in a ref every render so the self-scheduling `step` below
  // (created once) always calls the latest version instead of a stale one.
  function tick(ms: number) {
    const dt = lastRef.current ? Math.min((ms - lastRef.current) / 1000, 0.064) : 0;
    lastRef.current = ms;
    clockRef.current += dt;
    const clock = clockRef.current;

    if (!manualGazeRef.current) {
      const entranceDue = TOUR_TIME + 0.3;
      if (entranceActiveRef.current && clock - entranceSinceRef.current < entranceDue) {
        engine.setLook(tourLook(clock - entranceSinceRef.current), clock, 1 / 60);
      } else if (entranceActiveRef.current) {
        if (!entranceMorphedRef.current) {
          entranceMorphedRef.current = true;
          engine.setShape(shapeKeyRef.current, clock);
          engine.setLook(null, clock);
        }
        entranceActiveRef.current = false;
        if (followPointer) aim(clock);
      } else if (followPointer) {
        aim(clock);
      } else if (aimingRef.current) {
        engine.setLook(null, clock, TURN_TIME);
        aimingRef.current = false;
      }
    }

    const isBaseFace = STATE_BY_ID.get(engine.state)?.baseFace ?? false;
    const audioTarget = isBaseFace ? clamp(audioLevelRef.current) : 0;
    audioPulseRef.current = lerp(audioPulseRef.current, audioTarget, 1 - Math.pow(0.001, dt));

    const revealT = clamp((clock - eyeRevealSinceRef.current) / EYE_REVEAL_DURATION);
    eyeRevealValueRef.current = lerp(
      eyeRevealFromRef.current,
      eyesVisibleRef.current ? 1 : 0,
      easings.easeOutQuint(revealT),
    );
    if (eyeRevealWakeQueuedRef.current && revealT >= 1) {
      eyeRevealWakeQueuedRef.current = false;
      engine.blink(clock);
    }

    setFrame(engine.sample(clock));
  }

  function aim(clock: number) {
    const isBaseFace = STATE_BY_ID.get(engine.state)?.baseFace ?? false;
    if (!isBaseFace) {
      if (aimingRef.current) {
        engine.setLook(null, clock, TURN_TIME);
        aimingRef.current = false;
      }
      return;
    }
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    if (!aimingRef.current) turnSinceRef.current = clock;
    const halfW = Math.max(1, window.innerWidth / 2);
    const halfH = Math.max(1, window.innerHeight / 2);
    const pointer = pointerRef.current;
    engine.setLook(
      lookTarget({
        nx: pointer ? clamp((pointer.x - (box.left + box.width / 2)) / halfW, -1, 1) : 0,
        ny: pointer ? clamp((pointer.y - (box.top + box.height / 2)) / halfH, -1, 1) : 0,
        tour: easings.easeOutQuint(clamp((clock - turnSinceRef.current) / TURN_TIME)),
        pointer: pointer !== null,
      }),
      clock,
    );
    aimingRef.current = true;
  }

  const tickRef = useRef(tick);
  tickRef.current = tick;

  const stepRef = useRef<((ms: number) => void) | null>(null);
  if (!stepRef.current) {
    stepRef.current = (ms: number) => {
      rafRef.current = requestAnimationFrame(stepRef.current!);
      tickRef.current(ms);
    };
  }

  useEffect(() => {
    runningRef.current = true;
    lastRef.current = 0;
    rafRef.current = requestAnimationFrame(stepRef.current!);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ink = colorState;
  const vb = DEMI_VIEWBOX;

  const visibleArcs = reducedMotion && REDUCED_MOTION_STATES.has(engine.state) ? [] : frame.arcs;
  const dotsBehind = frame.dotsBehind && !(reducedMotion && engine.state === "burst");
  const visibleDots =
    reducedMotion && engine.state === "burst" && frame.dotsBehind ? [] : frame.dots;

  const label =
    ariaLabel ??
    `Bloub avatar, ${state}${expression && expression !== "neutral" ? `, ${expression}` : ""}`;

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`${-vb} ${-vb} ${vb * 2} ${vb * 2}`}
      role="img"
      aria-label={label}
      className={className}
      style={style}
    >
      <defs>
        {/* Eyes are true holes cut through the ink layer, not shapes painted
            on top: they clip themselves against the silhouette automatically
            as they slide toward the edge. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-vb} y={-vb} width={vb * 2} height={vb * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path
              key={i}
              d={eye.d}
              transform={eye.matrix}
              opacity={eye.alpha * eyeRevealValueRef.current}
              fill="#000"
            />
          ))}
          {frame.notch && <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />}
        </mask>

        {visibleArcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop key={i} offset={i / (arc.grad.stops.length - 1)} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/*
        Real-audio-driven pulse for "talking": a small extra scale on top of
        the engine's own breathing, only ever non-zero on base-face states
        (idle) while `audioLevel` is fed in — no separate fake "speaking"
        state, just the true signal.
      */}
      <g transform={`scale(${1 + audioPulseRef.current * 0.05})`}>
        {/* rear half of the orbit rings: drawn before the body, so occluded by it */}
        <g fill="none" strokeLinecap="round" aria-hidden="true">
          {visibleArcs.map((arc) => (
            <path
              key={`b${arc.id}`}
              d={arc.back}
              stroke={`url(#${uid}-${arc.id})`}
              strokeWidth={arc.width}
              opacity={arc.opacity}
            />
          ))}
        </g>

        {/* burst particles that pass behind the core */}
        {dotsBehind && (
          <g aria-hidden="true">
            {visibleDots.map((dot, i) => (
              <DotShape key={`pb${i}`} dot={dot} ink={ink} background={background} />
            ))}
          </g>
        )}

        <g opacity={frame.bodyAlpha}>
          {/*
            Opaque backing at the exact body shape, under the body itself: the
            eyes are holes, so without this the occluded rear-arcs/particles
            drawn above would show up INSIDE the eyes too.
          */}
          <path d={frame.bodyPath} fill={background} />
          <g mask={`url(#${maskId})`}>
            <rect x={-vb} y={-vb} width={vb * 2} height={vb * 2} fill={ink} />
          </g>
        </g>

        {!dotsBehind && (
          <g aria-hidden="true">
            {visibleDots.map((dot, i) => (
              <DotShape key={`pf${i}`} dot={dot} ink={ink} background={background} />
            ))}
          </g>
        )}

        {frame.notif && (
          <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} aria-hidden="true" />
        )}

        {/* front half of the orbit rings */}
        <g fill="none" strokeLinecap="round" aria-hidden="true">
          {visibleArcs.map((arc) => (
            <path
              key={`f${arc.id}`}
              d={arc.front}
              stroke={`url(#${uid}-${arc.id})`}
              strokeWidth={arc.width}
              opacity={arc.opacity}
            />
          ))}
        </g>
      </g>
    </svg>
  );
});

Bloub.displayName = "Bloub";
