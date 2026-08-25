// Public surface of the Bloub animation engine.

export { BotEngine, type BotFrame, type Look, type RenderedEye } from './engine'
export { STATES, STATE_BY_ID, SEQUENCE, POSES, type BloubState, type EyeCfg } from './states'
export {
  EXPRESSIONS,
  EXPRESSION_BY_ID,
  DEFAULT_EXPRESSION,
  type BloubExpression,
  type ExpressionDef
} from './expressions'
export { SHAPES, SHAPE_BY_ID, DEFAULT_SHAPE, mixHex, type BloubShape, type ShapeDef } from './skins'
export { RAYON, DEMI_VIEWBOX } from './repere'
export { NOTIF_BLUE } from './decor'
export { lookTarget, tourLook, TOUR_TIME, TURN_TIME, MOODS, type Aim, type GazeScript } from './gaze'

import type { BloubState } from './states'

/**
 * Generic AI-conversation states an app usually needs to reflect on an
 * avatar. The mapping below is a sensible default; callers can override any
 * subset via `mapAiState`'s second argument.
 */
export type AiAvatarState =
  | 'WAITING'
  | 'LISTENING'
  | 'THINKING'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'NOTIFICATION'
  | 'WARNING'
  | 'ERROR'
  | 'SLEEPING'
  | 'GENERATING'
  | 'LAUNCHING'
  | 'COMPLETE'
  | 'DISCONNECT'

export const DEFAULT_AI_STATE_MAP: Record<AiAvatarState, BloubState> = {
  WAITING: 'idle',
  LISTENING: 'wide',
  THINKING: 'thinking',
  PROCESSING: 'orbit',
  SUCCESS: 'wink',
  NOTIFICATION: 'notify',
  WARNING: 'alert',
  ERROR: 'exclaim',
  SLEEPING: 'sleep',
  GENERATING: 'orbit',
  LAUNCHING: 'play',
  COMPLETE: 'wink',
  DISCONNECT: 'comet'
}

/**
 * Maps a generic AI-conversation state to a {@link BloubState}, using
 * `DEFAULT_AI_STATE_MAP` unless `overrides` supplies a different mapping for
 * that key.
 */
export function mapAiState(
  aiState: AiAvatarState,
  overrides?: Partial<Record<AiAvatarState, BloubState>>
): BloubState {
  return overrides?.[aiState] ?? DEFAULT_AI_STATE_MAP[aiState]
}
