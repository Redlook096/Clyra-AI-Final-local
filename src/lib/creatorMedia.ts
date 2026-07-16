export const CREATOR_VOICES = [
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

export function resolveCreatorVoice(value: unknown, fallback: CreatorVoice = "Ryan"): CreatorVoice {
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
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
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

export async function transcodeCreatorVideo(webm: Blob, filename: string, signal?: AbortSignal) {
  const response = await fetch(`/api/creator/transcode?filename=${encodeURIComponent(filename)}`, {
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

async function prepareRecorder() {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser does not support video recording");
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 1280;
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:720px;height:1280px;pointer-events:none;opacity:0.001;";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable");
  const audioContext = new AudioContext();
  await audioContext.resume();
  const audioDestination = audioContext.createMediaStreamDestination();
  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const frameTimer = window.setInterval(() => videoTrack.requestFrame?.(), 1000 / 30);
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(MediaRecorder.isTypeSupported) || "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.start();
  return { canvas, context, audioContext, audioDestination, recorder, chunks, mimeType, stream, frameTimer, videoTrack };
}

async function playIntoRecording(audioContext: AudioContext, destination: MediaStreamAudioDestinationNode, data: ArrayBuffer, signal?: AbortSignal) {
  const decoded = await audioContext.decodeAudioData(data.slice(0));
  const source = audioContext.createBufferSource();
  source.buffer = decoded;
  source.connect(destination);
  source.connect(audioContext.destination);
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
  window.clearInterval(setup.frameTimer);
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
  window.clearInterval(setup.frameTimer);
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
    header: "#1f1f1f",
    incoming: "#292929",
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
    return { x: 0, y: 0, width: 720, height: 1280, radius: 0, headerHeight: 154 };
  }
  if (layout === "chat_gameplay") {
    return { x: 0, y: 0, width: 720, height: 760, radius: 0, headerHeight: 142 };
  }
  const height = Math.max(178, Math.min(520, panelHeight));
  return { x: 11, y: 58, width: 702, height, radius: 36, headerHeight: Math.min(128, height * 0.47) };
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
  typingSide?: "left" | "right" | null,
) {
  const colors = messageVideoStyle(theme);
  const stage = context.createLinearGradient(0, 0, 720, 1280);
  stage.addColorStop(0, "#2f8d66");
  stage.addColorStop(0.55, "#2a7659");
  stage.addColorStop(1, "#205844");
  context.fillStyle = stage;
  context.fillRect(0, 0, 720, 1280);
  if (background) {
    drawCover(context, background, 720, 1280);
    context.fillStyle = "rgba(17,73,51,.22)";
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
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(x + 34, y + 42);
  context.lineTo(x + 24, y + 55);
  context.lineTo(x + 34, y + 68);
  context.stroke();
  context.beginPath();
  context.arc(x + 63, y + 55, 19, 0, Math.PI * 2);
  context.fillStyle = blue;
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "500 12px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.fillText("99", x + 63, y + 59);

  const centre = x + width / 2;
  context.beginPath();
  context.arc(centre, y + 48, 35, 0, Math.PI * 2);
  context.fillStyle = colors.avatar;
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "300 31px -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillText((name || "Unknown").slice(0, 1).toUpperCase(), centre, y + 59);
  context.font = "600 21px -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = colors.contactText;
  context.fillText(`${name || "Unknown"} ›`, centre, y + 108);

  const cameraX = x + width - 63;
  const cameraY = y + 48;
  context.strokeStyle = blue;
  context.lineWidth = 3;
  roundedRect(context, cameraX - 17, cameraY - 11, 27, 22, 5);
  context.stroke();
  context.beginPath();
  context.moveTo(cameraX + 10, cameraY - 6);
  context.lineTo(cameraX + 21, cameraY - 12);
  context.lineTo(cameraX + 21, cameraY + 12);
  context.lineTo(cameraX + 10, cameraY + 6);
  context.closePath();
  context.stroke();

  context.font = "400 25px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "left";
  const shown = messages.slice(0, visible).map((message) => {
    const lines = wrapText(context, message.text, 430).slice(0, 2);
    const bubbleWidth = Math.min(470, Math.max(94, ...lines.map((line) => context.measureText(line).width + 34)));
    const bubbleHeight = Math.max(49, lines.length * 29 + 18);
    return { message, lines, bubbleWidth, bubbleHeight };
  });
  const available = Math.max(48, height - headerHeight - 14);
  let contentHeight = shown.reduce((sum, item) => sum + item.bubbleHeight + 8, 0) + (typingSide ? 48 : 0);
  while (shown.length > 1 && contentHeight > available) {
    const removed = shown.shift();
    if (removed) contentHeight -= removed.bubbleHeight + 8;
  }
  let bubbleY = y + headerHeight + 8;
  if (shown.length > 2) bubbleY = y + height - contentHeight - 4;
  for (const [index, item] of shown.entries()) {
    const { message, lines, bubbleWidth, bubbleHeight } = item;
    if (shown.length === 2 && index === 1) bubbleY = y + height - bubbleHeight - 8;
    const bubbleX = message.side === "right" ? x + width - bubbleWidth - 17 : x + 17;
    roundedRect(context, bubbleX, bubbleY, bubbleWidth, bubbleHeight, bubbleHeight / 2);
    context.fillStyle = message.side === "right" ? colors.outgoing : colors.incoming;
    context.fill();
    if (message.side === "left") {
      context.beginPath();
      context.moveTo(bubbleX + 12, bubbleY + bubbleHeight - 13);
      context.quadraticCurveTo(bubbleX + 3, bubbleY + bubbleHeight + 6, bubbleX - 7, bubbleY + bubbleHeight + 5);
      context.quadraticCurveTo(bubbleX + 1, bubbleY + bubbleHeight - 2, bubbleX + 4, bubbleY + bubbleHeight - 16);
      context.closePath();
      context.fillStyle = colors.incoming;
      context.fill();
    }
    context.fillStyle = message.side === "right" ? colors.outgoingText : colors.incomingText;
    lines.forEach((line, lineIndex) => context.fillText(line, bubbleX + 17, bubbleY + 32 + lineIndex * 29));
    bubbleY += bubbleHeight + 8;
  }
  if (typingSide) {
    const typingX = typingSide === "right" ? x + width - 91 : x + 17;
    const typingY = Math.min(y + height - 43, bubbleY);
    roundedRect(context, typingX, typingY, 74, 38, 19);
    context.fillStyle = typingSide === "right" ? colors.outgoing : colors.incoming;
    context.fill();
    for (let index = 0; index < 3; index += 1) {
      context.beginPath();
      context.arc(typingX + 22 + index * 15, typingY + 19, 4, 0, Math.PI * 2);
      context.fillStyle = typingSide === "right" || theme === "ios_dark" ? "rgba(255,255,255,.72)" : "rgba(23,33,27,.55)";
      context.fill();
    }
  }
  context.restore();
}

export async function renderMessageStoryVideo(options: { name: string; messages: CreatorMessage[]; voices: Record<"left" | "right", CreatorVoice>; background?: string; backgroundVideo?: string; theme?: MessageTheme; layout?: MessageLayout; onProgress?: (progress: number) => void; signal?: AbortSignal }) {
  const speeches: Array<ArrayBuffer | null> = [];
  for (let index = 0; index < options.messages.length; index += 1) {
    throwIfCancelled(options.signal);
    const message = options.messages[index];
    if (message.narration === false) speeches.push(null);
    else {
      const speech = await synthesizeCreatorSpeech(message.text, options.voices[message.side], options.signal);
      speeches.push(await speech.blob.arrayBuffer());
    }
    options.onProgress?.((index + 1) / Math.max(1, options.messages.length) * 0.3);
  }
  const setup = await prepareRecorder();
  let backgroundTimer: number | undefined;
  let backgroundVideo: HTMLVideoElement | null = null;
  try {
    backgroundVideo = await loadVideo(options.backgroundVideo);
    const background: CreatorBackgroundMedia | null = backgroundVideo || await loadImage(options.background);
    if (backgroundVideo) {
      backgroundVideo.currentTime = 0;
      await backgroundVideo.play().catch(() => undefined);
    }
    const theme = options.theme || "ios_dark";
    const layout = options.layout || "floating_phone";
    let currentHeight = 178;
    let currentVisible = 0;
    let currentTyping: "left" | "right" | null = null;
    const drawCurrentFrame = () => drawMessageVideo(
      setup.context,
      background,
      options.name,
      options.messages,
      currentVisible,
      currentHeight,
      theme,
      layout,
      currentTyping,
    );
    drawCurrentFrame();
    if (backgroundVideo) backgroundTimer = window.setInterval(drawCurrentFrame, 1_000 / 30);
    await cancellableDelay(220, options.signal);
    for (let index = 0; index < options.messages.length; index += 1) {
      throwIfCancelled(options.signal);
      const message = options.messages[index];
      const typingDuration = Math.max(0, Math.min(8, message.typingSeconds ?? 0.8)) * 1_000;
      if (typingDuration > 0) {
        currentVisible = index;
        currentTyping = message.side;
        drawCurrentFrame();
        await cancellableDelay(typingDuration, options.signal);
      }
      currentTyping = null;
      currentVisible = index + 1;
      const targetHeight = Math.min(520, 178 + (index + 1) * 58);
      const started = performance.now();
      while (performance.now() - started < 220) {
        throwIfCancelled(options.signal);
        const progress = Math.min(1, (performance.now() - started) / 220);
        currentHeight += (targetHeight - currentHeight) * (1 - Math.pow(1 - progress, 3));
        drawCurrentFrame();
        await cancellableDelay(16, options.signal);
      }
      currentHeight = targetHeight;
      drawCurrentFrame();
      if (speeches[index]) await playIntoRecording(setup.audioContext, setup.audioDestination, speeches[index]!, options.signal);
      await cancellableDelay(Math.max(80, Math.min(3_000, (message.pauseSeconds ?? 0.25) * 1_000)), options.signal);
      options.onProgress?.(0.3 + (index + 1) / options.messages.length * 0.64);
    }
    const blob = await finishRecording(setup);
    options.onProgress?.(0.97);
    const mp4 = await transcodeCreatorVideo(blob, "clyra-message-story", options.signal);
    options.onProgress?.(1);
    return mp4;
  } catch (error) {
    await disposeRecording(setup);
    throw error;
  } finally {
    if (backgroundTimer !== undefined) window.clearInterval(backgroundTimer);
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
