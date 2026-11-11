import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideViewportProvider } from './GuideViewportManager';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let scroller: HTMLDivElement | null = null;
let top = 0;
let height = 16_000;
const viewport = 1_000;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  scroller?.remove();
  scroller = null;
  top = 0;
  height = 16_000;
  document.body.innerHTML = '';
});

async function renderGuide(): Promise<HTMLDivElement> {
  scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; },
  });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => viewport });
  document.body.appendChild(scroller);

  const mount = document.createElement('div');
  scroller.appendChild(mount);
  await act(async () => {
    root = createRoot(mount);
    root.render(
      <GuideViewportProvider>
        <div>guide</div>
      </GuideViewportProvider>,
    );
  });
  return scroller;
}

function scrollTo(value: number): void {
  top = value;
  scroller!.dispatchEvent(new Event('scroll'));
}

async function frames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
}

function pressEnd(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
}

describe('End hold', () => {
  test.skipIf(!hasDom)('keeps the view at the end while the files there change height', async () => {
    await renderGuide();
    pressEnd();
    scrollTo(15_000);
    await frames();

    height = 16_058;
    await frames();
    expect(top).toBe(15_058);

    height = 16_066;
    await frames();
    expect(top).toBe(15_066);
  });

  test.skipIf(!hasDom)('leaves a wheel scroll back up alone', async () => {
    await renderGuide();
    pressEnd();
    scrollTo(15_000);
    await frames();

    window.dispatchEvent(new WheelEvent('wheel'));
    scrollTo(14_600);
    height = 16_058;
    await frames();
    expect(top).toBe(14_600);
  });

  test.skipIf(!hasDom)('leaves a scrollbar drag back up alone', async () => {
    await renderGuide();
    pressEnd();
    scrollTo(15_000);
    await frames();

    scrollTo(14_600);
    await frames();
    height = 16_058;
    await frames();
    expect(top).toBe(14_600);
  });

  test.skipIf(!hasDom)('leaves a key takeover alone', async () => {
    await renderGuide();
    pressEnd();
    scrollTo(15_000);
    await frames();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTo(14_600);
    height = 16_058;
    await frames();
    expect(top).toBe(14_600);
  });

  test.skipIf(!hasDom)('does not hold an End that rests more than a view from the end', async () => {
    await renderGuide();
    pressEnd();
    scrollTo(300);
    await frames(5);
    expect(top).toBe(300);
  });

  test.skipIf(!hasDom)('does not hold End pressed in a text field', async () => {
    await renderGuide();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    scrollTo(300);
    await frames(5);
    expect(top).toBe(300);
  });
});
