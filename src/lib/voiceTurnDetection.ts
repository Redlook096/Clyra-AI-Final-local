export const VOICE_SPEECH_LEVEL = 0.048;
/** Shorter floor so short replies still commit. */
export const VOICE_MIN_UTTERANCE_MS = 280;
/** Faster end-of-turn for snappier STT without cutting mid-thought. */
export const VOICE_TRAILING_SILENCE_MS = 540;
export const VOICE_SILENCE_ARM_MS = 680;

export function remainingVoiceSilenceMs(lastSpeechAt: number, now = performance.now()) {
  return Math.max(120, VOICE_SILENCE_ARM_MS - (now - lastSpeechAt));
}
