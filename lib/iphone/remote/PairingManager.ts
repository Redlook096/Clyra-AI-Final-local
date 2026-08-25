/**
 * Short-lived pairing codes for the Windows → Mac Apple Host connection.
 * A code is generated on the Mac (shown in the Clyra iPhone panel), entered
 * once on the Windows client, and exchanged here for a long-lived session
 * token the client persists for silent reconnect (DeviceRegistry on the
 * client side keeps that token per saved host).
 */
import { randomBytes, randomUUID } from "node:crypto";

type PendingCode = { code: string; expiresAt: number };
type Session = { token: string; hostLabel: string; createdAt: number };

const CODE_TTL_MS = 10 * 60 * 1000;
const pendingCodes = new Map<string, PendingCode>();
const sessions = new Map<string, Session>();

function randomCode() {
  // Six digits, easy to type on a Windows client.
  return String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
}

export function issuePairingCode(): { code: string; expiresAt: number } {
  const code = randomCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  pendingCodes.set(code, { code, expiresAt });
  return { code, expiresAt };
}

export function redeemPairingCode(code: string, hostLabel: string): { token: string } | null {
  const pending = pendingCodes.get(code);
  if (!pending || pending.expiresAt < Date.now()) return null;
  pendingCodes.delete(code);
  const token = randomUUID();
  sessions.set(token, { token, hostLabel, createdAt: Date.now() });
  return { token };
}

export function isValidSession(token: string): boolean {
  return sessions.has(token);
}

export function revokeSession(token: string) {
  sessions.delete(token);
}

export function listSessions() {
  return [...sessions.values()];
}
