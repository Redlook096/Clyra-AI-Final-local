import crypto from "node:crypto";
import type { VoiceConfig } from "../config";

export type LiveKitSession = {
  url: string;
  token: string;
  room: string;
  identity: string;
};

function base64Url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signLiveKitJwt(
  apiKey: string,
  apiSecret: string,
  payload: Record<string, unknown>,
) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", apiSecret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${base64Url(sig)}`;
}

export function createLiveKitSession(
  config: VoiceConfig,
  sessionId: string,
  identity = "clyra-user",
): LiveKitSession | null {
  if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) {
    return null;
  }
  const room = `clyra-voice-${sessionId}`;
  const now = Math.floor(Date.now() / 1000);
  const token = signLiveKitJwt(config.livekitApiKey, config.livekitApiSecret, {
    iss: config.livekitApiKey,
    sub: identity,
    nbf: now,
    exp: now + 60 * 60,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    },
  });
  return {
    url: config.livekitUrl,
    token,
    room,
    identity,
  };
}
