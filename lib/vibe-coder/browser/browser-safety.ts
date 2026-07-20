export class BrowserSafety {
  /**
   * Prevents the AI from navigating away from localhost
   * or executing harmful JS payloads.
   */
  static isSafeUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    } catch {
      return false;
    }
  }
}
