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
  asyncApiKey: string;
  asyncModel: string;
  asyncFallbackModel: string;
  asyncVoiceId: string;
  asyncSampleRate: number;
  asyncSttEnabled: boolean;
  asyncSttModel: string;
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
    asyncApiKey: process.env.ASYNC_API_KEY ?? "",
    asyncModel: process.env.ASYNC_TTS_MODEL ?? "async_flash_v1.5",
    asyncFallbackModel: process.env.ASYNC_TTS_FALLBACK_MODEL ?? "async_flash_v1.5",
    asyncVoiceId: process.env.ASYNC_VOICE_ID ?? "e0f39dc4-f691-4e78-bba5-5c636692cc04",
    asyncSampleRate: Number(process.env.ASYNC_TTS_SAMPLE_RATE ?? 44100),
    // Async ASR is opt-in until the configured provider has completed its
    // compatibility handshake. The local pipeline remains the dependable
    // default and the desktop never silently loses transcription because an
    // external streaming endpoint rejects a connection.
    asyncSttEnabled: process.env.ASYNC_STT_ENABLED === "true" && Boolean(process.env.ASYNC_API_KEY),
    asyncSttModel: process.env.ASYNC_STT_MODEL ?? "async_asr_v1.0",
  };
}

export function voiceConfigPublic(config: VoiceConfig) {
  return {
    enabled: config.enabled,
    sampleRate: config.sampleRate,
    chunkMs: config.chunkMs,
    sttModel: config.sttModel,
    ttsVoice: config.ttsVoice,
    ttsProvider: "async",
    ttsModel: config.asyncModel,
    transport: config.livekitUrl ? "livekit" : "websocket",
  };
}
