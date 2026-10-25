// One id per user action. The server treats a repeat of the same id (double click, retry after a timeout)
// as the same action and writes nothing twice. Matches the server's /^[A-Za-z0-9_-]{8,64}$/.
export function newRequestId(): string {
  const c = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (c && typeof c.randomUUID === "function") return `req_${c.randomUUID().replace(/-/g, "")}`;
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 10)}`;
}
