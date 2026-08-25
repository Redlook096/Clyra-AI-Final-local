/**
 * Saved Mac hosts on the connecting (typically Windows) side. Persisted so
 * Clyra can reconnect on next launch without asking for a pairing code again.
 */
import fs from "node:fs";
import path from "node:path";
import { clyraDataPath } from "../../runtime-paths";

export type SavedHost = { hostLabel: string; url: string; token: string; pairedAt: number; lastConnectedAt?: number };

function registryPath() {
  return path.join(clyraDataPath("iphone"), "apple-hosts.json");
}

function readAll(): SavedHost[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return [];
  }
}

function writeAll(hosts: SavedHost[]) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hosts, null, 2), "utf8");
}

export function listSavedHosts(): SavedHost[] {
  return readAll();
}

export function saveHost(host: SavedHost) {
  const hosts = readAll().filter((h) => h.url !== host.url);
  hosts.push(host);
  writeAll(hosts);
}

export function touchHost(url: string) {
  const hosts = readAll();
  const host = hosts.find((h) => h.url === url);
  if (host) {
    host.lastConnectedAt = Date.now();
    writeAll(hosts);
  }
}

export function removeHost(url: string) {
  writeAll(readAll().filter((h) => h.url !== url));
}
