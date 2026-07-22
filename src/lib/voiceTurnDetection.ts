export const VOICE_SPEECH_LEVEL = 0.07;
export const VOICE_MIN_UTTERANCE_MS = 520;
export const VOICE_TRAILING_SILENCE_MS = 1_150;
export const VOICE_SILENCE_ARM_MS = 1_260;

export function remainingVoiceSilenceMs(lastSpeechAt: number, now = performance.now()) {
  return Math.max(140, VOICE_SILENCE_ARM_MS - (now - lastSpeechAt));
}
