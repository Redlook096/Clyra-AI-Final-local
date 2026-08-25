/**
 * Detects whether a project workspace is a Swift/iOS project (used to tag
 * project platform and to decide when to seed the iOS agent skills).
 */
import fs from "node:fs";
import path from "node:path";

export function detectMobileSwiftProject(root: string) {
  try {
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || /^(node_modules|build|DerivedData|\.build)$/i.test(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        if (entry.isFile() && (entry.name === "Package.swift" || entry.name.endsWith(".swift"))) return true;
      }
    }
  } catch { /* non-existent workspace */ }
  return false;
}
