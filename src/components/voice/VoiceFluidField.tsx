import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Application, BlurFilter, Graphics } from "pixi.js";

export type VoiceFluidHandle = {
  /** 0-1 smoothed audio energy. Imperative so a 60fps mic/TTS analyser loop
   * never triggers a React re-render. */
  setEnergy: (energy: number) => void;
};

/**
 * Audio-reactive blue fluid field, GPU-rendered via Pixi (WebGL). Height,
 * displacement, and luminosity all derive from `setEnergy()`, driven by the
 * hook's real local/remote WebRTC audio-level events -- never from text
 * length or a timer.
 */
export const VoiceFluidField = forwardRef<VoiceFluidHandle, { className?: string }>(
  function VoiceFluidField({ className }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const energyRef = useRef(0);
    const displayEnergyRef = useRef(0);
    const phaseRef = useRef(0);

    useImperativeHandle(ref, () => ({
      setEnergy: (energy: number) => {
        energyRef.current = Math.max(0, Math.min(1, energy));
      },
    }));

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      // React StrictMode double-invokes this effect in dev; a generation
      // token lets a stale init's continuation recognize it's been
      // superseded instead of racing the real instance's teardown. Pixi's
      // resize plugin (`resizeTo`) doesn't tolerate init/destroy overlap
      // well, so sizing is handled manually via ResizeObserver instead.
      let live = true;
      let destroyed = false;
      const app = new Application();
      const blob = new Graphics();
      const blur = new BlurFilter({ strength: 18, quality: 3 });
      let resizeObserver: ResizeObserver | null = null;

      const destroyOnce = () => {
        if (destroyed) return;
        destroyed = true;
        app.destroy(true, { children: true });
      };

      const initPromise = app
        .init({
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          width: Math.max(1, host.clientWidth),
          height: Math.max(1, host.clientHeight),
        })
        .then(() => {
          if (!live) {
            destroyOnce();
            return;
          }
          host.appendChild(app.canvas);
          blob.filters = [blur];
          app.stage.addChild(blob);

          resizeObserver = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) app.renderer.resize(width, height);
          });
          resizeObserver.observe(host);

          app.ticker.add((ticker) => {
            const dt = ticker.deltaTime / 60;
            // Critically-damped spring toward the latest energy sample keeps
            // motion elastic rather than snapping frame to frame.
            displayEnergyRef.current += (energyRef.current - displayEnergyRef.current) * Math.min(1, dt * 6);
            phaseRef.current += dt * (0.6 + displayEnergyRef.current * 1.8);

            const { width, height } = app.renderer;
            const energy = displayEnergyRef.current;
            const baseline = height * (0.6 - energy * 0.18);
            const amplitude = 14 + energy * 54;
            const points = 40;

            blob.clear();
            const path: [number, number][] = [];
            for (let i = 0; i <= points; i++) {
              const x = (width / points) * i;
              const wave =
                Math.sin(phaseRef.current + i * 0.35) * amplitude +
                Math.sin(phaseRef.current * 1.7 + i * 0.18) * amplitude * 0.4;
              path.push([x, baseline + wave]);
            }
            blob.moveTo(0, height);
            blob.lineTo(path[0][0], path[0][1]);
            for (let i = 1; i < path.length; i++) blob.lineTo(path[i][0], path[i][1]);
            blob.lineTo(width, height);
            blob.closePath();
            blob.fill({ color: 0x5b9dff, alpha: 0.4 + energy * 0.32 });
          });
        })
        .catch(() => undefined);

      return () => {
        live = false;
        resizeObserver?.disconnect();
        void initPromise.then(destroyOnce);
      };
    }, []);

    return <div ref={hostRef} className={className} />;
  },
);
