const MAGIC = 0x43545453; // CTTS
const HEADER_BYTES = 32;

export type VoicePcmMetadata = {
  sessionId: string;
  responseId: string;
  generation: number;
  sequence: number;
  phraseSequence: number;
  sampleRate: number;
};

export function stableVoiceId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function encodeVoicePcmPacket(pcm: Uint8Array, metadata: VoicePcmMetadata) {
  const output = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint8(4, 1);
  view.setUint8(5, 0);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, metadata.sampleRate, true);
  view.setUint32(12, metadata.generation, true);
  view.setUint32(16, metadata.sequence, true);
  view.setUint32(20, metadata.phraseSequence, true);
  view.setUint32(24, stableVoiceId(metadata.sessionId), true);
  view.setUint32(28, stableVoiceId(metadata.responseId), true);
  output.set(pcm, HEADER_BYTES);
  return output;
}

export function decodeVoicePcmPacket(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC || view.getUint8(4) !== 1) return null;
  const headerBytes = view.getUint16(6, true);
  if (headerBytes < HEADER_BYTES || headerBytes > bytes.byteLength) return null;
  return {
    sampleRate: view.getUint32(8, true),
    generation: view.getUint32(12, true),
    sequence: view.getUint32(16, true),
    phraseSequence: view.getUint32(20, true),
    sessionHash: view.getUint32(24, true),
    responseHash: view.getUint32(28, true),
    pcm: bytes.slice(headerBytes),
  };
}
