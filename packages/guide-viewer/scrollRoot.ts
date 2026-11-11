/**
 * The nearest ancestor that actually scrolls the guide, or null for the
 * window. `body`/`html` are never returned: an overflow set on them propagates
 * to the viewport (the element itself does not scroll — its scrollHeight equals
 * its clientHeight), so observing it as an IntersectionObserver root would make
 * every shell "near", anchor distances to the middle of the whole document,
 * and hang the scroll listener on an element that never emits scroll events —
 * the CodeViews would then only mount on hover (`requestMount`).
 */
export function findScrollRoot(host: HTMLElement): HTMLElement | null {
  let current = host.parentElement;
  while (current) {
    if (current === document.body || current === document.documentElement) return null;
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
}
