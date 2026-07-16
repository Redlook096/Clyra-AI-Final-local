export type VoiceConfig = {
  enabled: boolean;
  sampleRate: number;
  chunkMs: number;
  silenceThreshold: number;
  vadSensitivity: number;
  sttModel: string;
  ttsVoice: string;
  temperature: number;
  maxTokens: number;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  pipelineUrl: string;
  redisUrl: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export function loadVoiceConfig(): VoiceConfig {
  const llmApiKey = process.env.DEEPSEEK_API_KEY || process.env.MY_LLM_API_KEY || "";
  const llmBaseUrl =
    process.env.MY_LLM_BASE_URL ||
    (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const llmModel =
    process.env.MY_LLM_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4o-mini");

  return {
    enabled: process.env.VOICE_ENABLED !== "false",
    sampleRate: Number(process.env.VOICE_SAMPLE_RATE ?? 16000),
    chunkMs: Number(process.env.VOICE_CHUNK_MS ?? 20),
    silenceThreshold: Number(process.env.VOICE_SILENCE_THRESHOLD ?? 0.35),
    vadSensitivity: Number(process.env.VOICE_VAD_SENSITIVITY ?? 0.5),
    sttModel: process.env.VOICE_STT_MODEL ?? "large-v3",
    ttsVoice: process.env.VOICE_TTS_VOICE ?? "Ryan",
    temperature: Number(process.env.VOICE_TEMPERATURE ?? 0.55),
    maxTokens: Number(process.env.VOICE_MAX_TOKENS ?? 160),
    livekitUrl: process.env.LIVEKIT_URL ?? "",
    livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
    livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
    pipelineUrl: process.env.VOICE_PIPELINE_URL ?? "http://127.0.0.1:8787",
    redisUrl: process.env.REDIS_URL ?? "",
    llmBaseUrl,
    llmApiKey,
    llmModel,
  };
}

export function voiceConfigPublic(config: VoiceConfig) {
  return {
    enabled: config.enabled,
    sampleRate: config.sampleRate,
    chunkMs: config.chunkMs,
    sttModel: config.sttModel,
    ttsVoice: config.ttsVoice,
    transport: config.livekitUrl ? "livekit" : "websocket",
  };
}
