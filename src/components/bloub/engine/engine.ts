// The deterministic, clockless animation engine.
// Ported from jeremy-prt/bloub (MIT) — src/bot/engine.ts

import { arcRender, type ArcRender, type DotRender } from './decor'
import { blendExpression, type ExpressionDef } from './expressions'
import { eyeOffsetFor } from './eyefit'
import { blinkScale, eyePoses, liveliness } from './face'
import { clamp, easings, lerp, r2 } from './math'
import {
  blend,
  capsulePath,
  closedPath,
  radiusAtAngle,
  toPoints,
  type Point,
  type Silhouette
} from './shape'
import { STATE_BY_ID, type Pose, type BloubState, type StateDef } from './states'

export interface RenderedEye {
  d: string
  matrix: string
  alpha: number
}

export interface BotFrame {
  bodyPath: string
  bodyAlpha: number
  eyes: RenderedEye[]
  dots: DotRender[]
  /** true = dots pass behind the body (burst particles) */
  dotsBehind: boolean
  arcs: ArcRender[]
  notif: { x: number; y: number; r: number } | null
  notch: { x: number; y: number; r: number } | null
}

/**
 * Where the bot points its gaze when something external drives it — the
 * mouse pointer, or a caller-supplied gaze target.
 *
 * `yaw` / `pitch` are ABSOLUTE directions that replace the pose's own as
 * `mix` rises: this must be mixed by the ENGINE, since only it knows the
 * pose at this instant.
 *
 * `mix` says how much the outside controls DIRECTION (0 = not at all).
 * `wander` says, separately, how much automatic drift remains.
 * `spin` is a full turn to travel EN ROUTE, in degrees, that fades to 0 on
 * arrival — since the eyes live on a sphere, a turn takes them behind the
 * ball and back, and lands exactly on target (`-360deg` being the same
 * angle as `0`).
 */
export interface Look {
  yaw: number
  pitch: number
  mix: number
  spin: number
  wander: number
  /**
   * Optional absolute head-tilt override, degrees. Unlike yaw/pitch this
   * is NOT part of the pointer-follow model (`lookTarget` never sets it) —
   * it only exists so a caller can force the head upright (0) instead of
   * the state's own signature tilt, the same way `setGaze` forces a fixed
   * direction. Blended in by `mix` like everything else here.
   */
  roll?: number
}

const NO_LOOK: Look = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 }

const lerpLook = (a: Look, b: Look, t: number): Look => ({
  yaw: lerp(a.yaw, b.yaw, t),
  pitch: lerp(a.pitch, b.pitch, t),
  mix: lerp(a.mix, b.mix, t),
  spin: lerp(a.spin, b.spin, t),
  wander: lerp(a.wander, b.wander, t),
  roll: a.roll !== undefined || b.roll !== undefined ? lerp(a.roll ?? 0, b.roll ?? 0, t) : undefined
})

const lerpEye = (a: Pose['eyes'][number], b: Pose['eyes'][number], t: number) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  open: lerp(a.open, b.open, t),
  tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t)
})

/** Blend of two poses. Decor crossfades in opacity, not geometry. */
function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out = 1 - t
  return {
    sil: blend(a.sil, b.sil, t),
    offX: lerp(a.offX, b.offX, t),
    offY: lerp(a.offY, b.offY, t),
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t)
    },
    split: lerp(a.split, b.split, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    bodyAlpha: lerp(a.bodyAlpha, b.bodyAlpha, t),
    dots: [
      ...a.dots.map((d) => ({ ...d, opacity: d.opacity * out })),
      ...b.dots.map((d) => ({ ...d, opacity: d.opacity * t }))
    ],
    arcs: [
      ...a.arcs.map((r) => ({ ...r, id: `a${r.id}`, opacity: r.opacity * out })),
      ...b.arcs.map((r) => ({ ...r, id: `b${r.id}`, opacity: r.opacity * t }))
    ],
    // the badge belongs to a single one of the two states, it doesn't blend
    notif: t < 0.5 ? a.notif : b.notif,
    dotsBehind: t < 0.5 ? a.dotsBehind : b.dotsBehind
  }
}

/**
 * Clockless engine: `sample(t)` is a pure function of time.
 *
 * Practical consequence: pause, resume, slow-motion and seeking to an
 * arbitrary date all give exactly the same image, and rendering is testable
 * without a DOM.
 */
export class BotEngine {
  /** resting ball radius, in viewBox units */
  readonly scale: number

  private cur: BloubState
  private prev: BloubState | null = null
  /**
   * FROZEN departure pose, set only when a state change arrives while a
   * crossfade is already in progress. See `setState`.
   */
  private departFrozen: Pose | null = null
  private tCur = 0
  private tPrev = 0
  private blinkAt = -10
  private pts: Point[] = []
  private shape: number[] | null = null
  private shapePrev: number[] | null = null
  private shapeAt = -10
  private expr: ExpressionDef | null = null
  private exprPrev: ExpressionDef | null = null
  private exprAt = -10
  private look: Look = NO_LOOK
  private lookPrev: Look = NO_LOOK
  private lookAt = -10
  /** current catch-up duration; see `LOOK_MORPH`, its default value */
  private lookMorph = 0.24

  /** morph duration when the body shape changes */
  static readonly SHAPE_MORPH = 0.45

  /**
   * Gaze catch-up duration when following a target. Shorter than
   * `SHAPE_MORPH`: a following gaze should look attentive, not sluggish.
   */
  static readonly LOOK_MORPH = 0.24

  constructor(
    scale = 100,
    initial: BloubState = 'idle',
    shape: number[] | null = null,
    expression: ExpressionDef | null = null
  ) {
    this.scale = scale
    this.cur = initial
    this.shape = shape
    this.expr = expression
  }

  /** Resting expression. Like the shape, it slides to the new value instead of jumping. */
  setExpression(expression: ExpressionDef | null, now = 0) {
    if (expression === this.expr) return
    this.exprPrev = this.expr
    this.expr = expression
    this.exprAt = now
  }

  /** Effective expression at instant `now`, morph in progress included. */
  private exprAtTime(now: number): ExpressionDef | null {
    const to = this.expr
    const from = this.exprPrev
    if (!to || !from) return to
    const k = (now - this.exprAt) / BotEngine.SHAPE_MORPH
    if (k >= 1) return to
    return blendExpression(from, to, easings.easeOutQuint(clamp(k)))
  }

  /**
   * Chosen customizer shape. Only replaces the body on `baseBody` states:
   * on others the silhouette IS the animation and must not be overridden.
   *
   * The change morphs rather than snapping: since every shape is sampled at
   * the same angles, interpolating radii is enough.
   */
  setShape(radii: number[] | null, now = 0) {
    if (radii === this.shape) return
    this.shapePrev = this.shape
    this.shape = radii
    this.shapeAt = now
  }

  /**
   * Effective shape at instant `now`, morph in progress included.
   * Does NOT null out `shapePrev` at the end of the morph: `sample` must
   * remain a pure function of time, so replaying a past date must give back
   * the intermediate image.
   */
  private shapeAtTime(now: number): number[] | null {
    const to = this.shape
    const from = this.shapePrev
    if (!to || !from) return to
    const k = (now - this.shapeAt) / BotEngine.SHAPE_MORPH
    if (k >= 1) return to
    const t = easings.easeOutQuint(clamp(k))
    return to.map((r, i) => lerp(from[i] ?? r, r, t))
  }

  /**
   * New gaze target, `null` to return to the state's own.
   * Restarts from the CURRENT value (not the previous target): this is
   * called on every pointer move, and restarting from the old target would
   * make the gaze twitch instead of glide.
   */
  setLook(look: Look | null, now: number, morph = BotEngine.LOOK_MORPH) {
    /*
     * A non-finite target is rejected. The engine KEEPS the last one: a
     * single stray NaN would propagate to every frame forever. This has
     * happened for real — a zero-size `getBoundingClientRect` gives `0/0`
     * on the caller's side.
     */
    if (look && !Number.isFinite(look.yaw + look.pitch + look.mix + look.spin + look.wander)) {
      return
    }
    this.lookPrev = this.lookAtTime(now)
    this.look = look ?? NO_LOOK
    this.lookAt = now
    this.lookMorph = morph
  }

  /** Effective gaze at instant `now`, catch-up in progress included. */
  private lookAtTime(now: number): Look {
    const k = (now - this.lookAt) / this.lookMorph
    if (k >= 1) return this.look
    return lerpLook(this.lookPrev, this.look, easings.easeOutQuint(clamp(k)))
  }

  private posed(
    def: StateDef,
    t: number,
    shape: number[] | null,
    expr: ExpressionDef | null
  ): Pose {
    let pose = def.pose(t)
    if (def.baseBody && shape) {
      pose = { ...pose, sil: { ...pose.sil, radii: shape } }
    }
    if (def.baseFace && expr) {
      pose = { ...pose, gaze: expr.gaze, split: expr.split, eyes: expr.eyes }
    }
    return pose
  }

  /**
   * Eye offset at instant `now` for a given state, in ball-radius units.
   * Looked up in a table and interpolated, never recomputed — see
   * `eyefit.ts` for why that distinction is the entire fix.
   */
  private offsetAtTime(now: number, state: BloubState): { x: number; y: number } {
    const alongAxis = (
      start: number,
      duration: number,
      a: { x: number; y: number },
      b: { x: number; y: number }
    ) => {
      if (a === b) return b
      const k = (now - start) / duration
      if (k >= 1) return b
      const t = easings.easeOutQuint(clamp(k))
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
    }

    const forShape = (radii: number[] | null) =>
      alongAxis(
        this.exprAt,
        BotEngine.SHAPE_MORPH,
        eyeOffsetFor(radii, state, this.exprPrev?.id ?? null),
        eyeOffsetFor(radii, state, this.expr?.id ?? null)
      )

    return alongAxis(this.shapeAt, BotEngine.SHAPE_MORPH, forShape(this.shapePrev), forShape(this.shape))
  }

  get state(): BloubState {
    return this.cur
  }

  /**
   * Restarts on `id` with NO previous state, as if the engine were freshly
   * constructed on it. `setState` alone can't do this: it keeps the
   * outgoing state to crossfade from, which is correct for playback but
   * wrong when rewinding to the start of a sequence.
   */
  reset(id: BloubState, now: number) {
    this.cur = id
    this.prev = null
    this.departFrozen = null
    this.tCur = now
    this.tPrev = now
    this.blinkAt = -10
  }

  /**
   * Origin of the current crossfade: the frozen pose if there is one,
   * otherwise the outgoing state evaluated at its own elapsed time — so
   * still animating, which is intentional.
   */
  private origin(now: number, shape: number[] | null, expr: ExpressionDef | null): Pose | null {
    if (this.departFrozen) return this.departFrozen
    if (!this.prev) return null
    const prevDef = STATE_BY_ID.get(this.prev)!
    return this.posed(prevDef, Math.max(0, now - this.tPrev), shape, expr)
  }

  /** Composite pose at instant `now`, crossfade in progress included. */
  private composedPose(now: number): Pose {
    const def = STATE_BY_ID.get(this.cur)!
    const shape = this.shapeAtTime(now)
    const expr = this.exprAtTime(now)
    const pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr)
    const since = now - this.tCur
    if (since >= def.morph) return pose
    const origin = this.origin(now, shape, expr)
    if (!origin) return pose
    return blendPose(origin, pose, easings.easeOutQuint(clamp(since / def.morph)))
  }

  /**
   * Dated state change.
   *
   * The engine keeps only ONE history slot, so a change arriving mid-fade
   * would replace the blend origin with the FULL pose of the outgoing
   * state, instead of the partially-blended image actually on screen
   * (measured on `idle -> wide -> idle` at 100ms: 35.9px jump vs 8.0px of
   * normal motion). So we freeze the current composite pose and blend from
   * it — continuous no matter how many changes are chained.
   *
   * Only in that case, though: freezing on every change would stop the
   * outgoing state's own animation mid-fade (`alert`'s "!" would freeze
   * mid-travel) when there is nothing to fix outside a morph.
   */
  setState(id: BloubState, now: number) {
    if (id === this.cur) return
    const morph = STATE_BY_ID.get(this.cur)!.morph
    const midFade = this.prev !== null && now - this.tCur < morph
    this.departFrozen = midFade ? this.composedPose(now) : null
    this.prev = this.cur
    this.tPrev = this.tCur
    this.cur = id
    this.tCur = now
    // In the video, every shape change is hidden by a blink.
    if (STATE_BY_ID.get(id)?.blinkIn) this.blinkAt = now
  }

  /** Forces a single blink pulse (close-open, ~0.2s) starting at `now`. */
  blink(now: number) {
    this.blinkAt = now
  }

  sample(now: number): BotFrame {
    const R = this.scale
    const def = STATE_BY_ID.get(this.cur)!
    const shape = this.shapeAtTime(now)
    const expr = this.exprAtTime(now)
    let pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr)
    let offset = this.offsetAtTime(now, this.cur)

    // --- transition ---------------------------------------------------
    const since = now - this.tCur
    // The previous state is never purged: `since < def.morph` is enough to
    // ignore it once the fade has passed, and forgetting it would make the
    // engine non-replayable.
    const origin = since < def.morph ? this.origin(now, shape, expr) : null
    if (origin) {
      // Exponential ease-out: the curve measured off the video. The body
      // never overshoots (only the badge and the eye-opening do).
      const ratio = easings.easeOutQuint(clamp(since / def.morph))
      pose = blendPose(origin, pose, ratio)
      const left = this.prev
      if (left) {
        const before = this.offsetAtTime(now, left)
        offset = {
          x: lerp(before.x, offset.x, ratio),
          y: lerp(before.y, offset.y, ratio)
        }
      }
    }

    // --- idle liveliness -------------------------------------------------
    const alive = pose.eyeAlpha > 0.01
    const look = this.lookAtTime(now)
    const life = liveliness(now, { wander: alive ? look.wander : 0, blink: alive })

    const gaze = {
      // Both look targets REPLACE the pose's own (see `Look`), and the
      // travelled turn is subtracted along the way. Drift is added AFTER
      // the blend so it survives a turned head with no pointer.
      yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - look.spin,
      pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
      // roll follows nothing external: the bot's head is tilted -13deg in
      // the video, and rolling it with the cursor would break that signature
      roll:
        (look.roll !== undefined ? lerp(pose.gaze.roll, look.roll, look.mix) : pose.gaze.roll) +
        life.dRoll
    }

    // blink triggered by the state change, on top of the schedule
    const forced = clamp((now - this.blinkAt) / 0.2)
    const forcedLid = forced < 1 ? Math.abs(forced * 2 - 1) : 1
    const lid = Math.min(life.lid, forcedLid)

    const offX = pose.offX + life.driftX
    const offY = pose.offY + life.driftY

    // --- body ------------------------------------------------------------
    const sil: Silhouette = {
      ...pose.sil,
      cx: pose.sil.cx + offX,
      cy: pose.sil.cy + offY,
      sy: pose.sil.sy * life.breath
    }
    const bodyPath = closedPath(toPoints(sil, R, this.pts))

    // --- eyes --------------------------------------------------------------
    // Eyes live on a radius-1 sphere; whenever the silhouette isn't a
    // circle any more, we rescale by the real radius in their direction,
    // otherwise they overflow and the mask clips them.
    const bodyRadius = (x: number, y: number) =>
      radiusAtAngle(pose.sil.radii, Math.atan2(y, x) - pose.sil.rot)

    const eyes: RenderedEye[] = []
    if (pose.eyeAlpha > 0.01) {
      const poses = eyePoses(gaze, R, pose.split)
      for (let i = 0; i < 2; i++) {
        const e = poses[i]!
        if (e.depth <= 0.02) continue
        const cfg = pose.eyes[i]!
        const fit = bodyRadius(e.x, e.y)
        // Eye's own tilt: compose the tangent frame with a rotation in the
        // eye's own plane (Basis x Rot). This is what allows mirrored tilts
        // between the two eyes.
        const phi = ((cfg.tilt ?? 0) * Math.PI) / 180
        const cp = Math.cos(phi)
        const sp = Math.sin(phi)
        const ax = e.a * cp + e.c * sp
        const ay = e.b * cp + e.d * sp
        const cx2 = -e.a * sp + e.c * cp
        const cy2 = -e.b * sp + e.d * cp
        // Blink applies AFTER all of that: it's a squash on screen, not
        // along the capsule's own tilted axis.
        const k = blinkScale(Math.min(lid, cfg.open))
        eyes.push({
          d: capsulePath(cfg.w * R, cfg.h * R),
          matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(cx2)},${r2(cy2 * k)},${r2(e.x * fit + (offX + offset.x) * R)},${r2(e.y * fit + (offY + offset.y) * R)})`,
          alpha: pose.eyeAlpha * clamp(e.depth / 0.12)
        })
      }
    }

    // --- decor -------------------------------------------------------------
    const dots = pose.dots
      .filter((p) => p.opacity > 0.01 && p.r > 0.0005)
      .map((p) => ({ ...p, x: (p.x + offX) * R, y: (p.y + offY) * R, r: p.r * R }))

    const nFit = pose.notif ? bodyRadius(pose.notif.x, pose.notif.y) : 1
    const nx = pose.notif ? (pose.notif.x * nFit + offX) * R : 0
    const ny = pose.notif ? (pose.notif.y * nFit + offY) * R : 0
    const notif = pose.notif ? { x: nx, y: ny, r: pose.notif.r * R } : null
    const notch = pose.notif ? { x: nx, y: ny, r: pose.notif.notch * R } : null

    return {
      bodyPath,
      bodyAlpha: pose.bodyAlpha,
      eyes,
      dots,
      dotsBehind: pose.dotsBehind,
      arcs: pose.arcs
        .filter((a) => a.opacity > 0.01)
        .map((a) => arcRender(a.seed, a.t, R, a.id, a.opacity)),
      notif,
      notch
    }
  }
}
