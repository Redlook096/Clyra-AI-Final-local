import { useEffect, useRef, useState } from "react";
import { Bloub, type BloubHandle, type BloubShape, type BloubState } from "./Bloub";
import { SEQUENCE } from "./engine";
import type { BloubExpression } from "./engine";

/**
 * Dev-only visual test harness for the Bloub avatar: every state side by
 * side, plus controls to scrub colour/shape, toggle reduced motion, and fire
 * a rapid-transition stress sequence (state changes arriving mid-morph).
 *
 * Not part of the production UI. Only mount this behind `import.meta.env.DEV`
 * or a dev-only, unlinked route — never in the real navigation.
 */

const SHAPES: BloubShape[] = [
  "circle",
  "pebble",
  "squircle",
  "capsule",
  "triangle",
  "hexagon",
  "cloud",
  "droplet",
];

const EXPRESSIONS: BloubExpression[] = [
  "neutral",
  "attentive",
  "surprised",
  "excited",
  "happy",
  "laughing",
  "angry",
  "sad",
  "scared",
  "suspicious",
  "confused",
  "curious",
  "proud",
  "shy",
  "unimpressed",
  "sleepy",
];

const STRESS_SEQUENCE: BloubState[] = ["idle", "thinking", "wide", "notify", "orbit", "wink"];

function StateCard({
  id,
  color,
  shape,
  forcedReducedMotion,
}: {
  id: BloubState;
  color: string;
  shape: BloubShape;
  forcedReducedMotion: boolean;
}) {
  const ref = useRef<BloubHandle>(null);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        background: "#fff",
        border: "1px solid #e5e7eb",
      }}
    >
      <Bloub
        ref={ref}
        state={id}
        color={color}
        shape={shape}
        size={112}
        background="#ffffff"
        respectReducedMotion={forcedReducedMotion}
      />
      <span style={{ fontSize: 12, fontFamily: "monospace", color: "#475569" }}>{id}</span>
    </div>
  );
}

export default function BloubDevHarness() {
  const [color, setColor] = useState("#3b82f6");
  const [shape, setShape] = useState<BloubShape>("circle");
  const [expression, setExpression] = useState<BloubExpression>("neutral");
  const [forcedReducedMotion, setForcedReducedMotion] = useState(false);
  const [paused, setPaused] = useState(false);
  const [followPointer, setFollowPointer] = useState(false);
  const [animateEntrance, setAnimateEntrance] = useState(false);

  const scrubRef = useRef<BloubHandle>(null);
  const stressRef = useRef<BloubHandle>(null);
  const [stressLabel, setStressLabel] = useState("idle");

  // index.html paints a full-viewport #clyra-preboot-surface (z-index 10000)
  // over React's first commit, normally cleared by App's own boot sequence.
  // This harness never mounts App, so clear it here instead.
  useEffect(() => {
    document.getElementById("clyra-preboot-surface")?.remove();
  }, []);

  function runStressSequence() {
    const handle = stressRef.current;
    if (!handle) return;
    // Fire state changes in rapid succession, well inside each other's morph
    // window, to exercise the "freeze the composite pose" crossfade path.
    STRESS_SEQUENCE.forEach((s, i) => {
      window.setTimeout(() => {
        handle.setState(s);
        setStressLabel(s);
      }, i * 180);
    });
  }

  function togglePause() {
    const handle = scrubRef.current;
    if (!handle) return;
    if (paused) handle.resume();
    else handle.pause();
    setPaused(!paused);
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", background: "#f8fafc", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Bloub dev harness</h1>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
        Dev-only. Not linked from app navigation, not part of production UI.
      </p>

      <section style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24, alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          Shape
          <select value={shape} onChange={(e) => setShape(e.target.value as BloubShape)}>
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          Idle expression
          <select value={expression} onChange={(e) => setExpression(e.target.value as BloubExpression)}>
            {EXPRESSIONS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={forcedReducedMotion}
            onChange={(e) => setForcedReducedMotion(e.target.checked)}
          />
          Respect reduced motion
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={followPointer} onChange={(e) => setFollowPointer(e.target.checked)} />
          Follow pointer (scrub avatar)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={animateEntrance}
            onChange={(e) => setAnimateEntrance(e.target.checked)}
          />
          Replay entrance (scrub avatar)
        </label>
      </section>

      <section style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 32 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: 16,
            borderRadius: 16,
            background: "#fff",
            border: "1px solid #e5e7eb",
          }}
        >
          <Bloub
            ref={scrubRef}
            state="idle"
            color={color}
            shape={shape}
            expression={expression}
            size={160}
            background="#ffffff"
            followPointer={followPointer}
            animateEntrance={animateEntrance}
            respectReducedMotion={forcedReducedMotion}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
          </div>
          <span style={{ fontSize: 12, color: "#64748b" }}>Scrub avatar</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: 16,
            borderRadius: 16,
            background: "#fff",
            border: "1px solid #e5e7eb",
          }}
        >
          <Bloub
            ref={stressRef}
            state="idle"
            color={color}
            shape={shape}
            size={160}
            background="#ffffff"
            respectReducedMotion={forcedReducedMotion}
          />
          <button onClick={runStressSequence}>Fire rapid-transition stress sequence</button>
          <span style={{ fontSize: 12, fontFamily: "monospace", color: "#475569" }}>
            last requested: {stressLabel}
          </span>
        </div>
      </section>

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>All states</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12 }}>
        {[...SEQUENCE, "swirl" as BloubState].map((id) => (
          <StateCard key={id} id={id} color={color} shape={shape} forcedReducedMotion={forcedReducedMotion} />
        ))}
      </div>
    </div>
  );
}
