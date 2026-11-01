const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Open a page in a new tab, but only for plain http(s) URLs. Both call sites
 * take the URL from a server payload or a document link, so `javascript:` and
 * `data:` targets must never reach `window.open`.
 */
export function openExternalUrl(url: string, open: typeof window.open = window.open.bind(window)): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return;
  open(parsed.href, '_blank', 'noopener,noreferrer');
}
