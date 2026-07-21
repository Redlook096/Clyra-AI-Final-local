import path from "node:path";

export function clyraResourceRoot() {
  return process.env.CLYRA_RESOURCE_ROOT || process.cwd();
}

export function clyraDataRoot() {
  return process.env.CLYRA_DATA_ROOT || process.cwd();
}

export function clyraResourcePath(...segments: string[]) {
  return path.join(clyraResourceRoot(), ...segments);
}

export function clyraDataPath(...segments: string[]) {
  return path.join(clyraDataRoot(), ...segments);
}
