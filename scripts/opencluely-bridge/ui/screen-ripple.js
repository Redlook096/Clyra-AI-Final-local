/* A single shared Clyra screen-motion primitive used by minimise, restore and
 * control-presence transitions. It intentionally has no idle work. */
(() => {
  const canvas = document.getElementById('ripple');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const params = { duration: 920, sourceY: -0.075, crest: 12, halo: 42, maxAlpha: .78 };
  function run(options = {}) {
    const duration = reduced ? 180 : Number(options.duration || params.duration);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = innerWidth, height = innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const origin = { x: width * (options.originX ?? .5), y: height * (options.originY ?? params.sourceY) };
    const maxRadius = Math.max(...[[0,0],[width,0],[0,height],[width,height]].map(([x,y]) => Math.hypot(x-origin.x,y-origin.y))) + 72;
    const start = performance.now(); let frame;
    const ease = (t) => 1 - Math.pow(1-t, 2.35);
    const arc = (radius, lineWidth, stroke) => { if (radius <= 0 || !Number.isFinite(radius)) return; ctx.beginPath(); ctx.arc(origin.x,origin.y,radius,.015*Math.PI,.985*Math.PI); ctx.lineWidth=lineWidth; ctx.lineCap='round'; ctx.strokeStyle=stroke; ctx.stroke(); };
    const paint = (now) => {
      const p = Math.min(1,(now-start)/duration); const release = p < .12 ? (p/.12)*.055 : .055 + ease((p-.12)/.88)*.945; const r=maxRadius*release;
      ctx.clearRect(0,0,width,height);
      if (p < .14) { const a=(p/.14)*.55; const glow=ctx.createRadialGradient(origin.x,0,0,origin.x,0,90); glow.addColorStop(0,`rgba(255,255,255,${a})`); glow.addColorStop(.34,`rgba(168,216,255,${a*.66})`); glow.addColorStop(1,'rgba(100,181,255,0)'); ctx.fillStyle=glow; ctx.fillRect(origin.x-100,0,200,128); }
      const energy=p < .82 ? 1 : 1-(p-.82)/.18;
      arc(r+8, 2, `rgba(10,132,255,${.45*energy})`);
      arc(r, params.halo, `rgba(130,202,255,${.075*energy})`);
      arc(r-1, params.crest, `rgba(183,226,255,${.32*energy})`);
      arc(r-3, 3.5, `rgba(255,255,255,${params.maxAlpha*energy})`);
      arc(r-42, 18, `rgba(142,207,255,${.055*energy})`);
      if (p < 1) frame=requestAnimationFrame(paint); else { ctx.clearRect(0,0,width,height); window.electronAPI?.rippleFinished?.(); }
    };
    cancelAnimationFrame(frame); frame=requestAnimationFrame(paint);
  }
  window.ClyraScreenRipple = { run };
  window.electronAPI?.onScreenRipple?.((_event, options) => run(options || {}));
})();
