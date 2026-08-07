import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Normalize API / caught errors into human-readable copy (never `[object Object]`). */
export function formatApiError(error: unknown, fallback = "Something went wrong."): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    const nested = record.error;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return fallback;
}
