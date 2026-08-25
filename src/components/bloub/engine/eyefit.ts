// Where to anchor the face on a customizer shape.
// Ported from jeremy-prt/bloub (MIT) — src/bot/eyefit.ts
//
// The eyes live on a sphere, and `radiusAtAngle` re-anchors their CENTRE to
// the real contour, pro-rata to the local radius. That places the centre
// correctly, but an eye has a size: the margin left in front of the edge is
// scaled by the same factor, so a silhouette narrow in that direction pushes
// the eye against the edge until the mask clips it — a capsule looked like a
// notch cut into the body on `capsule`, `triangle`, `cloud` and `droplet`.
//
// This module solves the problem ONCE, at load time, producing a lookup
// table of offsets. That choice is the actual fix, far more than the
// geometry that follows: solved inside the render loop, the correction
// reacts to everything that moves at 60fps — gaze drift, the pointer, an
// expression mid-morph — and produces visible jitter. Solved once and
// interpolated between two constants, it's monotonic by construction.

import { EXPRESSIONS, type ExpressionDef } from './expressions'
import { eyePoses } from './face'
import { radiusAtAngle, toPoints, type Point } from './shape'
import { SHAPES } from './skins'
import { STATES, type Pose, type StateDef, type BloubState } from './states'

/** Reference radius for the solver. The rendered offset is in units of this radius. */
const R = 100

/**
 * Maximum idle-liveliness amplitudes, read off `liveliness`: `loopNoise` is
 * bounded to 1 in absolute value, so these sums are exact bounds, not
 * estimates.
 */
const DRIFT_YAW = 5.5 + 1.6
const DRIFT_PITCH = 4.2 + 1.3
/** Centre float, in ball-radius units. */
const DRIFT_X = 0.006
const DRIFT_Y = 0.007

/** The face of a pose, everything the solver needs to place its capsules. */
interface Face {
  gaze: Pose['gaze']
  split: number
  eyes: Pose['eyes']
}

/**
 * A capsule ready to be measured: the segment of its axis, and enough to
 * compute the radius to clear in a given direction.
 */
interface Footprint {
  /** centre, in viewBox units */
  x: number
  y: number
  /** half-vector of the axis */
  ax: number
  ay: number
  /** local disk radius, before transform */
  r: number
  /** columns of the tangent matrix, for the support function */
  m: [number, number, number, number]
}

/** Footprints of a face's two eyes, placed on a profile. */
function footprints(face: Face, sil: Pose['sil'], radii: number[]): Footprint[] {
  const out: Footprint[] = []
  const poses = eyePoses(face.gaze, R, face.split)
  for (let i = 0; i < 2; i++) {
    const e = poses[i]!
    if (e.depth <= 0.02) continue
    const cfg = face.eyes[i]!
    const phi = ((cfg.tilt ?? 0) * Math.PI) / 180
    const cp = Math.cos(phi)
    const sp = Math.sin(phi)
    const ax = e.a * cp + e.c * sp
    const ay = e.b * cp + e.d * sp
    const cx = -e.a * sp + e.c * cp
    const cy = -e.b * sp + e.d * cp

    const hw = Math.max(cfg.w * R, 0.01) / 2
    const hh = Math.max(cfg.h * R, 0.01) / 2
    const r = Math.min(hw, hh)
    const long = hh > hw
    const half = long ? hh - r : hw - r
    const fit = radiusAtAngle(radii, Math.atan2(e.y, e.x) - sil.rot)
    out.push({
      x: e.x * fit,
      y: e.y * fit,
      ax: (long ? cx : ax) * half,
      ay: (long ? cy : ay) * half,
      r,
      m: [ax, ay, cx, cy]
    })
  }
  return out
}

/** Closest approach between a contour and a segment: distance and the clearing direction. */
function approach(pts: Point[], x0: number, y0: number, x1: number, y1: number) {
  const sx = x1 - x0
  const sy = y1 - y0
  const len2 = sx * sx + sy * sy
  let best = Infinity
  let vx = 0
  let vy = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    let t = len2 > 0 ? ((p.x - x0) * sx + (p.y - y0) * sy) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x0 + t * sx - p.x
    const ey = y0 + t * sy - p.y
    const d2 = ex * ex + ey * ey
    if (d2 < best) {
      best = d2
      vx = ex
      vy = ey
    }
  }
  const d = Math.sqrt(best)
  return { d, ux: d > 1e-9 ? vx / d : 0, uy: d > 1e-9 ? vy / d : 0 }
}

/** A trial: capsules to fit inside a contour, plus the reference contour. */
interface Trial {
  footprints: Footprint[]
  reference: Footprint[]
  contour: Point[]
  calContour: Point[]
}

/** Centre float at rest, in viewBox units, folded into the capsule radius. */
const SLACK = Math.hypot(DRIFT_X, DRIFT_Y) * R

/** Tightest margin across a set of capsules, and the direction that clears it. */
function worst(pts: Point[], fps: Footprint[], tx: number, ty: number) {
  let margin = Infinity
  let ux = 0
  let uy = 0
  for (const e of fps) {
    const x = e.x + tx
    const y = e.y + ty
    const a = approach(pts, x - e.ax, y - e.ay, x + e.ax, y + e.ay)
    const [m0, m1, m2, m3] = e.m
    const radius = e.r * Math.hypot(m0 * a.ux + m1 * a.uy, m2 * a.ux + m3 * a.uy) + SLACK
    if (a.d - radius < margin) {
      margin = a.d - radius
      ux = a.ux
      uy = a.uy
    }
  }
  return { margin, ux, uy }
}

const DIRECTIONS = 12
const BISECTION_STEPS = 8

/**
 * The offset to place on both eyes for a given shape, state, and expression.
 *
 * A single TRANSLATION shared by both eyes (an isometry): eye separation,
 * sizes and tilts are preserved to the pixel. DIRECTIONAL SEARCH, not
 * gradient descent: probes a ring of directions and bisects the distance
 * along each — a gradient descent doesn't converge here because clearing one
 * edge pushes the pair toward another.
 */
function solve(trials: Trial[]): { x: number; y: number } {
  if (!trials.length) return { x: 0, y: 0 }

  const marginAt = (tx: number, ty: number) => {
    let m = Infinity
    for (const tr of trials) m = Math.min(m, worst(tr.contour, tr.footprints, tx, ty).margin)
    return m
  }

  let required = Infinity
  for (const tr of trials) {
    required = Math.min(required, worst(tr.calContour, tr.reference, 0, 0).margin)
  }

  // The search must be able to reach the body's centre.
  let mx = 0
  let my = 0
  const fps = trials[0]!.footprints
  for (const e of fps) {
    mx -= e.x / fps.length
    my -= e.y / fps.length
  }
  const reach = Math.max(0.35 * R, Math.hypot(mx, my) * 1.25)

  required = Math.min(required, marginAt(mx, my))

  const start = marginAt(0, 0)
  if (start >= required && start >= 0) return { x: 0, y: 0 }
  const target = Math.max(required, 0)

  let bestX = 0
  let bestY = 0
  let bestNorm = Infinity
  // fallback when nothing fits: the translation that clears the most, probed along the way
  let fallbackX = 0
  let fallbackY = 0
  let fallback = start

  for (let d = 0; d < DIRECTIONS; d++) {
    const a = (d / DIRECTIONS) * Math.PI * 2
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    if (marginAt(ux * reach, uy * reach) < target) {
      for (const k of [0.3, 0.6, 1]) {
        const m = marginAt(ux * reach * k, uy * reach * k)
        if (m > fallback) {
          fallback = m
          fallbackX = ux * reach * k
          fallbackY = uy * reach * k
        }
      }
      continue
    }
    let lo = 0
    let hi = reach
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2
      if (marginAt(ux * mid, uy * mid) >= target) hi = mid
      else lo = mid
    }
    if (hi < bestNorm) {
      bestNorm = hi
      bestX = ux * hi
      bestY = uy * hi
    }
  }

  const x = bestNorm === Infinity ? fallbackX : bestX
  const y = bestNorm === Infinity ? fallbackY : bestY
  return { x: +(x / R).toFixed(6), y: +(y / R).toFixed(6) }
}

/** The face to cover: the expression's if the state accepts it, its own otherwise. */
function faceOf(def: StateDef, pose: Pose, expr: ExpressionDef | null): Face {
  if (def.baseFace && expr) return { gaze: expr.gaze, split: expr.split, eyes: expr.eyes }
  return { gaze: pose.gaze, split: pose.split, eyes: pose.eyes }
}

/** Dates to sample within a state: just one if its pose never moves. */
function dates(def: StateDef): number[] {
  const signature = (p: Pose) =>
    JSON.stringify([p.gaze, p.split, p.eyes, p.sil.rot, p.sil.cx, p.sil.cy, p.sil.sx, p.sil.sy])
  if (signature(def.pose(0)) === signature(def.pose(def.duration))) return [0]
  const n = 3
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * def.duration)
}

/** The offset for one shape on a state and expression, drift included. */
function offsetFor(
  def: StateDef,
  radii: number[],
  expr: ExpressionDef | null
): { x: number; y: number } {
  const trials: Trial[] = []
  for (const t of dates(def)) {
    const pose = def.pose(t)
    const contour = toPoints({ ...pose.sil, radii }, R)
    const calContour = toPoints(pose.sil, R)
    const v = faceOf(def, pose, expr)
    const corners: Face[] = []
    for (const dy of [-DRIFT_YAW, DRIFT_YAW]) {
      for (const dp of [-DRIFT_PITCH, DRIFT_PITCH]) {
        corners.push({
          ...v,
          gaze: { yaw: v.gaze.yaw + dy, pitch: v.gaze.pitch + dp, roll: v.gaze.roll }
        })
      }
    }
    for (const c of corners) {
      trials.push({
        footprints: footprints(c, pose.sil, radii),
        reference: footprints(c, pose.sil, pose.sil.radii),
        contour,
        calContour
      })
    }
  }
  return solve(trials)
}

const NUL = { x: 0, y: 0 } as const

const key = (state: BloubState, expr: string | null) => `${state}|${expr ?? ''}`

/**
 * Offset table, built at import time: one entry per (shape, base-body
 * state, expression). Only `idle` and `swirl` carry the resting face, so
 * only they are keyed by expression.
 */
function build(): Map<number[], Map<string, { x: number; y: number }>> {
  return new Map(
    SHAPES.map((shape) => {
      const per = new Map<string, { x: number; y: number }>()
      for (const def of STATES) {
        if (!def.baseBody) continue
        const expressions = def.baseFace ? [null, ...EXPRESSIONS] : [null]
        for (const expr of expressions) {
          per.set(key(def.id, expr?.id ?? null), offsetFor(def, shape.radii, expr))
        }
      }
      return [shape.radii, per]
    })
  )
}

const OFFSETS = build()

/**
 * Offset to apply to both eyes for this shape on this state, in ball-radius
 * units — the engine rescales it. Zero whenever the shape isn't in the
 * catalogue, which covers `null` and the circle.
 */
export function eyeOffsetFor(
  radii: number[] | null,
  state: BloubState,
  expr: string | null
): { x: number; y: number } {
  if (!radii) return NUL
  const per = OFFSETS.get(radii)
  if (!per) return NUL
  return per.get(key(state, expr)) ?? per.get(key(state, null)) ?? NUL
}
