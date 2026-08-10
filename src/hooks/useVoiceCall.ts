import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  cancelSpeechSynthesis,
  ensureSpeechVoices,
  nextSemanticPhrase,
  pickEnglishVoice,
  shapeTextForSpeech,
  splitSpeakablePhrases,
  startSpeechResumeWatch,
  stripMarkdownForSpeech,
} from "../lib/voiceSpeech";
import { stopMediaStreamTracks, VoicePcmCapturer } from "../lib/voicePcmCapture";
import { decodeVoicePcmPacket, stableVoiceId } from "../lib/voicePcmPacket";
import { getElectronDesktop } from "../lib/electron-runtime";
import {
  remainingVoiceSilenceMs,
  VOICE_MIN_UTTERANCE_MS,
  VOICE_SPEECH_LEVEL,
  VOICE_TRAILING_SILENCE_MS,
} from "../lib/voiceTurnDetection";

function openMicrophoneSettingsIfNeeded(message?: string) {
  if (!/microphone|notallowed|permission|denied|not-allowed/i.test(String(message || "microphone"))) return;
  void getElectronDesktop()?.dictation.openMicrophoneSettings?.().catch(() => undefined);
}

type VoiceStatus =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended"
  | "error";

type VoiceSessionResponse = {
  ok: boolean;
  sessionId: string;
  websocketUrl: string;
  transport: "livekit" | "websocket";
  config?: { sampleRate: number };
  error?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

const ENDPOINT_SILENCE_MIN_MS = 320;
const ENDPOINT_SILENCE_MAX_MS = 720;
const ENDPOINT_SILENCE_DEFAULT_MS = 480;
const VAD_SILENCE_LEVEL = 0.045;
const VAD_SPEECH_LEVEL = 0.08;
/** Continuous user speech required before interrupting the assistant (noise immunity). */
const BARGE_HOLD_MS = 480;
const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const ALLOW_BROWSER_TTS_FALLBACK =
  VITE_ENV.VITE_ALLOW_BROWSER_TTS_FALLBACK !== "false";
const CHATTERBOX_WATCHDOG_MS = Math.max(
  5_000,
  Number(VITE_ENV.VITE_CHATTERBOX_WATCHDOG_MS || 30_000),
);

function endpointDelayMs(transcript: string, hasInterim: boolean) {
  const words = transcript.trim().split(/\s+/).filter(Boolean).length;
  const looksComplete = /[.!?…]$/.test(transcript.trim());
  if (looksComplete && !hasInterim) {
    return words <= 4 ? ENDPOINT_SILENCE_MIN_MS : 500;
  }
  if (!hasInterim && words >= 3) {
    return Math.min(ENDPOINT_SILENCE_DEFAULT_MS, 560);
  }
  if (hasInterim) {
    return Math.min(ENDPOINT_SILENCE_MAX_MS, 780 + Math.min(words, 8) * 12);
  }
  return ENDPOINT_SILENCE_DEFAULT_MS;
}

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

type VoiceChatTurn = {
  userText: string;
  assistantText: string;
};

export type VoiceTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
};

export function useVoiceCall(options: {
  conversationId?: string | null;
  enabled?: boolean;
  chatHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  temperature?: number;
  speechRate?: number;
  speechPitch?: number;
  speechVolume?: number;
  onTurn?: (turn: VoiceChatTurn) => void;
}) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("connecting");
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const micStartPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const micRequestIdRef = useRef(0);
  /** Playback-only context — never share with the mic meter graph. */
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const speechVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const stopSpeechResumeRef = useRef<(() => void) | null>(null);
  const ttsWatchdogRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mutedRef = useRef(false);
  const statusRef = useRef<VoiceStatus>("connecting");
  const activeRef = useRef(false);
  const lastUtteranceRef = useRef("");
  const playbackTimeRef = useRef(0);
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const playbackQueueEpochRef = useRef(0);
  const gotTtsChunkRef = useRef(false);
  const ttsSampleRateRef = useRef(16000);
  const ttsGenerationRef = useRef(0);
  const ttsResponseHashRef = useRef(0);
  const assistantTextRef = useRef("");
  // Keep text private until the server-owned Max stream is ready. This keeps
  // the overlay in its composing state while TTS is still being generated.
  const pendingAssistantTextRef = useRef("");
  const ttsPlaybackStartedRef = useRef(false);
  const onTurnRef = useRef(options.onTurn);
  const chatHistoryRef = useRef(options.chatHistory ?? []);
  const systemPromptRef = useRef(options.systemPrompt ?? "");
  const temperatureRef = useRef(options.temperature ?? 0.7);
  const speechRateRef = useRef(options.speechRate ?? 0.94);
  const speechPitchRef = useRef(options.speechPitch ?? 1.03);
  const speechVolumeRef = useRef(options.speechVolume ?? 0.96);
  const committedSpeechRef = useRef("");
  const interimSpeechRef = useRef("");
  const endpointTimerRef = useRef<number | null>(null);
  const pipelineSilenceTimerRef = useRef<number | null>(null);
  const pipelineHeardSpeechRef = useRef(false);
  const pipelineSpeechStartedAtRef = useRef(0);
  const pipelineLastSpeechAtRef = useRef(0);
  const resumePipelineCaptureRef = useRef<(() => void) | null>(null);
  const listenPausedRef = useRef(false);
  const playbackResumeTimerRef = useRef<number | null>(null);
  const localTtsActiveRef = useRef(false);
  const micLevelRef = useRef(0);
  const silenceFramesRef = useRef(0);
  const spokenCharsRef = useRef(0);
  const pendingSpeakTailRef = useRef(false);
  const speechUtteranceCountRef = useRef(0);
  const pipelineModeRef = useRef(false);
  const pcmCapturerRef = useRef<VoicePcmCapturer | null>(null);
  const audioSeqRef = useRef(0);
  const captureSampleRateRef = useRef(16000);
  const bargeSpeechMsRef = useRef(0);
  const bargeLastTickRef = useRef(0);
  /** True while assistant owns the floor — mic audio is held until 2s continuous barge. */
  const assistantHoldRef = useRef(false);

  onTurnRef.current = options.onTurn;
  chatHistoryRef.current = options.chatHistory ?? [];
  systemPromptRef.current = options.systemPrompt ?? "";
  temperatureRef.current = options.temperature ?? 0.7;
  speechRateRef.current = options.speechRate ?? 0.94;
  speechPitchRef.current = options.speechPitch ?? 1.03;
  speechVolumeRef.current = options.speechVolume ?? 0.96;

  mutedRef.current = muted;
  statusRef.current = status;
  activeRef.current = active;
  assistantTextRef.current = assistantText;

  // Keep calls on the same local service origin as global dictation. In the
  // Electron shell this avoids relying on whichever renderer origin happened
  // to load the UI, while browser development still uses window.location.
  const serviceUrl = useCallback(async (pathname: string) => {
    const desktop = getElectronDesktop();
    const origin = await desktop?.dictation.serviceUrl().catch(() => "") || window.location.origin;
    return new URL(pathname, origin).toString();
  }, []);

  const clearEndpointTimer = useCallback(() => {
    if (endpointTimerRef.current != null) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
  }, []);

  const clearPipelineSilenceTimer = useCallback(() => {
    if (pipelineSilenceTimerRef.current != null) {
      window.clearTimeout(pipelineSilenceTimerRef.current);
      pipelineSilenceTimerRef.current = null;
    }
  }, []);

  const beginAssistantHold = useCallback(() => {
    assistantHoldRef.current = true;
    bargeSpeechMsRef.current = 0;
    bargeLastTickRef.current = 0;
  }, []);

  const endAssistantHold = useCallback(() => {
    assistantHoldRef.current = false;
    bargeSpeechMsRef.current = 0;
    bargeLastTickRef.current = 0;
    const ws = wsRef.current;
    const sessionId = sessionIdRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
      ws.send(JSON.stringify({ type: "playback_done", sessionId }));
    }
  }, []);

  const clearPlaybackResumeTimer = useCallback(() => {
    if (playbackResumeTimerRef.current != null) {
      window.clearTimeout(playbackResumeTimerRef.current);
      playbackResumeTimerRef.current = null;
    }
  }, []);

  const stopMeter = useCallback(() => {
    if (meterRafRef.current != null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const stopRecognition = useCallback(() => {
    clearEndpointTimer();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // ignore
    }
  }, [clearEndpointTimer]);

  const clearTtsWatchdog = useCallback(() => {
    if (ttsWatchdogRef.current != null) {
      window.clearTimeout(ttsWatchdogRef.current);
      ttsWatchdogRef.current = null;
    }
  }, []);

  const stopScheduledPlayback = useCallback(() => {
    playbackQueueEpochRef.current += 1;
    playbackQueueRef.current = Promise.resolve();
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
      source.disconnect();
    }
    playbackSourcesRef.current.clear();
    playbackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
  }, []);

  const performBargeIn = useCallback(() => {
    if (!activeRef.current) return;
    clearPlaybackResumeTimer();
    clearTtsWatchdog();
    stopSpeechResumeRef.current?.();
    stopSpeechResumeRef.current = null;
    localTtsActiveRef.current = false;
    speechUtteranceCountRef.current = 0;
    pendingSpeakTailRef.current = false;
    spokenCharsRef.current = 0;
    gotTtsChunkRef.current = false;
    ttsPlaybackStartedRef.current = false;
    pendingAssistantTextRef.current = "";
    ttsGenerationRef.current += 1;
    stopScheduledPlayback();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    assistantHoldRef.current = false;
    bargeSpeechMsRef.current = 0;
    setAssistantText("");
    const ws = wsRef.current;
    const sessionId = sessionIdRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
      ws.send(JSON.stringify({ type: "barge_in", sessionId }));
    }
    setStatus("listening");
    statusRef.current = "listening";
    listenPausedRef.current = false;
  }, [clearPlaybackResumeTimer, clearTtsWatchdog, stopScheduledPlayback]);

  const releaseCapture = useCallback(() => {
    // Invalidate any in-flight permission request. A delayed browser response
    // must not revive a stopped meter after mute/end-call.
    micRequestIdRef.current += 1;
    clearPipelineSilenceTimer();
    pipelineHeardSpeechRef.current = false;
    stopMeter();
    stopRecognition();
    pcmCapturerRef.current?.stop();
    pcmCapturerRef.current = null;
    stopMediaStreamTracks(mediaStreamRef.current);
    mediaStreamRef.current = null;
    analyserRef.current = null;
    const meter = meterContextRef.current;
    meterContextRef.current = null;
    if (meter && meter.state !== "closed") void meter.close();
    micLevelRef.current = 0;
    setMicLevel(0);
  }, [clearPipelineSilenceTimer, stopMeter, stopRecognition]);

  const ensurePlaybackContext = useCallback(async () => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
    }
    const context = audioContextRef.current;
    if (context.state === "suspended") await context.resume();
    playbackTimeRef.current = Math.max(playbackTimeRef.current, context.currentTime);
    return context;
  }, []);

  const stopMic = useCallback(() => {
    releaseCapture();
    clearPlaybackResumeTimer();
    clearTtsWatchdog();
    stopSpeechResumeRef.current?.();
    stopSpeechResumeRef.current = null;
    localTtsActiveRef.current = false;
    stopScheduledPlayback();
    if (audioContextRef.current?.state !== "closed") {
      void audioContextRef.current?.close();
    }
    audioContextRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [clearPlaybackResumeTimer, clearTtsWatchdog, releaseCapture, stopScheduledPlayback]);

  const endCall = useCallback(() => {
    const sessionId = sessionIdRef.current;
    const wasActive = activeRef.current;
    activeRef.current = false;
    pipelineModeRef.current = false;
    stopMic();
    wsRef.current?.close();
    wsRef.current = null;
    sessionIdRef.current = null;
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    // Hang-up must paint immediately when a call is live. Skip flushSync on
    // idle cleanup (Strict Mode remount / unmount) — flushing during React's
    // lifecycle throws and can leave the rest of the app feeling unresponsive.
    const clearCallSurface = () => {
      setActive(false);
      setStatus("ended");
      setPartialTranscript("");
      setAssistantText("");
      setError(null);
    };
    if (wasActive) {
      flushSync(clearCallSurface);
    } else {
      clearCallSurface();
    }
    statusRef.current = "ended";
    if (sessionId) {
      void serviceUrl("/voice/end").then((url) => fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }).catch(() => undefined));
    }
  }, [serviceUrl, stopMic]);

  const playPcmBytes = useCallback(async (bytes: Uint8Array, sampleRate: number) => {
    // Dedicated playback context at the device rate — never reuse the mic capture graph.
    // Chunks keep their native sampleRate in createBuffer so the browser resamples
    // cleanly (avoids robotic pitch / pops from forcing a mismatched context rate).
    const ctx = await ensurePlaybackContext();
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!pcm.length) return;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) float32[i] = pcm[i]! / 32768;

    const rate = sampleRate > 0 ? sampleRate : 16000;
    const audioBuffer = ctx.createBuffer(1, float32.length, rate);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    playbackSourcesRef.current.add(source);
    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      source.disconnect();
    };
    // Keep one monotonic timeline. The browser handles native-rate resampling once.
    // Buffer the first packet very briefly, then schedule every following PCM
    // packet on one contiguous timeline. Fading every transport packet was
    // audible as clipped syllables and gaps even though the source audio was
    // continuous.
    const startAt = playbackTimeRef.current > ctx.currentTime + 0.01
      ? playbackTimeRef.current
      : ctx.currentTime + 0.085;
    source.start(startAt);
    playbackTimeRef.current = startAt + audioBuffer.duration;
  }, [ensurePlaybackContext]);

  const enqueuePcmBytes = useCallback((bytes: Uint8Array, sampleRate: number) => {
    const epoch = playbackQueueEpochRef.current;
    const queued = playbackQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (epoch !== playbackQueueEpochRef.current) return;
        await playPcmBytes(bytes, sampleRate);
      });
    playbackQueueRef.current = queued;
    return queued;
  }, [playPcmBytes]);

  const sendUtterance = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (clean === lastUtteranceRef.current) return;
    const ws = wsRef.current;
    const sessionId = sessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return;
    // Mute must not block a turn that was already captured.

    lastUtteranceRef.current = clean;
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    clearEndpointTimer();
    listenPausedRef.current = true;
    spokenCharsRef.current = 0;
    pendingSpeakTailRef.current = false;
    speechUtteranceCountRef.current = 0;
    localTtsActiveRef.current = false;
    beginAssistantHold();

    setTurns((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: clean,
        at: Date.now(),
      },
    ]);
    setPartialTranscript(clean);
    setAssistantText("");
    setStatus("thinking");
    gotTtsChunkRef.current = false;
    ttsPlaybackStartedRef.current = false;
    pendingAssistantTextRef.current = "";

    // Pause mic recognition while we think/speak so TTS doesn't re-trigger STT.
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }

    ws.send(
      JSON.stringify({
        type: "utterance",
        sessionId,
        text: clean,
      }),
    );
  }, [beginAssistantHold, clearEndpointTimer]);

  const scheduleEndpoint = useCallback(() => {
    clearEndpointTimer();
    const combined = `${committedSpeechRef.current} ${interimSpeechRef.current}`.trim();
    if (!combined) return;
    const delay = endpointDelayMs(
      combined,
      Boolean(interimSpeechRef.current.trim()),
    );
    endpointTimerRef.current = window.setTimeout(() => {
      endpointTimerRef.current = null;
      if (!activeRef.current) return;
      if (statusRef.current !== "listening") return;
      // Mute only blocks new capture — already-heard speech still submits.
      if (micLevelRef.current > VAD_SPEECH_LEVEL && !mutedRef.current) {
        scheduleEndpoint();
        return;
      }
      const finalText = `${committedSpeechRef.current} ${interimSpeechRef.current}`.trim();
      if (!finalText) return;
      sendUtterance(finalText);
    }, delay);
  }, [clearEndpointTimer, sendUtterance]);

  const startRecognition = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError(
        "This browser doesn't support live speech recognition. Try Chrome or Edge, or enable the voice pipeline.",
      );
      // Don't tear down an already-connected call — keep overlay on Listening.
      if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setStatus("error");
        statusRef.current = "error";
      } else {
        setStatus("listening");
        statusRef.current = "listening";
      }
      return;
    }
    stopRecognition();
    listenPausedRef.current = false;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (mutedRef.current || listenPausedRef.current) return;
      if (assistantHoldRef.current) return;
      if (statusRef.current !== "listening") return;

      let interim = "";
      let newlyFinal = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const piece = result[0]?.transcript?.trim() || "";
        if (!piece) continue;
        if (result.isFinal) newlyFinal += `${piece} `;
        else interim += `${piece} `;
      }

      if (newlyFinal.trim()) {
        committedSpeechRef.current = `${committedSpeechRef.current} ${newlyFinal}`
          .replace(/\s+/g, " ")
          .trim();
      }
      interimSpeechRef.current = interim.trim();

      const display = `${committedSpeechRef.current} ${interimSpeechRef.current}`
        .replace(/\s+/g, " ")
        .trim();
      if (display) setPartialTranscript(display);

      // Wait for a pause before thinking — don't fire on every mid-sentence final.
      if (display) scheduleEndpoint();
    };
    recognition.onerror = (event) => {
      if (!activeRef.current) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (event.error === "not-allowed") {
        setError("Microphone permission denied. Opening System Settings…");
        openMicrophoneSettingsIfNeeded("microphone permission denied");
        // Keep overlay alive if the voice socket is already up.
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          setStatus("listening");
          statusRef.current = "listening";
        } else {
          setStatus("error");
          statusRef.current = "error";
        }
      }
    };
    recognition.onend = () => {
      if (!activeRef.current || mutedRef.current) return;
      if (statusRef.current === "error" || statusRef.current === "ended") return;
      // While thinking/speaking we intentionally stopped recognition.
      if (listenPausedRef.current) return;
      try {
        recognition.start();
      } catch {
        // ignore restart races
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore if already started
    }
  }, [scheduleEndpoint, stopRecognition]);

  const resumeListening = useCallback(() => {
    lastUtteranceRef.current = "";
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    clearEndpointTimer();
    clearPlaybackResumeTimer();
    localTtsActiveRef.current = false;
    listenPausedRef.current = false;
    setPartialTranscript("");
    if (!activeRef.current) return;
    // Stay muted: mark listening, but don't reopen the mic until unmuted.
    if (mutedRef.current) return;
    if (pipelineModeRef.current) {
      resumePipelineCaptureRef.current?.();
      return;
    }
    if (!recognitionRef.current) {
      startRecognition();
      return;
    }
    try {
      recognitionRef.current.start();
    } catch {
      startRecognition();
    }
  }, [clearEndpointTimer, clearPlaybackResumeTimer, startRecognition]);

  const finishSpeakingAndListen = useCallback(() => {
    if (!activeRef.current) return;
    endAssistantHold();
    setStatus("listening");
    resumeListening();
  }, [endAssistantHold, resumeListening]);

  const onSpeechUtteranceFinished = useCallback(() => {
    speechUtteranceCountRef.current = Math.max(0, speechUtteranceCountRef.current - 1);
    if (speechUtteranceCountRef.current > 0) return;
    if (pendingSpeakTailRef.current) return;
    if (!activeRef.current) return;
    localTtsActiveRef.current = false;
    stopSpeechResumeRef.current?.();
    stopSpeechResumeRef.current = null;
    clearTtsWatchdog();
    finishSpeakingAndListen();
  }, [clearTtsWatchdog, finishSpeakingAndListen]);

  const applyMicLevel = useCallback((raw: number) => {
    const level = mutedRef.current ? 0 : Math.max(0, Math.min(1, raw));
    micLevelRef.current = level;
    // Near-instant meter feed; visual layer does soft settle.
    setMicLevel((prev) => prev * 0.18 + level * 0.82);

    // Barge-in gate: require 2s of continuous speech before interrupting the AI.
    if (assistantHoldRef.current && !mutedRef.current) {
      const now = performance.now();
      const last = bargeLastTickRef.current || now;
      const dt = Math.min(80, Math.max(0, now - last));
      bargeLastTickRef.current = now;
      if (level > VAD_SPEECH_LEVEL) {
        bargeSpeechMsRef.current += dt;
        if (bargeSpeechMsRef.current >= BARGE_HOLD_MS) {
          performBargeIn();
        }
      } else if (level < VAD_SILENCE_LEVEL) {
        bargeSpeechMsRef.current = 0;
      }
      return;
    }

    if (
      statusRef.current === "listening" &&
      !listenPausedRef.current &&
      !mutedRef.current
    ) {
      // Voice Call must finalize turns exactly like the global Cmd+Shift+K
      // dictation path. Pipeline STT has no browser transcript to key off, so
      // use the proven level gate, minimum utterance, and trailing pause.
      if (pipelineModeRef.current) {
        const now = performance.now();
        if (level >= VOICE_SPEECH_LEVEL) {
          if (!pipelineHeardSpeechRef.current) pipelineSpeechStartedAtRef.current = now;
          pipelineHeardSpeechRef.current = true;
          pipelineLastSpeechAtRef.current = now;
          clearPipelineSilenceTimer();
          return;
        }
        if (!pipelineHeardSpeechRef.current || pipelineSilenceTimerRef.current != null) return;
        if (now - pipelineSpeechStartedAtRef.current < VOICE_MIN_UTTERANCE_MS) return;
        const remaining = remainingVoiceSilenceMs(pipelineLastSpeechAtRef.current, now);
        pipelineSilenceTimerRef.current = window.setTimeout(() => {
          pipelineSilenceTimerRef.current = null;
          if (!activeRef.current || mutedRef.current || !pipelineHeardSpeechRef.current) return;
          if (performance.now() - pipelineLastSpeechAtRef.current < VOICE_TRAILING_SILENCE_MS) return;
          pipelineHeardSpeechRef.current = false;
          listenPausedRef.current = true;
          setPartialTranscript("Transcribing…");
          setStatus("thinking");
          pcmCapturerRef.current?.stop();
          pcmCapturerRef.current = null;
          const socket = wsRef.current;
          const sessionId = sessionIdRef.current;
          if (socket?.readyState === WebSocket.OPEN && sessionId) {
            socket.send(JSON.stringify({ type: "flush", sessionId }));
          }
        }, remaining);
        return;
      }
      const hasSpeech = `${committedSpeechRef.current} ${interimSpeechRef.current}`.trim();
      if (hasSpeech) {
        if (level < VAD_SILENCE_LEVEL) {
          silenceFramesRef.current += 1;
          if (silenceFramesRef.current >= 12 && endpointTimerRef.current == null) {
            scheduleEndpoint();
          } else if (
            silenceFramesRef.current >= 18 &&
            !interimSpeechRef.current.trim() &&
            committedSpeechRef.current.trim()
          ) {
            clearEndpointTimer();
            sendUtterance(committedSpeechRef.current.trim());
            silenceFramesRef.current = 0;
          }
        } else if (level > VAD_SPEECH_LEVEL) {
          silenceFramesRef.current = 0;
        }
      } else {
        silenceFramesRef.current = 0;
      }
    }
  }, [clearEndpointTimer, clearPipelineSilenceTimer, performBargeIn, scheduleEndpoint, sendUtterance]);

  const enqueueSpeech = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
      const spoken = shapeTextForSpeech(text) || stripMarkdownForSpeech(text) || text.trim();
      if (!spoken) return false;
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.rate = speechRateRef.current;
      utterance.pitch = speechPitchRef.current;
      utterance.volume = speechVolumeRef.current;
      if (speechVoiceRef.current) utterance.voice = speechVoiceRef.current;
      localTtsActiveRef.current = true;
      speechUtteranceCountRef.current += 1;
      beginAssistantHold();
      setStatus("speaking");
      if (!stopSpeechResumeRef.current) {
        stopSpeechResumeRef.current = startSpeechResumeWatch();
      }
      utterance.onend = () => onSpeechUtteranceFinished();
      utterance.onerror = () => onSpeechUtteranceFinished();
      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utterance);
      } catch {
        onSpeechUtteranceFinished();
        return false;
      }
      return true;
    },
    [beginAssistantHold, onSpeechUtteranceFinished],
  );

  const speakProgressive = useCallback(
    (fullText: string, finalize: boolean) => {
      let guard = 0;
      while (guard < 8) {
        guard += 1;
        const chunk = nextSemanticPhrase(fullText, spokenCharsRef.current);
        if (!chunk) break;
        if (!enqueueSpeech(chunk.text)) break;
        spokenCharsRef.current = chunk.nextIndex;
      }
      if (finalize) {
        const tail = fullText.slice(spokenCharsRef.current).trim();
        pendingSpeakTailRef.current = false;
        if (tail) {
          const phrases = splitSpeakablePhrases(tail);
          if (phrases.length) {
            for (const phrase of phrases) enqueueSpeech(phrase);
          } else {
            enqueueSpeech(tail);
          }
          spokenCharsRef.current = fullText.length;
        }
        if (speechUtteranceCountRef.current === 0) {
          finishSpeakingAndListen();
        }
      } else {
        pendingSpeakTailRef.current = true;
      }
    },
    [enqueueSpeech, finishSpeakingAndListen],
  );

  const speakFallback = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) {
        finishSpeakingAndListen();
        return;
      }
      spokenCharsRef.current = 0;
      pendingSpeakTailRef.current = false;
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        finishSpeakingAndListen();
        return;
      }
      void (async () => {
        await cancelSpeechSynthesis();
        speechUtteranceCountRef.current = 0;
        localTtsActiveRef.current = false;
        const voices = await ensureSpeechVoices();
        speechVoiceRef.current = pickEnglishVoice(voices);
        speakProgressive(clean, true);
      })();
    },
    [finishSpeakingAndListen, speakProgressive],
  );

  const armTtsWatchdog = useCallback(
    (expectedText: string) => {
      clearTtsWatchdog();
      ttsWatchdogRef.current = window.setTimeout(() => {
        ttsWatchdogRef.current = null;
        if (!activeRef.current) return;
        if (gotTtsChunkRef.current) return;
        const stillSilent =
          !window.speechSynthesis?.speaking &&
          !window.speechSynthesis?.pending &&
          speechUtteranceCountRef.current === 0;
        if (stillSilent && ALLOW_BROWSER_TTS_FALLBACK && (expectedText || assistantTextRef.current)) {
          speakFallback(expectedText || assistantTextRef.current);
        } else if (ALLOW_BROWSER_TTS_FALLBACK && window.speechSynthesis) {
          window.speechSynthesis.resume();
        } else if (stillSilent) {
          setError("Async Voice did not return audio in time. The call stayed on Max instead of changing voices.");
          finishSpeakingAndListen();
        }
      }, CHATTERBOX_WATCHDOG_MS);
    },
    [clearTtsWatchdog, finishSpeakingAndListen, speakFallback],
  );

  const scheduleResumeAfterPlayback = useCallback(() => {
    clearPlaybackResumeTimer();
    const ctx = audioContextRef.current;
    const remainingMs = ctx
      ? Math.max(0, (playbackTimeRef.current - ctx.currentTime) * 1000) + 120
      : 120;
    playbackResumeTimerRef.current = window.setTimeout(() => {
      playbackResumeTimerRef.current = null;
      if (!activeRef.current) return;
      finishSpeakingAndListen();
    }, remainingMs);
  }, [clearPlaybackResumeTimer, finishSpeakingAndListen]);

  const startMicMeter = useCallback(async () => {
    const existing = mediaStreamRef.current;
    if (existing?.active && existing.getAudioTracks().some((track) => track.readyState === "live")) {
      return existing;
    }
    // The WebSocket can announce pipeline mode while its onopen handler is
    // already requesting the microphone. Reuse that request instead of
    // releasing/recreating the meter graph in the middle of permission setup.
    if (micStartPromiseRef.current) return micStartPromiseRef.current;
    releaseCapture();
    const requestId = micRequestIdRef.current;
    const capture = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      if (requestId !== micRequestIdRef.current || !activeRef.current) {
        stopMediaStreamTracks(stream);
        throw new Error("Microphone request was cancelled.");
      }
      mediaStreamRef.current = stream;
      // Dedicated meter graph — never reused for TTS playback.
      const ctx = new AudioContext();
      meterContextRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current || !activeRef.current) return;
        // Preserve a direct analyser feed after PCM capture starts. It keeps
        // the meter responsive even when ScriptProcessor is briefly throttled.
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i]! - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        applyMicLevel(Math.min(1, Math.pow(rms * 6.5, 0.9)));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      meterRafRef.current = requestAnimationFrame(tick);
      return stream;
    })();
    micStartPromiseRef.current = capture;
    try {
      return await capture;
    } finally {
      if (micStartPromiseRef.current === capture) micStartPromiseRef.current = null;
    }
  }, [applyMicLevel, releaseCapture]);

  const startPipelineCapture = useCallback(async (sampleRate = captureSampleRateRef.current) => {
    const stream = await startMicMeter();
    clearPipelineSilenceTimer();
    pipelineHeardSpeechRef.current = false;
    pipelineSpeechStartedAtRef.current = 0;
    pipelineLastSpeechAtRef.current = 0;
    pcmCapturerRef.current?.stop();
    const capturer = new VoicePcmCapturer(
      (base64, seq) => {
        if (!activeRef.current || mutedRef.current || assistantHoldRef.current) return;
        const socket = wsRef.current;
        const sessionId = sessionIdRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return;
        audioSeqRef.current = seq;
        socket.send(JSON.stringify({ type: "audio", sessionId, codec: "pcm16", data: base64, seq }));
      },
      sampleRate,
      (level) => {
        if (activeRef.current) applyMicLevel(level);
      },
    );
    await capturer.start(stream, meterContextRef.current);
    pcmCapturerRef.current = capturer;
    capturer.setMuted(false);
  }, [applyMicLevel, clearPipelineSilenceTimer, startMicMeter]);

  resumePipelineCaptureRef.current = () => {
    if (!activeRef.current || mutedRef.current || !pipelineModeRef.current || pcmCapturerRef.current) return;
    void startPipelineCapture().catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Microphone permission denied";
      setError(message);
      openMicrophoneSettingsIfNeeded(message);
    });
  };

  const startCall = useCallback(async () => {
    if (!options.enabled) return;
    // Allow retry when a previous start left the overlay in error state.
    if (activeRef.current && statusRef.current !== "error") return;
    if (statusRef.current === "error") {
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      sessionIdRef.current = null;
      stopMic();
    }
    // Synchronously guard against double-start (pointerdown + click).
    activeRef.current = true;
    pipelineModeRef.current = false;
    audioSeqRef.current = 0;
    // Commit the call surface before Chromium opens a native microphone
    // permission request. Without this flush, macOS can hold the click task
    // while React still has the overlay batched, making the controls appear
    // dead even though a session is being created.
    flushSync(() => {
      setError(null);
      setActive(true);
      setMuted(false);
      setStatus("connecting");
      setAssistantText("");
      setPartialTranscript("");
      setMicLevel(0);
    });
    mutedRef.current = false;
    statusRef.current = "connecting";
    pendingAssistantTextRef.current = "";
    ttsPlaybackStartedRef.current = false;
    // Ask through the desktop main process before Chromium opens getUserMedia.
    // This makes the first-click path deterministic on macOS, where a hidden
    // WebContentsView otherwise occasionally drops the TCC prompt.
    const desktopPermission = await getElectronDesktop()?.dictation.ensurePermissions?.().catch(() => null);
    if (desktopPermission && desktopPermission.ok === false) {
      const message = String(desktopPermission.error || "Microphone permission is blocked.");
      setError(message);
      setStatus("error");
      statusRef.current = "error";
      // Keep overlay open so the user sees the error + can retry / end.
      openMicrophoneSettingsIfNeeded(message);
      return;
    }
    // This runs synchronously from the user's Start Call gesture. Keeping the
    // context active here avoids browser autoplay policies suspending valid
    // Async/Max PCM that arrives later over WebSocket.
    void ensurePlaybackContext().catch((cause) => {
      setError(
        cause instanceof Error
          ? `Voice playback: ${cause.message}`
          : "Voice playback could not start.",
      );
    });
    // Keep the microphone setup within the Start Call user gesture. Delaying
    // it until WebSocket.onopen can leave capture suspended in Chromium.
    void startMicMeter().catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Microphone permission denied";
      setError(message);
      openMicrophoneSettingsIfNeeded(message);
    });
    // Carry chat context into the call UI + server history.
    const seeded = (chatHistoryRef.current ?? []).map((msg, index, arr) => ({
      id: `seed-${index}-${msg.role}`,
      role: msg.role,
      content: msg.content,
      at: Date.now() - (arr.length - index) * 1000,
    }));
    setTurns(seeded);
    lastUtteranceRef.current = "";
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    listenPausedRef.current = false;
    // Warm voices so the first reply isn't silent on Chrome.
    void ensureSpeechVoices().then((voices) => {
      speechVoiceRef.current = pickEnglishVoice(voices);
    });

    try {
      const response = await fetch(await serviceUrl("/voice/session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: options.conversationId ?? null,
          history: chatHistoryRef.current,
          systemPrompt: systemPromptRef.current,
          temperature: temperatureRef.current,
        }),
      });
      const payload = (await response.json()) as VoiceSessionResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not start voice session");
      }
      sessionIdRef.current = payload.sessionId;
      const ws = new WebSocket(payload.websocketUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      const sampleRate = payload.config?.sampleRate ?? 16000;
      captureSampleRateRef.current = sampleRate;

      ws.onopen = async () => {
        setStatus("listening");
        statusRef.current = "listening";
        try {
          await startMicMeter();
          // Wait for the gateway's explicit `pipeline_mode` message before
          // selecting an STT implementation. Starting Web Speech after an
          // arbitrary timeout races the local PCM pipeline while it warms up;
          // in browsers where Web Speech is unavailable that race surfaces a
          // misleading "Microphone permission denied" message even though
          // getUserMedia and the meter are working normally.
        } catch (micError) {
          // Keep the call alive (Listening) so session/WS still work; show mic error.
          setError(
            micError instanceof Error
              ? micError.message
              : "Microphone permission denied",
          );
          setStatus("listening");
          statusRef.current = "listening";
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const packet = decodeVoicePcmPacket(event.data);
          if (!packet || packet.generation !== ttsGenerationRef.current) return;
          if (packet.responseHash !== ttsResponseHashRef.current) return;
          const firstChunk = !gotTtsChunkRef.current;
          gotTtsChunkRef.current = true;
          if (firstChunk) {
            ttsPlaybackStartedRef.current = true;
            setAssistantText(pendingAssistantTextRef.current);
          }
          beginAssistantHold();
          clearTtsWatchdog();
          if (firstChunk && typeof window !== "undefined" && "speechSynthesis" in window) {
            window.speechSynthesis.cancel();
          }
          void enqueuePcmBytes(packet.pcm, packet.sampleRate).catch((cause) => {
            setError(
              cause instanceof Error
                ? `Voice playback: ${cause.message}`
                : "Voice playback could not start.",
            );
          });
          setStatus("speaking");
          return;
        }
        try {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            status?: VoiceStatus;
            text?: string;
            token?: string;
            data?: string;
            message?: string;
            mode?: "pipeline" | "browser";
            sampleRate?: number;
            generation?: number;
            responseId?: string;
          };

          if (message.type === "pipeline_mode") {
            pipelineModeRef.current = message.mode === "pipeline";
            if (message.mode === "pipeline") {
              stopRecognition();
              void startPipelineCapture(message.sampleRate ?? sampleRate).catch((err) => {
                try {
                  pipelineModeRef.current = false;
                  setError(
                    err instanceof Error
                      ? err.message
                      : "Microphone permission denied",
                  );
                  setStatus("listening");
                  statusRef.current = "listening";
                  // Only fall back to browser STT when the constructor exists.
                  if (getSpeechRecognitionCtor()) {
                    startRecognition();
                  }
                } catch {
                  // Error UI above is best-effort during teardown races.
                }
              });
            } else {
              startRecognition();
            }
            return;
          }
          if (message.type === "status" && message.status) {
            // Server often flips to "listening" before local TTS finishes.
            // Only resume mic after speech actually ends.
            if (message.status === "listening") {
              if (assistantHoldRef.current) return;
              if (localTtsActiveRef.current || speechUtteranceCountRef.current > 0) {
                return;
              }
              if (gotTtsChunkRef.current && audioContextRef.current) {
                const remaining =
                  playbackTimeRef.current - audioContextRef.current.currentTime;
                if (remaining > 0.05) {
                  scheduleResumeAfterPlayback();
                  return;
                }
              }
              finishSpeakingAndListen();
              return;
            }
            if (message.status === "thinking" || message.status === "speaking") {
              beginAssistantHold();
            }
            setStatus(message.status);
          }
          if (message.type === "transcript_partial" && message.text) {
            setPartialTranscript(message.text);
          }
          if (message.type === "transcript_final" && message.text) {
            // Pipeline STT submits directly from the server rather than through
            // sendUtterance, so reset the pending visual/TTS state here too.
            gotTtsChunkRef.current = false;
            ttsPlaybackStartedRef.current = false;
            pendingAssistantTextRef.current = "";
            setAssistantText("");
            setStatus("thinking");
            setPartialTranscript(message.text);
            // Pipeline path may finalize without going through sendUtterance.
            setTurns((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "user" && last.content === message.text) return prev;
              if (lastUtteranceRef.current === message.text && last?.role === "user") {
                return prev;
              }
              lastUtteranceRef.current = message.text!;
              return [
                ...prev,
                {
                  id: `u-${Date.now()}`,
                  role: "user" as const,
                  content: message.text!,
                  at: Date.now(),
                },
              ];
            });
            beginAssistantHold();
          }
          if (message.type === "llm_token" && message.token) {
            beginAssistantHold();
            const next = `${pendingAssistantTextRef.current}${message.token}`;
            pendingAssistantTextRef.current = next;
            if (ttsPlaybackStartedRef.current) setAssistantText(next);
            // Browser speech is an explicitly enabled emergency mode only.
            // Normal calls wait for the server-owned Async PCM stream.
            if (!pipelineModeRef.current && ALLOW_BROWSER_TTS_FALLBACK && !gotTtsChunkRef.current) {
              speakProgressive(next, false);
            }
            if (statusRef.current === "thinking" || statusRef.current === "listening") {
              if (!localTtsActiveRef.current) setStatus("thinking");
            }
          }
          if (message.type === "llm_done" && message.text) {
            pendingAssistantTextRef.current = message.text;
            if (ttsPlaybackStartedRef.current) setAssistantText(message.text);
            setTurns((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.content === message.text) return prev;
              return [
                ...prev,
                {
                  id: `a-${Date.now()}`,
                  role: "assistant" as const,
                  content: message.text!,
                  at: Date.now(),
                },
              ];
            });
            const userText = lastUtteranceRef.current;
            if (userText.trim() && message.text.trim()) {
              onTurnRef.current?.({
                userText: userText.trim(),
                assistantText: message.text.trim(),
              });
            }
            if (!gotTtsChunkRef.current && !pipelineModeRef.current && ALLOW_BROWSER_TTS_FALLBACK) {
              speakProgressive(message.text, true);
              armTtsWatchdog(message.text);
            } else if (!gotTtsChunkRef.current && pipelineModeRef.current) {
              armTtsWatchdog(message.text);
            } else {
              setStatus("speaking");
            }
          }
          if (message.type === "tts_format" && message.sampleRate) {
            ttsSampleRateRef.current = message.sampleRate;
            ttsGenerationRef.current = message.generation ?? ttsGenerationRef.current;
            ttsResponseHashRef.current = stableVoiceId(message.responseId ?? "");
          }
          if (message.type === "tts_chunk" && message.data) {
            const firstChunk = !gotTtsChunkRef.current;
            gotTtsChunkRef.current = true;
            if (firstChunk) {
              ttsPlaybackStartedRef.current = true;
              setAssistantText(pendingAssistantTextRef.current);
            }
            beginAssistantHold();
            clearTtsWatchdog();
            stopSpeechResumeRef.current?.();
            stopSpeechResumeRef.current = null;
            if (typeof window !== "undefined" && "speechSynthesis" in window) {
              window.speechSynthesis.cancel();
            }
            speechUtteranceCountRef.current = 0;
            localTtsActiveRef.current = false;
            const rate =
              message.sampleRate ?? ttsSampleRateRef.current ?? sampleRate;
            void enqueuePcmBytes(new Uint8Array(base64ToArrayBuffer(message.data)), rate).catch((cause) => {
              setError(
                cause instanceof Error
                  ? `Voice playback: ${cause.message}`
                  : "Voice playback could not start.",
              );
            });
            setStatus("speaking");
          }
          if (message.type === "tts_browser" && message.text) {
            beginAssistantHold();
            setAssistantText(message.text);
            pendingAssistantTextRef.current = message.text;
            if (ALLOW_BROWSER_TTS_FALLBACK) {
              speakProgressive(message.text, true);
              armTtsWatchdog(message.text);
            }
            setStatus("speaking");
          }
          if (message.type === "tts_done") {
            if (gotTtsChunkRef.current) {
              clearTtsWatchdog();
              scheduleResumeAfterPlayback();
              return;
            }
            // Already speaking via browser TTS — don't cancel/restart (that caused silence).
            if (localTtsActiveRef.current || speechUtteranceCountRef.current > 0) {
              clearTtsWatchdog();
              return;
            }
            if (pendingAssistantTextRef.current && ALLOW_BROWSER_TTS_FALLBACK) {
              setAssistantText(pendingAssistantTextRef.current);
              speakFallback(pendingAssistantTextRef.current);
              armTtsWatchdog(pendingAssistantTextRef.current);
            } else if (pendingAssistantTextRef.current) {
              setAssistantText(pendingAssistantTextRef.current);
              clearTtsWatchdog();
              finishSpeakingAndListen();
            } else {
              finishSpeakingAndListen();
            }
          }
          if (message.type === "barge_in") {
            clearPlaybackResumeTimer();
            clearTtsWatchdog();
            stopSpeechResumeRef.current?.();
            stopSpeechResumeRef.current = null;
            localTtsActiveRef.current = false;
            speechUtteranceCountRef.current = 0;
            assistantHoldRef.current = false;
            bargeSpeechMsRef.current = 0;
            playbackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
            stopScheduledPlayback();
            if (typeof window !== "undefined" && "speechSynthesis" in window) {
              window.speechSynthesis.cancel();
            }
            setAssistantText("");
            finishSpeakingAndListen();
          }
          if (message.type === "error") {
            const err = String(message.message || "Voice stream error");
            if (!/not configured/i.test(err)) {
              setError(err);
              setStatus("error");
            }
            listenPausedRef.current = false;
            localTtsActiveRef.current = false;
          }
        } catch {
          // ignore malformed events
        }
      };

      ws.onclose = () => {
        if (activeRef.current) {
          setStatus("ended");
          statusRef.current = "ended";
          activeRef.current = false;
          setActive(false);
          stopMic();
        }
      };
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Voice call failed");
      setStatus("error");
      statusRef.current = "error";
      // Keep the call overlay visible with the error — closing it looked like
      // "nothing happened" when Start Call failed.
      stopMic();
    }
  }, [
    applyMicLevel,
    armTtsWatchdog,
    beginAssistantHold,
    clearPlaybackResumeTimer,
    clearTtsWatchdog,
    finishSpeakingAndListen,
    options.conversationId,
    options.enabled,
    ensurePlaybackContext,
    enqueuePcmBytes,
    scheduleResumeAfterPlayback,
    speakFallback,
    speakProgressive,
    serviceUrl,
    startMicMeter,
    startPipelineCapture,
    startRecognition,
    stopMic,
    stopScheduledPlayback,
  ]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (wsRef.current?.readyState === WebSocket.OPEN && sessionIdRef.current) {
      wsRef.current.send(JSON.stringify({ type: "mute", sessionId: sessionIdRef.current, muted: next }));
    }
    if (next) {
      // Releasing every track is what turns off the browser's microphone indicator.
      releaseCapture();
      return;
    }
    if (!activeRef.current) return;
    void (async () => {
      try {
        await startMicMeter();
        if (pipelineModeRef.current) await startPipelineCapture();
        else if (statusRef.current === "listening" && !listenPausedRef.current) startRecognition();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Microphone permission denied";
        setError(message);
        openMicrophoneSettingsIfNeeded(message);
        mutedRef.current = true;
        setMuted(true);
        releaseCapture();
      }
    })();
  }, [releaseCapture, startMicMeter, startPipelineCapture, startRecognition]);

  const sendTextMessage = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || !activeRef.current) return false;
      sendUtterance(clean);
      return true;
    },
    [sendUtterance],
  );

  const updateUserMessage = useCallback((id: string, content: string) => {
    const clean = content.trim();
    if (!clean) return;
    setTurns((prev) =>
      prev.map((turn) => (turn.id === id && turn.role === "user" ? { ...turn, content: clean } : turn)),
    );
  }, []);

  const resendUserMessage = useCallback(
    (id: string, contentOverride?: string) => {
      const turn = turns.find((t) => t.id === id && t.role === "user");
      const text = (contentOverride ?? turn?.content ?? "").trim();
      if (!text) return false;
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) return prev;
        return prev.slice(0, idx);
      });
      // Allow resending the same text after an edit.
      lastUtteranceRef.current = "";
      sendUtterance(text);
      return true;
    },
    [sendUtterance, turns],
  );

  // When browser TTS finishes and status returns to listening, resume STT.
  useEffect(() => {
    if (status === "listening" && active && !muted) {
      if (listenPausedRef.current) {
        resumeListening();
      }
    }
  }, [status, active, muted, resumeListening]);

  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

  useEffect(() => {
    return () => {
      void endCallRef.current();
    };
  }, []);

  return {
    active,
    status,
    muted,
    micLevel,
    partialTranscript,
    assistantText,
    error,
    turns,
    startCall,
    endCall,
    toggleMute,
    sendTextMessage,
    resendUserMessage,
    updateUserMessage,
  };
}

export type { VoiceStatus };
