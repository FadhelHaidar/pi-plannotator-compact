import { useEffect, type RefObject } from 'react';
import { findScrollRoot } from './scrollRoot';

const END_SETTLE_FRAMES = 2;
const END_STILL_FRAMES = 60;
const END_HOLD_MAX_MS = 2_000;
const END_PROBE_MAX_MS = 2_000;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable || target.closest('[contenteditable="true"]') !== null;
}

/**
 * End aims at the end of the page as it was when the key went down. Files at
 * the end then draw at their measured heights, which moves the end, and the
 * view is left short of it. Keep the view at the end while those files settle;
 * any wheel, touch, pointer, key, or scrollbar drag hands control back.
 */
export function useEndHold(hostRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = findScrollRoot(host);
    const scrollTarget: EventTarget = root ?? window;

    let pending: { lastTop: number; moved: boolean; frames: number; deadline: number } | null = null;
    let pendingRaf = 0;
    let holdRaf = 0;
    let holding = false;
    let lastTop = 0;
    let lastEnd = 0;
    let stillFrames = 0;
    let deadline = 0;

    const readTop = () => root?.scrollTop ?? window.scrollY;
    const readEnd = () =>
      root ? root.scrollHeight - root.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
    const readViewport = () => root?.clientHeight ?? window.innerHeight;

    const setTop = (top: number) => {
      if (root) root.scrollTop = top;
      else window.scrollTo({ top, behavior: 'instant' });
    };

    const stopHold = () => {
      if (!holding) return;
      holding = false;
      cancelAnimationFrame(holdRaf);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'mousedown']) {
        window.removeEventListener(type, stopHold, true);
      }
    };

    const holdFrame = () => {
      if (!holding) return;
      if (performance.now() >= deadline) {
        stopHold();
        return;
      }
      let top = readTop();
      const end = readEnd();
      // The view went up while the scroll stayed as tall: the person's own
      // scrollbar drag, which has no event we can listen for.
      if (end === lastEnd && top <= lastTop - 1) {
        stopHold();
        return;
      }
      if (top < end - 1) {
        setTop(end);
        top = end;
        stillFrames = 0;
      } else if (end !== lastEnd || top !== lastTop) {
        stillFrames = 0;
      } else {
        stillFrames += 1;
      }
      lastTop = top;
      lastEnd = end;
      if (stillFrames >= END_STILL_FRAMES) {
        stopHold();
        return;
      }
      holdRaf = requestAnimationFrame(holdFrame);
    };

    const startHold = () => {
      stopHold();
      holding = true;
      lastTop = readTop();
      lastEnd = readEnd();
      stillFrames = 0;
      deadline = performance.now() + END_HOLD_MAX_MS;
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'mousedown']) {
        window.addEventListener(type, stopHold, { capture: true, passive: true });
      }
      holdRaf = requestAnimationFrame(holdFrame);
    };

    const probe = () => {
      pendingRaf = 0;
      if (!pending) return;
      const top = readTop();
      if (top !== pending.lastTop) {
        pending.moved = true;
        pending.lastTop = top;
        pending.frames = 0;
      } else {
        pending.frames += 1;
      }
      if (pending.frames < END_SETTLE_FRAMES) {
        if (performance.now() < pending.deadline) pendingRaf = requestAnimationFrame(probe);
        else pending = null;
        return;
      }
      const moved = pending.moved;
      pending = null;
      const viewport = readViewport();
      if (!moved || viewport <= 0) return;
      if (readEnd() - readTop() >= viewport) return;
      startHold();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      stopHold();
      pending = null;
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      pendingRaf = 0;
      if (event.key !== 'End' || isEditable(event.target)) return;
      pending = { lastTop: readTop(), moved: false, frames: 0, deadline: performance.now() + END_PROBE_MAX_MS };
      pendingRaf = requestAnimationFrame(probe);
    };

    const onScroll = () => {
      if (!pending && !holding) return;
      if (pending) {
        const top = readTop();
        if (top !== pending.lastTop) {
          pending.moved = true;
          pending.lastTop = top;
          pending.frames = 0;
        }
        if (!pendingRaf) pendingRaf = requestAnimationFrame(probe);
      }
    };

    window.addEventListener('keydown', onKeyDown, { passive: true });
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      scrollTarget.removeEventListener('scroll', onScroll);
      stopHold();
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
    };
  }, [hostRef]);
}
