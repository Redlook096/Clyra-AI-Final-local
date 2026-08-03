import {
  buildIMessageTimeline,
  getIMessageFrame,
  getIMessageFloatingPanelGeometry,
  getIMessagePanelLayout,
  IMESSAGE_CANVAS,
  IMESSAGE_TOKENS,
} from "./fakeTextTimeline";

// Canvas export is authored at 720 × 1280 but consumes the same 1080px
// logical iMessage design tokens as the DOM preview. Keeping this conversion
// in one place stops header/bubble geometry from drifting between preview and
// exported MP4 frames.
const IMESSAGE_RENDER_SCALE = 720 / IMESSAGE_CANVAS.width;
const imessageRenderToken = (value: number) => Math.round(value * IMESSAGE_RENDER_SCALE);

export const CREATOR_VOICES = [
  "Max",
  "Ryan",
  "Aiden",
  "Aaron",
  "Abigail",
  "Anaya",
  "Andy",
  "Archer",
  "Brian",
  "Chloe",
  "Dylan",
  "Emmanuel",
  "Ethan",
  "Evelyn",
  "Gavin",
  "Gordon",
  "Ivan",
  "Laura",
  "Lucy",
  "Madison",
  "Marisol",
  "Meera",
  "Walter",
] as const;

export type CreatorVoice = (typeof CREATOR_VOICES)[number];

export const CREATOR_VOICE_PREVIEW_TEXT = "Hi, let's make a fake text story";

export type CreatorSpeech = {
  blob: Blob;
  engine: string;
  voice: CreatorVoice;
  durationMs: number;
  warning?: string;
};

export type WouldRatherPhase = "prompt" | "first" | "or" | "second" | "countdown" | "reveal";
export type CreatorCue = "tick" | "ding";

export function isCreatorVoice(value: unknown): value is CreatorVoice {
  return typeof value === "string" && (CREATOR_VOICES as readonly string[]).includes(value);
}

export function resolveCreatorVoice(value: unknown, fallback: CreatorVoice = "Max"): CreatorVoice {
  return isCreatorVoice(value) ? value : fallback;
}

const voicePreviewUrlCache = new Map<CreatorVoice, string>();

export async function synthesizeCreatorSpeech(text: string, voice: CreatorVoice, signal?: AbortSignal): Promise<CreatorSpeech> {
  const response = await fetch("/api/creator/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(detail.error || `Narration failed (${response.status})`);
  }
  return {
    blob: await response.blob(),
    engine: response.headers.get("X-Clyra-TTS-Engine") || "unknown",
    voice,
    durationMs: Number(response.headers.get("X-Clyra-TTS-Duration")) || 0,
    warning: response.headers.get("X-Clyra-TTS-Warning") || undefined,
  };
}

async function playBlobUrl(
  url: string,
  durationMs: number,
  signal?: AbortSignal,
  onPlaybackProgress?: (progress: number) => void,
) {
  const audio = new Audio(url);
  let progressFrame = 0;
  const reportProgress = () => {
    const knownDurationMs = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1_000
      : durationMs;
    if (knownDurationMs > 0) {
      onPlaybackProgress?.(Math.max(0, Math.min(1, audio.currentTime * 1_000 / knownDurationMs)));
    }
    if (!audio.paused && !audio.ended) progressFrame = window.requestAnimationFrame(reportProgress);
  };
  const stop = () => {
    window.cancelAnimationFrame(progressFrame);
    audio.pause();
    audio.currentTime = 0;
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      audio.addEventListener("ended", () => {
        window.cancelAnimationFrame(progressFrame);
        onPlaybackProgress?.(1);
        signal?.removeEventListener("abort", abort);
        resolve();
      }, { once: true });
      audio.addEventListener("error", () => {
        signal?.removeEventListener("abort", abort);
        reject(new Error("The narration audio could not be played"));
      }, { once: true });
      audio.play().then(() => {
        onPlaybackProgress?.(0);
        progressFrame = window.requestAnimationFrame(reportProgress);
      }).catch(reject);
    });
  } finally {
    window.cancelAnimationFrame(progressFrame);
    signal?.removeEventListener("abort", stop);
  }
}

export async function playCreatorSpeech(
  text: string,
  voice: CreatorVoice,
  signal?: AbortSignal,
  onPlaybackProgress?: (progress: number) => void,
): Promise<CreatorSpeech> {
  const speech = await synthesizeCreatorSpeech(text, voice, signal);
  const url = URL.createObjectURL(speech.blob);
  try {
    await playBlobUrl(url, speech.durationMs, signal, onPlaybackProgress);
    return speech;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function playCreatorVoicePreview(
  voice: CreatorVoice,
  signal?: AbortSignal,
  onPlaybackProgress?: (progress: number) => void,
): Promise<CreatorSpeech> {
  let url = voicePreviewUrlCache.get(voice);
  let speech: CreatorSpeech | undefined;
  let engine = "cached";

  if (!url) {
    try {
      const staticUrl = `/media/creator-voices/${encodeURIComponent(voice)}.wav`;
      const staticResponse = await fetch(staticUrl, { signal });
      if (staticResponse.ok) {
        const blob = await staticResponse.blob();
        url = URL.createObjectURL(blob);
        voicePreviewUrlCache.set(voice, url);
        engine = "static-preview";
        speech = { blob, engine, voice, durationMs: 0 };
      }
    } catch {
      // Fall through to live TTS when static preview is missing.
    }
  }

  if (!url) {
    speech = await synthesizeCreatorSpeech(CREATOR_VOICE_PREVIEW_TEXT, voice, signal);
    url = URL.createObjectURL(speech.blob);
    voicePreviewUrlCache.set(voice, url);
    engine = speech.engine;
  }

  await playBlobUrl(url, speech?.durationMs || 0, signal, onPlaybackProgress);
  return speech || {
    blob: new Blob(),
    engine,
    voice,
    durationMs: 0,
  };
}

export async function prefetchCreatorVoicePreviews(voices: CreatorVoice[], signal?: AbortSignal) {
  await Promise.all(voices.map(async (voice) => {
    if (voicePreviewUrlCache.has(voice) || signal?.aborted) return;
    try {
      const staticUrl = `/media/creator-voices/${encodeURIComponent(voice)}.wav`;
      const staticResponse = await fetch(staticUrl, { signal });
      if (staticResponse.ok) {
        voicePreviewUrlCache.set(voice, URL.createObjectURL(await staticResponse.blob()));
        return;
      }
      const speech = await synthesizeCreatorSpeech(CREATOR_VOICE_PREVIEW_TEXT, voice, signal);
      if (!voicePreviewUrlCache.has(voice)) {
        voicePreviewUrlCache.set(voice, URL.createObjectURL(speech.blob));
      }
    } catch {
      // Prefetch is best-effort and should never block the editor.
    }
  }));
}

let cueContext: AudioContext | null = null;

function scheduleCreatorCue(
  context: AudioContext,
  destination: AudioNode,
  cue: CreatorCue,
  monitor = false,
) {
  const now = context.currentTime;
  const frequencies = cue === "ding" ? [660, 990] : [920];
  const duration = cue === "ding" ? 0.28 : 0.065;
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = cue === "ding" ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(frequency, now + index * 0.055);
    gain.gain.setValueAtTime(0.0001, now + index * 0.055);
    gain.gain.exponentialRampToValueAtTime(cue === "ding" ? 0.09 : 0.045, now + index * 0.055 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    if (monitor && destination !== context.destination) gain.connect(context.destination);
    oscillator.start(now + index * 0.055);
    oscillator.stop(now + duration + 0.02);
  });
  return Math.round(duration * 1_000);
}

export async function playCreatorCue(cue: CreatorCue, signal?: AbortSignal) {
  try {
    cueContext ??= new AudioContext();
    if (cueContext.state === "suspended") await cueContext.resume();
    const duration = scheduleCreatorCue(cueContext, cueContext.destination, cue);
    await cancellableDelay(duration, signal);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    await cancellableDelay(cue === "ding" ? 280 : 120, signal);
  }
}

export type CreatorMessage = {
  id?: string;
  text: string;
  side: "left" | "right";
  typingSeconds?: number;
  pauseSeconds?: number;
  narration?: boolean;
};
export type CreatorChoice = { question?: string; left: string; right: string; leftPercent: number; leftImage?: string; rightImage?: string; timerSeconds?: number; revealSeconds?: number; topColor?: string; bottomColor?: string };

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

async function cancellableDelay(ms: number, signal?: AbortSignal) {
  throwIfCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    }, { once: true });
  });
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line);
        line = "";
      }

      // The preview permits long URLs/identifiers to wrap anywhere. Mirror
      // that here so an export cannot overflow a bubble which fits in the
      // editor preview.
      while (context.measureText(word).width > maxWidth) {
        let splitAt = Math.max(1, Math.floor(word.length * maxWidth / context.measureText(word).width));
        while (splitAt < word.length && context.measureText(word.slice(0, splitAt + 1)).width <= maxWidth) splitAt += 1;
        while (splitAt > 1 && context.measureText(word.slice(0, splitAt)).width > maxWidth) splitAt -= 1;
        lines.push(word.slice(0, splitAt));
        word = word.slice(splitAt);
      }
      line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

async function loadImage(source?: string) {
  if (!source) return null;
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

type CreatorBackgroundMedia = HTMLImageElement | HTMLVideoElement;

async function loadVideo(source?: string) {
  if (!source) return null;
  return new Promise<HTMLVideoElement | null>((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: HTMLVideoElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), 12_000);
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.addEventListener("loadeddata", () => finish(video), { once: true });
    video.addEventListener("error", () => finish(null), { once: true });
    video.src = source;
    video.load();
  });
}

function drawCover(context: CanvasRenderingContext2D, media: CreatorBackgroundMedia, width: number, height: number) {
  const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(media, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function downloadVideo(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function transcodeCreatorVideo(webm: Blob, filename: string, signal?: AbortSignal, fps = 30) {
  const outputFps = Math.max(24, Math.min(60, Math.round(fps)));
  const response = await fetch(`/api/creator/transcode?filename=${encodeURIComponent(filename)}&fps=${outputFps}`, {
    method: "POST",
    headers: { "Content-Type": "video/webm" },
    body: webm,
    signal,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(detail.error || `MP4 export failed (${response.status})`);
  }
  const mp4 = await response.blob();
  if (mp4.size < 1_024) throw new Error("The MP4 export was empty");
  downloadVideo(mp4, `${filename}.mp4`);
  return mp4;
}

async function prepareRecorder({ width = 720, height = 1280, fps = 30 }: { width?: number; height?: number; fps?: number } = {}) {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser does not support video recording");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none;opacity:0.001;`;
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  // Keep the logical animation clock independent from the browser's manual
  // capture-frame scheduling.  A fixed capture rate gives the transcoder a
  // stable capture stream even when a heavy 1080 × 1920 draw briefly takes
  // longer than a single frame; it can duplicate the last complete canvas
  // frame rather than stretching the whole story timeline.
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("Canvas rendering is unavailable");
  const audioContext = new AudioContext();
  await audioContext.resume();
  const audioDestination = audioContext.createMediaStreamDestination();
  const outputFps = Math.max(24, Math.min(60, Math.round(fps)));
  // Manually request each canvas frame.  Browser timers can otherwise make a
  // nominal 60 FPS capture contain unevenly spaced samples when a 1080p draw
  // takes slightly longer than one refresh.  The story renderer below drives
  // this track from its own 60 Hz timeline, so the background, chat and audio
  // share one output clock.
  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0];
  const captureFrame = () => {
    const manualTrack = videoTrack as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    manualTrack?.requestFrame?.();
  };
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(MediaRecorder.isTypeSupported) || "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: outputFps >= 60 ? 12_000_000 : 5_000_000 });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.start();
  return { canvas, context, audioContext, audioDestination, recorder, chunks, mimeType, stream, captureFrame };
}

async function playIntoRecording(audioContext: AudioContext, destination: MediaStreamAudioDestinationNode, data: ArrayBuffer, signal?: AbortSignal) {
  const decoded = await audioContext.decodeAudioData(data.slice(0));
  const source = audioContext.createBufferSource();
  source.buffer = decoded;
  // Generation is an offline-ish render pass. Route narration exclusively to
  // MediaRecorder's destination so users never hear the draft being encoded.
  source.connect(destination);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      try { source.stop(); } catch { /* The source may already be stopped. */ }
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    source.addEventListener("ended", () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, { once: true });
    source.start();
  });
}

async function disposeRecording(setup: Awaited<ReturnType<typeof prepareRecorder>>) {
  if (setup.recorder.state !== "inactive") {
    try { setup.recorder.stop(); } catch { /* Recorder is already stopping. */ }
  }
  setup.stream.getTracks().forEach((track) => track.stop());
  if (setup.audioContext.state !== "closed") await setup.audioContext.close().catch(() => undefined);
  setup.canvas.remove();
}

async function finishRecording(setup: Awaited<ReturnType<typeof prepareRecorder>>) {
  await delay(320);
  const stopped = new Promise<void>((resolve) => setup.recorder.addEventListener("stop", () => resolve(), { once: true }));
  setup.recorder.requestData();
  await delay(120);
  setup.recorder.stop();
  await stopped;
  setup.stream.getTracks().forEach((track) => track.stop());
  await setup.audioContext.close();
  setup.canvas.remove();
  const blob = new Blob(setup.chunks, { type: setup.mimeType });
  if (blob.size < 1024) throw new Error("The browser returned an empty video recording");
  return blob;
}

type MessageTheme = "ios_dark" | "ios_light";
type MessageLayout = "floating_phone" | "full_chat" | "chat_gameplay";

type MessageVideoStyle = {
  panel: string;
  header: string;
  incoming: string;
  outgoing: string;
  incomingText: string;
  outgoingText: string;
  contactText: string;
  accent: string;
  avatar: string;
};

function messageVideoStyle(theme: MessageTheme): MessageVideoStyle {
  if (theme === "ios_light") {
    return {
      panel: "#ffffff",
      header: "#f4f4f6",
      incoming: "#e9e9eb",
      outgoing: "#0a84ff",
      incomingText: "#111114",
      outgoingText: "#ffffff",
      contactText: "#26262b",
      accent: "#0a84ff",
      avatar: "#aab0bb",
    };
  }
  return {
    panel: "#000000",
    header: "#1c1c1e",
    incoming: "#2c2c2e",
    outgoing: "#0a84ff",
    incomingText: "#ffffff",
    outgoingText: "#ffffff",
    contactText: "#d8d8dc",
    accent: "#0a84ff",
    avatar: "#aab0bb",
  };
}

function messageVideoGeometry(layout: MessageLayout, panelHeight: number) {
  if (layout === "full_chat") {
    return { x: 0, y: 0, width: 720, height: 1280, radius: 0, headerHeight: imessageRenderToken(IMESSAGE_TOKENS.headerHeight) };
  }
  if (layout === "chat_gameplay") {
    return { x: 0, y: 0, width: 720, height: 870, radius: 0, headerHeight: imessageRenderToken(IMESSAGE_TOKENS.headerHeight) };
  }
  // Use the exact same logical inset, width, radius, and content-fit height
  // as MessagePreview. In particular, do not reintroduce a 54%-tall export
  // sheet here: its lower divider belongs directly below the last bubble.
  const floating = getIMessageFloatingPanelGeometry(panelHeight / IMESSAGE_RENDER_SCALE);
  return {
    x: imessageRenderToken(floating.x),
    y: imessageRenderToken(floating.y),
    width: imessageRenderToken(floating.width),
    height: imessageRenderToken(floating.height),
    radius: imessageRenderToken(floating.radius),
    headerHeight: imessageRenderToken(IMESSAGE_TOKENS.headerHeight),
  };
}

function drawMessageBubblePath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, imessageRenderToken(IMESSAGE_TOKENS.bubbleRadius));
}

function drawMessageVideo(
  context: CanvasRenderingContext2D,
  background: CreatorBackgroundMedia | null,
  name: string,
  messages: CreatorMessage[],
  visible: number,
  panelHeight: number,
  theme: MessageTheme,
  layout: MessageLayout,
  windowStart = 0,
) {
  // Draw at one logical 720 × 1280 coordinate system, then scale the complete
  // surface for a 1080 × 1920 export. This keeps typography, bubbles, icons,
  // and safe areas proportional to the preview rather than independently scaled.
  const scaleX = context.canvas.width / 720;
  const scaleY = context.canvas.height / 1280;
  context.save();
  context.scale(scaleX, scaleY);
  const colors = messageVideoStyle(theme);
  const stage = context.createLinearGradient(0, 0, 720, 1280);
  stage.addColorStop(0, "#2f8d66");
  stage.addColorStop(0.55, "#2a7659");
  stage.addColorStop(1, "#205844");
  context.fillStyle = stage;
  context.fillRect(0, 0, 720, 1280);
  if (background) {
    drawCover(context, background, 720, 1280);
    context.fillStyle = "rgba(15,23,42,.06)";
    context.fillRect(0, 0, 720, 1280);
  }

  const { x, y, width, height, radius, headerHeight } = messageVideoGeometry(layout, panelHeight);
  context.save();
  roundedRect(context, x, y, width, height, radius);
  context.clip();
  context.fillStyle = colors.panel;
  context.fillRect(x, y, width, height);
  context.fillStyle = colors.header;
  context.fillRect(x, y, width, headerHeight);
  context.fillStyle = theme === "ios_dark" ? "#111111" : "rgba(15,23,42,.08)";
  context.fillRect(x, y + headerHeight - 1, width, 1);

  const blue = colors.accent;
  context.strokeStyle = blue;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 3;
  const headerMid = y + headerHeight / 2;
  const headerSide = imessageRenderToken(IMESSAGE_TOKENS.headerSideInset);
  const avatarRadius = imessageRenderToken(31);
  const badgeRadius = imessageRenderToken(20);
  context.beginPath();
  context.moveTo(x + headerSide + imessageRenderToken(8), headerMid - imessageRenderToken(17));
  context.lineTo(x + headerSide - imessageRenderToken(3), headerMid);
  context.lineTo(x + headerSide + imessageRenderToken(8), headerMid + imessageRenderToken(17));
  context.stroke();
  context.beginPath();
  context.arc(x + headerSide + imessageRenderToken(38), headerMid, badgeRadius, 0, Math.PI * 2);
  context.fillStyle = blue;
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `500 ${imessageRenderToken(20)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
  context.textAlign = "center";
  context.fillText("99", x + headerSide + imessageRenderToken(38), headerMid + imessageRenderToken(7));

  const centre = x + width / 2;
  context.beginPath();
  context.arc(centre, y + imessageRenderToken(43), avatarRadius, 0, Math.PI * 2);
  context.fillStyle = colors.avatar;
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `500 ${imessageRenderToken(27)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
  context.fillText((name || "Unknown").slice(0, 1).toUpperCase(), centre, y + imessageRenderToken(52));
  context.font = `600 ${imessageRenderToken(23)}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
  context.fillStyle = colors.contactText;
  context.fillText(`${name || "Unknown"} ›`, centre, y + imessageRenderToken(121));

  const cameraX = x + width - headerSide - imessageRenderToken(8);
  const cameraY = headerMid;
  context.strokeStyle = blue;
  context.lineWidth = imessageRenderToken(2);
  roundedRect(context, cameraX - imessageRenderToken(20), cameraY - imessageRenderToken(12), imessageRenderToken(30), imessageRenderToken(24), imessageRenderToken(5));
  context.stroke();
  context.beginPath();
  context.moveTo(cameraX + imessageRenderToken(10), cameraY - imessageRenderToken(7));
  context.lineTo(cameraX + imessageRenderToken(22), cameraY - imessageRenderToken(12));
  context.lineTo(cameraX + imessageRenderToken(22), cameraY + imessageRenderToken(12));
  context.lineTo(cameraX + imessageRenderToken(10), cameraY + imessageRenderToken(7));
  context.closePath();
  context.stroke();

  const bubbleFontSize = imessageRenderToken(IMESSAGE_TOKENS.messageFontSize);
  const bubbleLineHeight = imessageRenderToken(IMESSAGE_TOKENS.messageLineHeight);
  const bubbleHorizontalPadding = imessageRenderToken(IMESSAGE_TOKENS.bubbleHorizontalPadding);
  const bubbleVerticalPadding = imessageRenderToken(IMESSAGE_TOKENS.bubbleVerticalPadding);
  const bubbleMaxWidth = imessageRenderToken(IMESSAGE_TOKENS.bubbleMaxWidth);
  const sideInset = imessageRenderToken(IMESSAGE_TOKENS.sideInset);
  context.font = `400 ${bubbleFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textAlign = "left";
  const shown = messages.slice(windowStart, windowStart + visible).map((message, relativeIndex) => {
    const lines = wrapText(context, message.text, bubbleMaxWidth - bubbleHorizontalPadding * 2);
    const bubbleWidth = Math.min(bubbleMaxWidth, Math.max(imessageRenderToken(66), ...lines.map((line) => context.measureText(line).width + bubbleHorizontalPadding * 2)));
    const bubbleHeight = Math.max(imessageRenderToken(IMESSAGE_TOKENS.bubbleMinimumHeight), lines.length * bubbleLineHeight + bubbleVerticalPadding * 2);
    return { message, index: windowStart + relativeIndex, lines, bubbleWidth, bubbleHeight };
  });
  // Reserve the same compact top and bottom inset used by the DOM
  // preview. Without the top inset here an overflowing export can place the
  // newest bubble beneath the sheet divider even though the preview scrolls
  // it safely into view.
  const available = Math.max(
    48,
    height
      - headerHeight
      - imessageRenderToken(IMESSAGE_TOKENS.messageTopInset)
      - imessageRenderToken(IMESSAGE_TOKENS.messageBottomInset)
      // The logical canvas is rendered at two-thirds scale. Preserve the
      // content-fit layout through pixel rounding instead of evicting a whole
      // message when a 1px conversion difference appears.
      + 3,
  );
  let contentHeight = shown.reduce((sum, item, index) => {
    if (!index) return sum + item.bubbleHeight;
    const previous = shown[index - 1]!.message;
    return sum + item.bubbleHeight + (previous.side === item.message.side ? imessageRenderToken(IMESSAGE_TOKENS.sameSenderGap) : imessageRenderToken(IMESSAGE_TOKENS.senderSwitchGap));
  }, 0);
  // Mirror the DOM preview's content surface: when a long conversation
  // exceeds the measured body, retain every bubble and shift the complete
  // stack upward beneath the fixed header. Removing older messages based on
  // an arbitrary count made a rendered frame disagree with a scrubbed one.
  const scrollOffset = Math.max(0, contentHeight - available);
  let bubbleY = y + headerHeight + imessageRenderToken(IMESSAGE_TOKENS.messageTopInset) - scrollOffset;
  for (const [shownIndex, item] of shown.entries()) {
    const { message, lines, bubbleWidth, bubbleHeight } = item;
    if (shownIndex) {
      const previous = shown[shownIndex - 1]!.message;
      bubbleY += previous.side === message.side ? imessageRenderToken(IMESSAGE_TOKENS.sameSenderGap) : imessageRenderToken(IMESSAGE_TOKENS.senderSwitchGap);
    }
    const bubbleX = message.side === "right" ? x + width - bubbleWidth - sideInset : x + sideInset;
    drawMessageBubblePath(context, bubbleX, bubbleY, bubbleWidth, bubbleHeight);
    context.fillStyle = message.side === "right" ? colors.outgoing : colors.incoming;
    context.fill();
    context.fillStyle = message.side === "right" ? colors.outgoingText : colors.incomingText;
    lines.forEach((line, lineIndex) => context.fillText(line, bubbleX + bubbleHorizontalPadding, bubbleY + bubbleVerticalPadding + bubbleFontSize + lineIndex * bubbleLineHeight));
    bubbleY += bubbleHeight;
  }
  context.restore();
  context.restore();
}

export async function renderMessageStoryVideo(options: { name: string; messages: CreatorMessage[]; voices: Record<"left" | "right", CreatorVoice>; background?: string; backgroundVideo?: string; theme?: MessageTheme; layout?: MessageLayout; playbackRate?: number; onProgress?: (progress: number) => void; signal?: AbortSignal }) {
  const messages = options.messages.map((message, index) => ({ ...message, id: message.id || `message-${index}` }));
  const speeches: Array<{ data: ArrayBuffer; durationMs: number } | null> = [];
  for (let index = 0; index < messages.length; index += 1) {
    throwIfCancelled(options.signal);
    const message = messages[index]!;
    if (message.narration === false) speeches.push(null);
    else {
      const speech = await synthesizeCreatorSpeech(message.text, options.voices[message.side], options.signal);
      speeches.push({ data: await speech.blob.arrayBuffer(), durationMs: speech.durationMs });
    }
    options.onProgress?.((index + 1) / Math.max(1, messages.length) * 0.3);
  }
  // The render timeline is built only after TTS reports actual durations.
  // This prevents one speaker from starting while the other is still talking
  // when a specific voice speaks slower or faster than the text estimate.
  const timedMessages = messages.map((message, index) => ({
    ...message,
    voiceDurationMs: speeches[index]?.durationMs || undefined,
  }));
  const timeline = buildIMessageTimeline(timedMessages, options.playbackRate || 1);
  // Fake Text Story is rendered at its actual project resolution; the drawing
  // code scales one fixed logical canvas so preview and export keep their ratios.
  const setup = await prepareRecorder({ width: 1080, height: 1920, fps: 60 });
  let backgroundVideo: HTMLVideoElement | null = null;
  try {
    backgroundVideo = await loadVideo(options.backgroundVideo);
    const background: CreatorBackgroundMedia | null = backgroundVideo || await loadImage(options.background);
    if (backgroundVideo) {
      backgroundVideo.currentTime = 0;
      // Export can take longer than the story itself to draw. Do not let an
      // HTMLVideoElement advance on wall-clock time while the canvas records
      // logical 60 FPS frames, or gameplay will be sped up in the retimed MP4.
      // Each canvas frame below instead uses the same logical timestamp as the
      // story, preserving normal 1× gameplay speed in the finished video.
      backgroundVideo.pause();
    }
    const theme = options.theme || "ios_dark";
    const layout = options.layout || "floating_phone";
    const audioStart = setup.audioContext.currentTime + 0.11;
    const decoded = await Promise.all(speeches.map((audio) => audio ? setup.audioContext.decodeAudioData(audio.data.slice(0)) : null));
    decoded.forEach((buffer, index) => {
      if (!buffer) return;
      const source = setup.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(setup.audioDestination);
      source.start(audioStart + timeline.events[index]!.voiceStartMs / 1_000);
    });
    const drawFrame = (timeMs: number) => {
      if (backgroundVideo && Number.isFinite(backgroundVideo.duration) && backgroundVideo.duration > 0) {
        const duration = backgroundVideo.duration;
        const frameTime = (Math.max(0, timeMs) / 1_000) % duration;
        backgroundVideo.currentTime = Math.min(frameTime, Math.max(0, duration - 1 / 60));
      }
      const frame = getIMessageFrame(timeline, timeMs);
      const panelHeight = layout === "floating_phone"
        ? imessageRenderToken(getIMessagePanelLayout(messages.slice(0, frame.visibleCount)).panelHeight)
        : 1_280;
      drawMessageVideo(
        setup.context,
        background,
        options.name,
        messages,
        frame.visibleCount,
        panelHeight,
        theme,
        layout,
        0,
      );
    };
    const outputFps = 60;
    const frameDurationMs = 1_000 / outputFps;
    const lastFrameIndex = Math.ceil(timeline.durationMs / frameDurationMs);
    const startedAt = performance.now();
    for (let frameIndex = 0; frameIndex <= lastFrameIndex; frameIndex += 1) {
      throwIfCancelled(options.signal);
      // Do not derive story state from a late browser timer.  Every output
      // sample has an exact 60 Hz logical timestamp; a slow draw may hold the
      // last fully rendered frame, but it can never skip a chat state or make
      // the overlay animate at a different cadence to the exported video.
      const elapsed = Math.min(timeline.durationMs, frameIndex * frameDurationMs);
      drawFrame(elapsed);
      setup.captureFrame();
      options.onProgress?.(0.3 + elapsed / timeline.durationMs * 0.64);
      if (frameIndex >= lastFrameIndex) break;
      const nextFrameAt = startedAt + (frameIndex + 1) * frameDurationMs;
      await cancellableDelay(Math.max(0, nextFrameAt - performance.now()), options.signal);
    }
    // Keep one final frame in the MediaRecorder without adding a visible
    // post-roll to the story timeline.
    await cancellableDelay(frameDurationMs, options.signal);
    const blob = await finishRecording(setup);
    options.onProgress?.(0.97);
    const mp4 = await transcodeCreatorVideo(blob, "clyra-message-story", options.signal, 60);
    options.onProgress?.(1);
    return mp4;
  } catch (error) {
    await disposeRecording(setup);
    throw error;
  } finally {
    if (backgroundVideo) {
      backgroundVideo.pause();
      backgroundVideo.removeAttribute("src");
      backgroundVideo.load();
    }
  }
}

function outlinedChoiceText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
  context.textAlign = "center";
  context.font = "900 54px Arial, sans-serif";
  context.lineWidth = 12;
  context.strokeStyle = "#050505";
  context.fillStyle = "#fff";
  const lines = wrapText(context, text, maxWidth);
  lines.forEach((line, index) => {
    context.strokeText(line, x, y + index * 60);
    context.fillText(line, x, y + index * 60);
  });
}

function drawWouldRatherVideo(
  context: CanvasRenderingContext2D,
  choice: CreatorChoice,
  images: [HTMLImageElement | null, HTMLImageElement | null],
  phase: WouldRatherPhase,
  countdown: number | null = null,
  entrance = 1,
) {
  context.fillStyle = choice.topColor || "#ef0900";
  context.fillRect(0, 0, 720, 640);
  context.fillStyle = choice.bottomColor || "#1296db";
  context.fillRect(0, 640, 720, 640);
  context.fillStyle = "#050505";
  context.fillRect(0, 631, 720, 18);
  context.fillStyle = "rgba(0,0,0,.72)";
  roundedRect(context, 278, 26, 164, 42, 21);
  context.fill();
  context.fillStyle = "#ffffff";
  context.textAlign = "center";
  context.font = "800 15px Arial, sans-serif";
  context.fillText("WOULD YOU RATHER", 360, 52);
  const easedEntrance = 1 - Math.pow(1 - Math.max(0, Math.min(1, entrance)), 3);
  const showFirst = phase !== "prompt";
  const showOr = phase === "or" || phase === "second" || phase === "countdown";
  const showSecond = phase === "second" || phase === "countdown" || phase === "reveal";
  if (showFirst) {
    const firstX = phase === "first" ? 360 - (1 - easedEntrance) * 760 : 360;
    outlinedChoiceText(context, choice.left, firstX, 172, 640);
    if (images[0]) context.drawImage(images[0], 225, 300, 270, 220);
  }
  if (showSecond) {
    const secondX = phase === "second" ? 360 + (1 - easedEntrance) * 760 : 360;
    outlinedChoiceText(context, choice.right, secondX, 1010, 640);
    if (images[1]) context.drawImage(images[1], 225, 760, 270, 210);
  }
  if (showOr) {
    context.beginPath();
    context.arc(360, 640, 65, 0, Math.PI * 2);
    context.fillStyle = "#050505";
    context.fill();
    context.fillStyle = "white";
    context.textAlign = "center";
    context.font = phase === "countdown" ? "900 54px Arial, sans-serif" : "900 46px Arial, sans-serif";
    context.fillText(phase === "countdown" && countdown !== null ? String(countdown) : "OR", 360, 658);
  }
  if (phase === "reveal") {
    const leftWins = choice.leftPercent >= 50;
    context.font = "900 64px Arial, sans-serif";
    context.lineWidth = 10;
    context.strokeStyle = "#050505";
    context.fillStyle = leftWins ? "#30e96f" : "#ff3838";
    context.strokeText(`${choice.leftPercent}%`, 360, 450);
    context.fillText(`${choice.leftPercent}%`, 360, 450);
    context.fillStyle = leftWins ? "#ff3838" : "#30e96f";
    context.strokeText(`${100 - choice.leftPercent}%`, 360, 855);
    context.fillText(`${100 - choice.leftPercent}%`, 360, 855);
  }
}

export async function renderWouldRatherVideo(options: { choice?: CreatorChoice; rounds?: CreatorChoice[]; voice: CreatorVoice; onProgress?: (progress: number) => void; signal?: AbortSignal }) {
  const rounds = (options.rounds?.length ? options.rounds : options.choice ? [options.choice] : []).slice(0, 30);
  if (!rounds.length) throw new Error("At least one choice round is required");
  const prepared: Array<{ choice: CreatorChoice; audio: [ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer]; images: [HTMLImageElement | null, HTMLImageElement | null] }> = [];
  for (let index = 0; index < rounds.length; index += 1) {
    throwIfCancelled(options.signal);
    const choice = rounds[index]!;
    const speechParts: ArrayBuffer[] = [];
    for (const phrase of ["Would you rather?", choice.left, "Or", choice.right]) {
      const speech = await synthesizeCreatorSpeech(phrase, options.voice, options.signal);
      speechParts.push(await speech.blob.arrayBuffer());
    }
    prepared.push({
      choice,
      audio: speechParts as [ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer],
      images: await Promise.all([loadImage(choice.leftImage), loadImage(choice.rightImage)]) as [HTMLImageElement | null, HTMLImageElement | null],
    });
    options.onProgress?.((index + 1) / rounds.length * 0.24);
  }
  const setup = await prepareRecorder();
  try {
    for (let roundIndex = 0; roundIndex < prepared.length; roundIndex += 1) {
      throwIfCancelled(options.signal);
      const item = prepared[roundIndex]!;
      drawWouldRatherVideo(setup.context, item.choice, item.images, "prompt");
      await cancellableDelay(180, options.signal);
      await playIntoRecording(setup.audioContext, setup.audioDestination, item.audio[0], options.signal);

      const firstEntranceStarted = performance.now();
      while (performance.now() - firstEntranceStarted < 320) {
        throwIfCancelled(options.signal);
        drawWouldRatherVideo(setup.context, item.choice, item.images, "first", null, (performance.now() - firstEntranceStarted) / 320);
        await cancellableDelay(16, options.signal);
      }
      drawWouldRatherVideo(setup.context, item.choice, item.images, "first");
      await playIntoRecording(setup.audioContext, setup.audioDestination, item.audio[1], options.signal);
      await cancellableDelay(1_000, options.signal);

      drawWouldRatherVideo(setup.context, item.choice, item.images, "or");
      await playIntoRecording(setup.audioContext, setup.audioDestination, item.audio[2], options.signal);

      const secondEntranceStarted = performance.now();
      while (performance.now() - secondEntranceStarted < 320) {
        throwIfCancelled(options.signal);
        drawWouldRatherVideo(setup.context, item.choice, item.images, "second", null, (performance.now() - secondEntranceStarted) / 320);
        await cancellableDelay(16, options.signal);
      }
      drawWouldRatherVideo(setup.context, item.choice, item.images, "second");
      await playIntoRecording(setup.audioContext, setup.audioDestination, item.audio[3], options.signal);

      const timerSeconds = Math.max(3, Math.min(10, Math.round(item.choice.timerSeconds || 3)));
      for (let count = timerSeconds; count >= 1; count -= 1) {
        drawWouldRatherVideo(setup.context, item.choice, item.images, "countdown", count);
        scheduleCreatorCue(setup.audioContext, setup.audioDestination, "tick", true);
        options.onProgress?.(0.24 + ((roundIndex + (timerSeconds - count + 1) / timerSeconds) / prepared.length) * 0.64);
        await cancellableDelay(1_000, options.signal);
      }
      drawWouldRatherVideo(setup.context, item.choice, item.images, "countdown", 0);
      await cancellableDelay(220, options.signal);
      scheduleCreatorCue(setup.audioContext, setup.audioDestination, "ding", true);
      drawWouldRatherVideo(setup.context, item.choice, item.images, "reveal");
      await cancellableDelay(Math.max(800, Math.min(3_000, (item.choice.revealSeconds || 1.5) * 1_000)), options.signal);
      if (roundIndex < prepared.length - 1) {
        setup.context.fillStyle = "#050505";
        setup.context.fillRect(0, 0, 720, 1280);
        await cancellableDelay(220, options.signal);
      }
    }
    const blob = await finishRecording(setup);
    options.onProgress?.(0.97);
    const mp4 = await transcodeCreatorVideo(blob, "clyra-would-you-rather", options.signal);
    options.onProgress?.(1);
    return mp4;
  } catch (error) {
    await disposeRecording(setup);
    throw error;
  }
}

function drawStoryVideo(context: CanvasRenderingContext2D, title: string, body: string) {
  const background = context.createLinearGradient(0, 0, 720, 1280);
  background.addColorStop(0, "#111318");
  background.addColorStop(0.58, "#191b22");
  background.addColorStop(1, "#090a0d");
  context.fillStyle = background;
  context.fillRect(0, 0, 720, 1280);
  const glow = context.createRadialGradient(360, 190, 0, 360, 190, 430);
  glow.addColorStop(0, "rgba(249,115,22,.28)");
  glow.addColorStop(1, "rgba(249,115,22,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 720, 700);
  context.fillStyle = "#fb923c";
  context.fillRect(70, 236, 64, 5);
  context.font = "800 18px Arial, sans-serif";
  context.fillText("STORY", 70, 218);
  context.font = "800 54px Arial, sans-serif";
  context.fillStyle = "#ffffff";
  const titleLines = wrapText(context, title, 580).slice(0, 4);
  titleLines.forEach((line, index) => context.fillText(line, 70, 312 + index * 64));
  const bodyStart = 354 + titleLines.length * 64;
  context.font = "500 27px Arial, sans-serif";
  context.fillStyle = "rgba(255,255,255,.7)";
  const bodyLines = wrapText(context, body, 580).slice(0, 16);
  bodyLines.forEach((line, index) => context.fillText(line, 70, bodyStart + index * 42));
  context.fillStyle = "rgba(255,255,255,.16)";
  context.fillRect(70, 1160, 580, 2);
  context.fillStyle = "#ffffff";
  context.font = "700 22px Arial, sans-serif";
  context.fillText("CLYRA STORIES", 70, 1208);
}

export async function renderStoryVideo(options: { title: string; body: string; voice: CreatorVoice; onProgress?: (progress: number) => void; signal?: AbortSignal }) {
  throwIfCancelled(options.signal);
  const speech = await synthesizeCreatorSpeech(`${options.title}. ${options.body}`, options.voice, options.signal);
  const audio = await speech.blob.arrayBuffer();
  options.onProgress?.(0.3);
  const setup = await prepareRecorder();
  try {
    drawStoryVideo(setup.context, options.title, options.body);
    await cancellableDelay(260, options.signal);
    options.onProgress?.(0.42);
    await playIntoRecording(setup.audioContext, setup.audioDestination, audio, options.signal);
    options.onProgress?.(0.9);
    const blob = await finishRecording(setup);
    options.onProgress?.(0.97);
    const mp4 = await transcodeCreatorVideo(blob, "clyra-story-video", options.signal);
    options.onProgress?.(1);
    return mp4;
  } catch (error) {
    await disposeRecording(setup);
    throw error;
  }
}
