/** Hosts that only ever reach this computer. Local development serves Storage
 * over plain http on one of them; it never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A signed Storage link the browser opens to save a file: https, or plain http
 * only to this computer, and never with embedded credentials. */
export function isSignedDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch { return false; }
}
