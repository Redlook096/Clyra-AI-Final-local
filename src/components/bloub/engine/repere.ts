// The frame every engine output is expressed in.
// Ported from jeremy-prt/bloub (MIT) — src/bot/repere.ts

/**
 * Resting-ball radius, in viewBox units. This is the `scale` passed to
 * `BotEngine`. Chosen, not measured — it's the unit of work, so measurements
 * taken off the video are independent of display size.
 */
export const RAYON = 100

/**
 * Half the displayed viewBox side. The margin beyond the radius is where the
 * decorative rings live.
 *
 * Not a free value: the orbit rings and the comet ribbons reach up to 1.4x
 * the radius, i.e. 140. Nothing bounds them at runtime — it's the hand-tuned
 * `RINGS`/`COMET_RIBBONS` arrays (decor.ts) that keep them under 158.
 */
export const DEMI_VIEWBOX = 158
