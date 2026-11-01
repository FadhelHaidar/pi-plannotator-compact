import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIChatEntry } from '../../hooks/useAIChat';
import { resetUploadTransport, setUploadTransport } from '../../utils/upload';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./DocumentAIChatPanel') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUploadTransport();
});

function render(props: Record<string, unknown>): HTMLDivElement {
  const { DocumentAIChatPanel } = panelModule!;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <DocumentAIChatPanel isCreatingSession={false} isStreaming={false} {...(props as { messages: AIChatEntry[] })} />,
    );
  });
  return host;
}

function pasteImage(textarea: HTMLTextAreaElement, name = 'shot.png'): void {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { items: { type: string; getAsFile: () => File }[] };
  };
  event.clipboardData = { items: [{ type: 'image/png', getAsFile: () => file }] };
  act(() => {
    textarea.dispatchEvent(event);
  });
}

describe.if(hasDom)('Ask AI pasted images', () => {
  test('a pasted screenshot becomes a visible thumbnail and travels with the question', async () => {
    const upload = mock(async () => ({ path: '/tmp/plannotator/shot.png', originalName: 'shot.png' }));
    setUploadTransport({ upload });

    const onAskGeneral = mock((_question: string, _images?: { path: string; name: string }[]) => {});
    const el = render({ messages: [], onAskGeneral });

    const textarea = el.querySelector('textarea')!;
    pasteImage(textarea);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Uploaded through the shared transport, then shown before sending.
    expect(upload.mock.calls.length).toBe(1);
    // Shown before sending, with a labeled remove control.
    expect(el.querySelector('[title="shot.png"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Remove attachment"]')).not.toBeNull();

    act(() => {
      el.querySelector<HTMLButtonElement>('[aria-label="Send AI question"]')!.click();
    });
    expect(onAskGeneral.mock.calls).toEqual([['', [{ path: '/tmp/plannotator/shot.png', name: 'shot.png' }]]]);
  });

  test('the sent message shows the attached image next to the question text', () => {
    const el = render({
      messages: [
        {
          question: {
            id: 'q1',
            prompt: 'what changed here?',
            images: [{ path: '/tmp/plannotator/shot.png', name: 'shot.png' }],
            createdAt: 0,
          },
          response: { questionId: 'q1', text: '', isStreaming: false, createdAt: 0 },
        },
      ],
      onAskGeneral: () => {},
    });

    expect(el.textContent).toContain('what changed here?');
    expect(el.textContent).not.toContain('[image]');
    expect(el.querySelector('a[href*="path=%2Ftmp%2Fplannotator%2Fshot.png"]')).not.toBeNull();
  });

  test('a question cannot be sent while its screenshot is still uploading', async () => {
    let finishUpload: (value: { path: string; originalName: string }) => void = () => {};
    const upload = mock(
      () =>
        new Promise<{ path: string; originalName: string }>((resolve) => {
          finishUpload = resolve;
        }),
    );
    setUploadTransport({ upload });

    const onAskGeneral = mock((_question: string, _images?: { path: string; name: string }[]) => {});
    const el = render({ messages: [], onAskGeneral });

    pasteImage(el.querySelector('textarea')!);
    expect(el.textContent).toContain('Uploading…');
    const send = el.querySelector<HTMLButtonElement>('[aria-label="Send AI question"]')!;
    expect(send.disabled).toBe(true);
    act(() => {
      send.click();
    });
    expect(onAskGeneral.mock.calls.length).toBe(0);

    await act(async () => {
      finishUpload({ path: '/tmp/plannotator/shot.png', originalName: 'shot.png' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(send.disabled).toBe(false);
  });

  test('a user-written [image] line stays question text', () => {
    for (const prompt of ['why does\n[image] placeholder\nstay here?', 'Explain this syntax:\n[image] /foo']) {
      const el = render({
        messages: [
          {
            question: { id: 'q1', prompt, createdAt: 0 },
            response: { questionId: 'q1', text: '', isStreaming: false, createdAt: 0 },
          },
        ],
        onAskGeneral: () => {},
      });

      expect(el.textContent).toContain('[image]');
      expect(el.querySelector('a[href*="api/image"]')).toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });
});
