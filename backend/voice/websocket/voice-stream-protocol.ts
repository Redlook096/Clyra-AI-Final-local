export type VoiceClientMessage =
  | { type: "audio"; sessionId: string; codec: "pcm16"; data: string; seq: number }
  | { type: "utterance"; sessionId: string; text: string }
  | { type: "mute"; sessionId: string; muted: boolean }
  | { type: "barge_in"; sessionId: string }
  | { type: "playback_done"; sessionId: string }
  | { type: "flush"; sessionId: string }
  | { type: "ping"; sessionId: string };

export type VoiceServerMessage =
  | { type: "ready"; sessionId: string; sampleRate: number }
  | { type: "status"; sessionId: string; status: "listening" | "thinking" | "speaking" | "ended" }
  | { type: "transcript_partial"; sessionId: string; text: string; confidence?: number }
  | { type: "transcript_final"; sessionId: string; text: string; confidence?: number }
  | { type: "llm_token"; sessionId: string; token: string }
  | { type: "llm_done"; sessionId: string; text: string }
  | { type: "tts_format"; sessionId: string; responseId: string; generation: number; codec: "pcm16"; sampleRate: number }
  | { type: "tts_chunk"; sessionId: string; codec: "pcm16"; data: string; seq: number; sampleRate?: number }
  | { type: "tts_done"; sessionId: string; responseId?: string; generation?: number }
  | { type: "barge_in"; sessionId: string }
  | { type: "error"; sessionId?: string; message: string }
  | { type: "pong"; sessionId: string };

export function parseVoiceClientMessage(raw: string): VoiceClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as VoiceClientMessage;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encodeVoiceServerMessage(message: VoiceServerMessage) {
  return JSON.stringify(message);
}
