export type VoiceConfig = {
  enabled: boolean;
  sampleRate: number;
  pipelineUrl: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  fishApiKey: string;
  fishReferenceId: string;
  fishModel: string;
};

export function loadVoiceConfig(): VoiceConfig {
  const llmApiKey = process.env.DEEPSEEK_API_KEY || process.env.MY_LLM_API_KEY || "";
  const llmBaseUrl =
    process.env.MY_LLM_BASE_URL ||
    (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const llmModel =
    process.env.MY_LLM_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-v4-flash" : "gpt-4o-mini");

  return {
    enabled: process.env.VOICE_ENABLED !== "false",
    sampleRate: Number(process.env.VOICE_SAMPLE_RATE ?? 16000),
    pipelineUrl: process.env.VOICE_PIPELINE_URL ?? "http://127.0.0.1:8787",
    llmBaseUrl,
    llmApiKey,
    llmModel,
    fishApiKey: process.env.FISH_AUDIO_API_KEY ?? "",
    fishReferenceId: process.env.FISH_TTS_REFERENCE_ID ?? "",
    fishModel: process.env.FISH_TTS_MODEL ?? "",
  };
}

export function voiceConfigPublic(config: VoiceConfig) {
  return {
    enabled: config.enabled,
    sampleRate: config.sampleRate,
    sttProvider: "fish-audio",
    ttsProvider: "fish-audio",
    transport: "webrtc",
    fishConfigured: Boolean(config.fishApiKey),
  };
}
