/**
 * Minimal line diff for the Changes tab. Renders real before/after content
 * from the harness diff endpoint as a unified diff. LCS on lines, capped for
 * very large files (falls back to a full replace view).
 */
export type DiffLine = {
  kind: "context" | "add" | "del";
  text: string;
  beforeLine?: number;
  afterLine?: number;
};

const MAX_LCS_LINES = 600;

export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text, i) => ({ kind: "del" as const, text, beforeLine: i + 1 })),
      ...b.map((text, i) => ({ kind: "add" as const, text, afterLine: i + 1 })),
    ];
  }

  // LCS table
  const n = a.length;
  const m = b.length;
  const table: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "del", text: a[i], beforeLine: i + 1 });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j], afterLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: a[i], beforeLine: i + 1 });
    i++;
  }
  while (j < m) {
    lines.push({ kind: "add", text: b[j], afterLine: j + 1 });
    j++;
  }
  return collapseContext(lines);
}

/** Render a unified-diff patch string (from the harness edit tool) directly. */
export function linesFromPatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("@@")) {
      lines.push({ kind: "context", text: raw });
      continue;
    }
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
    else lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return lines;
}

/** Keep 3 context lines around changes; fold long unchanged runs. */
function collapseContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let folded = 0;
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      if (folded > 0) {
        out.push({ kind: "context", text: `… ${folded} unchanged lines` });
        folded = 0;
      }
      out.push(lines[k]);
    } else {
      folded++;
    }
  }
  if (folded > 0) out.push({ kind: "context", text: `… ${folded} unchanged lines` });
  return out;
}
