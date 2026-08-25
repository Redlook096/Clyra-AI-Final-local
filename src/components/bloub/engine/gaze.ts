// Where the bot looks when it follows the pointer, and the scripted gaze
// used by the entrance sequence.
// Ported from jeremy-prt/bloub (MIT) — src/ui/gaze.ts

import type { Look } from './engine'
import { clamp, easings } from './math'

/**
 * Head-orientation angles, degrees. CHOSEN, not measured — the reference
 * video shows no pointer tracking. Wide enough to read apart from idle
 * drift (+-7deg yaw, +-5.5 pitch), restrained enough that no eye passes
 * behind the sphere's limb.
 */
export const YAW_MAX = 16
export const PITCH_MAX = 13

/**
 * Height the gaze holds at, pointer centred. CHOSEN: slightly above the
 * equator, which reads as attentive rather than absent. An ABSOLUTE value,
 * not relative to any expression — that's the entire point (see `lookTarget`).
 */
export const PITCH = 10

/** Direction the head settles toward when following: away from its rest pose. */
export const TURN = 26

/**
 * A full turn travelled EN ROUTE, in degrees: the eyes don't slide across
 * the face, they go around the ball first. Free, because the eyes live on a
 * sphere: past 90deg yaw they cross the limb, the engine drops them from
 * the image, then they reappear on the other side. And it lands EXACTLY on
 * target, `-360deg` being the same angle as `0`.
 */
export const SPIN = 360

/** Turn duration. Slightly shorter than the entrance's ring block. */
export const TURN_TIME = 1.1

/**
 * Moods traversed while the bot follows the pointer.
 *
 * All have ZERO ROLL, and that's the selection criterion: yaw and pitch are
 * absolute during tracking, but roll isn't — it tilts the head, so it moves
 * the eyes vertically, and a mood at -15deg followed by one at +8 would make
 * them jump.
 */
export const MOODS: readonly string[] = [
  'surprised',
  'happy',
  'laughing',
  'excited',
  'proud',
  'unimpressed'
]

/**
 * A SCRIPTED gaze: evaluated every frame with the time elapsed since the
 * script started, in seconds. RULE: it must END at `mix: 0`, so the state's
 * own pose takes over cleanly with no final glide.
 */
export type GazeScript = (t: number) => Look

/**
 * "The turn": the ball looks like it's spinning in place.
 *
 * `mix` stays at ZERO throughout — no direction is imposed, only `spin`
 * fades, sending the eyes BEHIND the ball before bringing them back exactly
 * where the chosen expression puts them.
 *
 * Ease-in-OUT, not the project's usual exponential ease-out: this isn't a
 * value settling, it's an object turning.
 *
 * NOTE: this turn only plays on a CIRCLE. On a non-circular shape the eyes
 * are re-anchored to the real contour and would stutter while turning.
 */
export const TOUR_TIME = 1.5

export const tourLook: GazeScript = (t) => ({
  yaw: 0,
  pitch: 0,
  mix: 0,
  spin: SPIN * (1 - easings.easeInOutCubic(clamp(t / TOUR_TIME))),
  wander: 1
})

export interface Aim {
  /** horizontal pointer offset from the bot's centre, -1 to 1 (right positive) */
  nx: number
  /** vertical offset, -1 to 1, screen space (down positive) */
  ny: number
  /** entrance progress, 0 to 1 */
  tour: number
  /** false = no known pointer: the head stays turned, but keeps living */
  pointer: boolean
}

/**
 * Gaze target.
 *
 * `tour` drives everything: it raises the pose's grip (`mix`) and fades the
 * travelled turn (`spin`) at the same time. At 0 the state's own pose
 * commands alone; at 1 the head is settled and follows the pointer.
 */
export function lookTarget({ nx, ny, tour, pointer }: Aim): Look {
  return {
    yaw: -TURN + nx * YAW_MAX,
    // positive pitch = looking up, while screen y goes down
    pitch: PITCH - ny * PITCH_MAX,
    mix: tour,
    spin: SPIN * (1 - tour),
    // without a pointer the head stays turned but keeps its drift, so
    // arriving via keyboard/touch doesn't leave a perfectly frozen avatar
    wander: pointer ? 0 : 1
  }
}
