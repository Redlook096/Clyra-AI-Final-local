import { useCallback, useEffect, useRef, useState } from "react";
import {
  PipecatClient,
  RTVIEvent,
  type BotLLMTextData,
  type BotTTSTextData,
  type TranscriptData,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

export type VoiceCallStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type VoiceTurn = { role: "user" | "assistant"; content: string };

export type UseVoiceCallOptions = {
  conversationId: string | null;
  enabled: boolean;
  chatHistory: VoiceTurn[];
  systemPrompt: string;
  temperature?: number;
  /** Test Mode: Fish STT -> Fish TTS echo, DeepSeek never called. */
  testMode: boolean;
  onTurn?: (turn: { userText: string; assistantText: string }) => void;
};

const MAX_CAPTION_LINES = 3;

export function useVoiceCall(options: UseVoiceCallOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceCallStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [botLevel, setBotLevel] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [captionLines, setCaptionLines] = useState<string[]>([]);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<PipecatClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const bargeInsRef = useRef(0);
  const reconnectsRef = useRef(0);
  const pendingUserTextRef = useRef("");
  const pendingAssistantTextRef = useRef("");
  const statusRef = useRef<VoiceCallStatus>("idle");
  const everConnectedRef = useRef(false);

  const appendCaption = useCallback((chunk: string) => {
    setCaptionLines((prev) => {
      const merged = [...prev];
      merged[merged.length - 1] = `${merged[merged.length - 1] ?? ""}${chunk}`;
      return merged.slice(-MAX_CAPTION_LINES);
    });
  }, []);

  const commitTurn = useCallback(() => {
    const userText = pendingUserTextRef.current.trim();
    const assistantText = pendingAssistantTextRef.current.trim();
    if (userText && assistantText) {
      setTurns((prev) => [...prev, { role: "user", content: userText }, { role: "assistant", content: assistantText }]);
      optionsRef.current.onTurn?.({ userText, assistantText });
    }
    pendingUserTextRef.current = "";
    pendingAssistantTextRef.current = "";
  }, []);

  const teardownClient = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }, []);

  const endCall = useCallback(async () => {
    commitTurn();
    await teardownClient();
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setActive(false);
    setStatus("idle");
    setPartialTranscript("");
    setCaptionLines([]);
    if (sessionId) {
      try {
        await fetch("/voice/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            history: turns,
            bargeIns: bargeInsRef.current,
            reconnects: reconnectsRef.current,
          }),
        });
      } catch {
        // Best-effort telemetry only.
      }
    }
  }, [commitTurn, teardownClient, turns]);

  const startCall = useCallback(async () => {
    if (!optionsRef.current.enabled || clientRef.current) return;
    setError(null);
    setStatus("connecting");
    setActive(true);
    pendingUserTextRef.current = "";
    pendingAssistantTextRef.current = "";
    setCaptionLines([]);
    setTurns([]);
    bargeInsRef.current = 0;
    reconnectsRef.current = 0;

    try {
      const sessionResponse = await fetch("/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: optionsRef.current.conversationId,
          history: optionsRef.current.chatHistory,
          systemPrompt: optionsRef.current.systemPrompt,
          temperature: optionsRef.current.temperature,
        }),
      });
      const session = await sessionResponse.json();
      if (!session?.ok) throw new Error(session?.error || "Could not start voice session.");
      sessionIdRef.current = session.sessionId;

      const client = new PipecatClient({
        transport: new SmallWebRTCTransport(),
        enableMic: true,
        enableCam: false,
        callbacks: {
          onBotReady: () => setStatus("listening"),
          onUserStartedSpeaking: () => {
            if (statusRef.current === "speaking") bargeInsRef.current += 1;
            setStatus("listening");
            setPartialTranscript("");
          },
          onUserStoppedSpeaking: () => setStatus("thinking"),
          onBotLlmStarted: () => {
            setStatus("thinking");
            pendingAssistantTextRef.current = "";
            setCaptionLines((prev) => [...prev, ""]);
          },
          onBotStartedSpeaking: () => setStatus("speaking"),
          onBotStoppedSpeaking: () => setStatus("listening"),
          onUserTranscript: (data: TranscriptData) => {
            if (data.final) {
              pendingUserTextRef.current = data.text;
              setPartialTranscript("");
            } else {
              setPartialTranscript(data.text);
            }
          },
          onBotTtsText: (data: BotTTSTextData) => {
            pendingAssistantTextRef.current += data.text;
            appendCaption(data.text);
          },
          onBotLlmText: (data: BotLLMTextData) => {
            // Test Mode / providers that don't emit botTtsText separately.
            if (!pendingAssistantTextRef.current) appendCaption(data.text);
          },
          onBotLlmStopped: () => commitTurn(),
          onError: (message) => {
            const data = message?.data as { message?: string } | undefined;
            setError(data?.message || "Voice call error.");
          },
          onDisconnected: () => {
            setStatus("idle");
          },
          onTransportStateChanged: (state) => {
            if (state === "connected" || state === "ready") everConnectedRef.current = true;
            if ((state === "connecting" || state === "authenticating") && everConnectedRef.current) {
              reconnectsRef.current += 1;
              setStatus("connecting");
            } else if (state === "connecting" || state === "authenticating") {
              setStatus("connecting");
            }
          },
        },
      });

      client.on(RTVIEvent.LocalAudioLevel, (level: number) => setMicLevel(level));
      client.on(RTVIEvent.RemoteAudioLevel, (level: number) => setBotLevel(level));

      clientRef.current = client;
      await client.connect({
        webrtcRequestParams: {
          endpoint: "/voice/offer",
          requestData: {
            sessionId: session.sessionId,
            testMode: optionsRef.current.testMode,
          },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice call failed to start.");
      setStatus("error");
      await teardownClient();
    }
  }, [appendCaption, commitTurn, teardownClient]);

  const toggleMute = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    const next = !muted;
    client.enableMic(!next);
    setMuted(next);
  }, [muted]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    return () => {
      void teardownClient();
    };
  }, [teardownClient]);

  return {
    active,
    status,
    muted,
    micLevel,
    botLevel,
    partialTranscript,
    captionLines,
    turns,
    error,
    startCall,
    endCall,
    toggleMute,
  };
}
