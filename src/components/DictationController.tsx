import { useCallback, useEffect, useRef } from "react";
import { getElectronDesktop } from "../lib/electron-runtime";
import { VoicePcmCapturer } from "../lib/voicePcmCapture";

type DictationTarget = { application?: string; selectedText?: string };
type DictationMode = "normal" | "replace" | "optimise";

type ActiveDictation = {
  target: DictationTarget;
  mode: DictationMode;
  sessionId: string;
  socket: WebSocket;
  capture: VoicePcmCapturer | null;
  rawTranscript: string;
  startedAt: number;
};

const CLEANUP_KEY = "clyra-dictation-cleanup";
const DICTIONARY_KEY = "clyra-dictation-dictionary";
const HISTORY_KEY = "clyra-dictation-history";

function readCleanupLevel() {
  const stored = localStorage.getItem(CLEANUP_KEY);
  return stored === "raw" || stored === "polished" ? stored : "light";
}

function readDictionary() {
  try {
    const values = JSON.parse(localStorage.getItem(DICTIONARY_KEY) || "[]");
    return Array.isArray(values) ? values.map(String).filter(Boolean).slice(0, 80) : [];
  } catch {
    return [];
  }
}

function saveHistory(entry: Record<string, unknown>) {
  try {
    const current = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    const history = Array.isArray(current) ? current : [];
    localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...history].slice(0, 80)));
  } catch {
    // Dictation must still complete when local history is unavailable.
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function userFacingDictationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Clyra's local voice service is still starting. Try again in a moment.";
  }
  return message || "Clyra dictation could not start.";
}

export function DictationController() {
  const activeRef = useRef<ActiveDictation | null>(null);
  const previewRef = useRef<{ text: string; target: DictationTarget; raw: string; startedAt: number } | null>(null);
  const lastLevelAtRef = useRef(0);

  const updateNative = useCallback((payload: Record<string, unknown>) => {
    void getElectronDesktop()?.dictation.setState(payload).catch(() => undefined);
  }, []);

  const serviceUrl = useCallback(async (pathname: string) => {
    const desktop = getElectronDesktop();
    const origin = await desktop?.dictation.serviceUrl().catch(() => "") || window.location.origin;
    return new URL(pathname, origin).toString();
  }, []);

  const postJson = useCallback(async (pathname: string, body: Record<string, unknown>) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(await serviceUrl(pathname), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `Clyra request failed (${response.status}).`);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await wait(650);
      }
    }
    throw lastError;
  }, [serviceUrl]);

  const release = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    active.capture?.stop();
    try { active.socket.close(); } catch { /* already closed */ }
    activeRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    release();
    previewRef.current = null;
    updateNative({ phase: "idle", detail: "" });
  }, [release, updateNative]);

  const insert = useCallback(async (text: string, target: DictationTarget, raw: string, startedAt: number) => {
    const desktop = getElectronDesktop();
    if (!desktop) return;
    try {
      await desktop.dictation.insert({ text, target });
      saveHistory({ original: target.selectedText || "", raw, inserted: text, application: target.application || "", at: Date.now(), durationMs: Date.now() - startedAt });
      updateNative({ phase: "done", detail: "Inserted" });
      window.setTimeout(() => updateNative({ phase: "idle", detail: "" }), 850);
    } catch (error) {
      updateNative({ phase: "error", detail: error instanceof Error ? error.message : "Clyra could not insert text." });
    }
  }, [updateNative]);

  const finishTranscript = useCallback(async (active: ActiveDictation, transcript: string) => {
    const raw = transcript.trim();
    if (!raw) {
      updateNative({ phase: "error", detail: "No speech was detected." });
      return;
    }
    if (active.mode === "optimise") {
      updateNative({ phase: "optimising", detail: "Preparing rewrite" });
      try {
        const payload = await postJson("/api/dictation/optimise", { selectedText: active.target.selectedText, instruction: raw });
        previewRef.current = { text: String(payload.text), target: active.target, raw, startedAt: active.startedAt };
        updateNative({ phase: "preview", preview: String(payload.text).slice(0, 240), detail: "Review before replacing" });
      } catch (error) {
        updateNative({ phase: "error", detail: userFacingDictationError(error) });
      }
      return;
    }
    updateNative({ phase: "processing", detail: "Cleaning up dictation" });
    try {
      const payload = await postJson("/api/dictation/cleanup", { transcript: raw, level: readCleanupLevel(), dictionary: readDictionary() });
      await insert(String(payload.text || raw), active.target, raw, active.startedAt);
    } catch (error) {
      updateNative({ phase: "error", detail: userFacingDictationError(error) });
    }
  }, [insert, postJson, updateNative]);

  const start = useCallback(async (mode: DictationMode, target: DictationTarget) => {
    release();
    previewRef.current = null;
    updateNative({ phase: mode === "optimise" ? "optimising" : "listening", detail: mode === "optimise" ? "Tell Clyra how to rewrite this" : "Listening", application: target.application || "" });
    try {
      const session = await postJson("/voice/session", { mode: "dictation", history: [] });
      const socket = new WebSocket(session.websocketUrl);
      const active: ActiveDictation = { target, mode, sessionId: session.sessionId, socket, capture: null, rawTranscript: "", startedAt: Date.now() };
      activeRef.current = active;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (activeRef.current !== active) return;
          if (message.type === "pipeline_mode" && message.mode === "pipeline" && !active.capture) {
            const capture = new VoicePcmCapturer((data, seq) => {
              if (active.socket.readyState === WebSocket.OPEN) active.socket.send(JSON.stringify({ type: "audio", sessionId: active.sessionId, codec: "pcm16", data, seq }));
            }, Number(message.sampleRate) || 16_000, (level) => {
              const now = performance.now();
              if (now - lastLevelAtRef.current < 100) return;
              lastLevelAtRef.current = now;
              updateNative({ phase: "listening", level: Math.max(0, Math.min(1, level)) });
            });
            active.capture = capture;
            void capture.start().catch((error) => {
              updateNative({ phase: "error", detail: error instanceof Error ? error.message : "Microphone permission was denied." });
              release();
            });
          } else if (message.type === "pipeline_mode" && message.mode !== "pipeline") {
            updateNative({ phase: "error", detail: "Clyra's streaming transcription service is unavailable." });
            release();
          } else if (message.type === "transcript_partial") {
            updateNative({ phase: "listening", detail: String(message.text || "Listening").slice(0, 120) });
          } else if (message.type === "dictation_final") {
            active.rawTranscript = String(message.text || "");
            active.capture?.stop();
            try { active.socket.close(); } catch { /* ignore */ }
            activeRef.current = null;
            void finishTranscript(active, active.rawTranscript);
          } else if (message.type === "error") {
            updateNative({ phase: "error", detail: String(message.message || "Clyra dictation failed.") });
            release();
          }
        } catch {
          // Ignore malformed status frames; the active session remains usable.
        }
      };
      socket.onerror = () => {
        if (activeRef.current === active) updateNative({ phase: "error", detail: "Clyra dictation connection failed." });
      };
    } catch (error) {
      updateNative({ phase: "error", detail: userFacingDictationError(error) });
    }
  }, [finishTranscript, postJson, release, updateNative]);

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    updateNative({ phase: "processing", detail: "Transcribing" });
    active.capture?.stop();
    active.capture = null;
    if (active.socket.readyState === WebSocket.OPEN) active.socket.send(JSON.stringify({ type: "flush", sessionId: active.sessionId }));
  }, [updateNative]);

  useEffect(() => {
    const desktop = getElectronDesktop();
    if (!desktop) return;
    const removeTrigger = desktop.dictation.onTrigger((event) => {
      if (event?.type === "start") void start("normal", event.target || {});
      else if (event?.type === "stop") stop();
      else if (event?.type === "cancel") cancel();
    });
    const removeAction = desktop.dictation.onAction((event) => {
      const target = event?.target || {};
      if (event?.action === "replace") void start("replace", target);
      else if (event?.action === "optimise") void start("optimise", target);
      else if (event?.action === "try-again") void start("optimise", previewRef.current?.target || target);
      else if (event?.action === "replace-preview" && previewRef.current) {
        const preview = previewRef.current;
        void insert(preview.text, preview.target, preview.raw, preview.startedAt);
      } else if (event?.action === "copy" && previewRef.current) {
        void navigator.clipboard.writeText(previewRef.current.text).then(() => updateNative({ phase: "preview", preview: previewRef.current?.text.slice(0, 240), detail: "Copied" }));
      } else if (event?.action === "stop") stop();
      else if (event?.action === "cancel") cancel();
    });
    return () => { removeTrigger(); removeAction(); release(); };
  }, [cancel, insert, release, start, stop, updateNative]);

  return null;
}
