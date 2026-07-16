export type VoiceStage =
  | "session_created"
  | "stt_partial"
  | "stt_final"
  | "llm_token"
  | "tts_chunk"
  | "barge_in"
  | "reconnect"
  | "error";

export type VoiceLatencySample = {
  stage: VoiceStage;
  ms: number;
  sessionId: string;
  at: number;
};

export class VoiceMetrics {
  private samples = new Map<string, VoiceLatencySample[]>();

  record(sessionId: string, stage: VoiceStage, ms: number) {
    const list = this.samples.get(sessionId) ?? [];
    list.push({ stage, ms, sessionId, at: Date.now() });
    this.samples.set(sessionId, list.slice(-200));
  }

  summary(sessionId: string) {
    const list = this.samples.get(sessionId) ?? [];
    const byStage = new Map<VoiceStage, number[]>();
    for (const sample of list) {
      const bucket = byStage.get(sample.stage) ?? [];
      bucket.push(sample.ms);
      byStage.set(sample.stage, bucket);
    }
    const avg = (values: number[]) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return {
      sessionId,
      count: list.length,
      sttMs: avg(byStage.get("stt_final") ?? []),
      llmMs: avg(byStage.get("llm_token") ?? []),
      ttsMs: avg(byStage.get("tts_chunk") ?? []),
      bargeIns: (byStage.get("barge_in") ?? []).length,
      reconnects: (byStage.get("reconnect") ?? []).length,
    };
  }

  clear(sessionId: string) {
    this.samples.delete(sessionId);
  }
}

export const voiceMetrics = new VoiceMetrics();
