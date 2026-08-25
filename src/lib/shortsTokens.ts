import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "clyra-shorts-tokens-remaining";
export const SHORTS_FREE_TOKENS = 3;

function readStoredTokens(): number {
  if (typeof window === "undefined") return SHORTS_FREE_TOKENS;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return SHORTS_FREE_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(SHORTS_FREE_TOKENS, parsed)) : SHORTS_FREE_TOKENS;
}

/**
 * Honest, local-only "free renders" counter for the Shorts Studio welcome
 * page. There is no backend credit system behind this — it never blocks the
 * user or claims a charge; it just tracks and displays how many of the free
 * renders have been used on this device.
 */
export function useShortsTokens() {
  const [remaining, setRemaining] = useState(readStoredTokens);

  useEffect(() => {
    setRemaining(readStoredTokens());
  }, []);

  const consume = useCallback(() => {
    setRemaining((current) => {
      const next = Math.max(0, current - 1);
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { remaining, total: SHORTS_FREE_TOKENS, hasTokens: remaining > 0, consume };
}
