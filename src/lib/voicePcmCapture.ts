/** Browser PCM16 mic capture for the streaming voice pipeline. */

export type PcmChunkHandler = (base64Pcm16: string, seq: number) => void;
export type PcmLevelHandler = (level: number) => void;

/** Disable and stop every browser capture track so the OS privacy indicator clears. */
export function stopMediaStreamTracks(stream: Pick<MediaStream, "getTracks"> | null | undefined) {
  for (const track of stream?.getTracks() ?? []) {
    track.enabled = false;
    track.stop();
  }
}

function floatTo16BitPCM(input: Float32Array) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(pcm: Int16Array) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function rmsLevel(samples: Float32Array) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  // Typical speech RMS sits ~0.02–0.2 after browser AGC; map to a readable 0–1.
  const normalized = (rms - 0.006) / 0.1;
  return Math.max(0, Math.min(1, normalized));
}

export class VoicePcmCapturer {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private seq = 0;
  private muted = false;
  private ownsStream = true;
  private onChunk: PcmChunkHandler;
  private onLevel: PcmLevelHandler | null;
  private targetRate: number;

  constructor(
    onChunk: PcmChunkHandler,
    targetRate = 16000,
    onLevel: PcmLevelHandler | null = null,
  ) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.targetRate = targetRate;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  setLevelHandler(onLevel: PcmLevelHandler | null) {
    this.onLevel = onLevel;
  }

  async start(existingStream?: MediaStream | null) {
    if (existingStream && existingStream.active) {
      this.stream = existingStream;
      this.ownsStream = false;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      this.ownsStream = true;
    }
    // Prefer native device rate; resample in JS only when needed.
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ~128ms @ 16k / ~42ms @ 48k — responsive meter + low capture latency.
    const bufferSize = this.ctx.sampleRate >= 44100 ? 2048 : 2048;
    this.processor = this.ctx.createScriptProcessor(bufferSize, 1, 1);
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const context = this.ctx;
      if (!context) return;
      const input = event.inputBuffer.getChannelData(0);
      const level = this.muted ? 0 : rmsLevel(input);
      this.onLevel?.(level);
      if (this.muted) return;

      let samples: Float32Array = input;
      if (Math.abs(context.sampleRate - this.targetRate) > 1) {
        const ratio = context.sampleRate / this.targetRate;
        const length = Math.floor(input.length / ratio);
        const resampled = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          resampled[i] = input[Math.floor(i * ratio)] ?? 0;
        }
        samples = resampled;
      }
      const pcm = floatTo16BitPCM(samples);
      this.seq += 1;
      this.onChunk(int16ToBase64(pcm), this.seq);
    };
    this.source.connect(this.processor);
    // CRITICAL: never route mic into speakers — that caused feedback/clicks/pops.
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  get mediaStream() {
    return this.stream;
  }

  get audioContext() {
    return this.ctx;
  }

  stop() {
    try {
      if (this.processor) this.processor.onaudioprocess = null;
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silentGain?.disconnect();
    } catch {
      // ignore
    }
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    if (this.ownsStream) {
      this.stream?.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
