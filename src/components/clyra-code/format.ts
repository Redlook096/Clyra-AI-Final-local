export function stripFilePrefix(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const root = normalized.match(/^.*\/projects\/[^/]+\/files\/?$/);
  if (root) return "project root";
  return normalized.replace(/^.*\/projects\/[^/]+\/files\//, "").replace(/^\.\//, "");
}

export function formatTokens(tokens: { input: number; output: number } | null) {
  if (!tokens) return null;
  const total = tokens.input + tokens.output;
  if (!total) return null;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}
