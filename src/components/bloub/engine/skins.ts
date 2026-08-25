// Customizer shapes and colours. Unlike the animation silhouettes
// (profiles.ts), these are NOT measured off the video: they're built
// analytically to match the original customizer's shape grid.
// Ported from jeremy-prt/bloub (MIT) — src/bot/skins.ts, with ids translated
// to English for this port's public API.

import { PROFILE_SAMPLES } from './profiles'
import {
  hullOfCircles,
  profileFromPolygon,
  regularPolygonProfile,
  superellipseProfile,
  unionOfCirclesProfile
} from './shape'

export type BloubShape =
  | 'circle'
  | 'pebble'
  | 'squircle'
  | 'capsule'
  | 'triangle'
  | 'hexagon'
  | 'cloud'
  | 'droplet'

export interface ShapeDef {
  id: BloubShape
  radii: number[]
}

/** Rescales the peak radius to `max` so every shape reads at the same visual weight. */
function normalize(radii: number[], max = 1): number[] {
  const peak = Math.max(...radii)
  if (peak <= 0) return radii
  const k = max / peak
  return radii.map((r) => r * k)
}

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * Math.PI * 2)

/** Pebble: circle deformed by two low harmonics, so irregular but smooth. */
const pebble = normalize(
  ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02
)

/** Cloud: union of bumps, wide at the bottom, two lobes on top. */
const cloud = normalize(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 }
  ]),
  1.02
)

/** Droplet: large disk at the bottom, tapered point at the top. */
const droplet = normalize(
  profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0),
  1.04
)

/** Lying capsule: envelope of two side-by-side disks. */
const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0)

export const SHAPES: ShapeDef[] = [
  { id: 'circle', radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: 'pebble', radii: pebble },
  // 1.15 and not 1.02: on a superellipse the max radius is the diagonal, so
  // normalizing on it gives a shape that reads smaller than the circle.
  { id: 'squircle', radii: normalize(superellipseProfile(4.2), 1.15) },
  { id: 'capsule', radii: capsule },
  // -90deg: a vertex points to the top of the screen (y is down)
  { id: 'triangle', radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg: vertices left and right, so flat top/bottom edges
  { id: 'hexagon', radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: 'cloud', radii: cloud },
  { id: 'droplet', radii: droplet }
]

// Indexed by `string`, not `BloubShape`: callers may look up a value read
// from a prop that hasn't been validated.
export const SHAPE_BY_ID = new Map<string, ShapeDef>(SHAPES.map((s) => [s.id, s]))
export const DEFAULT_SHAPE: BloubShape = 'circle'

/** Blends two hex colours. Used for the depth fog of burst particles. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (h: string) => {
    const v = parseInt(h.slice(1), 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const a = parse(from)
  const b = parse(to)
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * t))
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
