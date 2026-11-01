import { describe, expect, test } from 'bun:test';
import { openExternalUrl } from './externalUrl';

function record() {
  const calls: unknown[][] = [];
  const open = ((...args: unknown[]) => {
    calls.push(args);
    return null;
  }) as unknown as typeof window.open;
  return { calls, open };
}

describe('openExternalUrl', () => {
  test('opens http and https URLs in a new tab without an opener', () => {
    const { calls, open } = record();
    openExternalUrl('https://github.com/FadhelHaidar/pi-plannotator-compact/releases', open);
    openExternalUrl('http://localhost:36413/doc.html', open);
    expect(calls).toEqual([
      ['https://github.com/FadhelHaidar/pi-plannotator-compact/releases', '_blank', 'noopener,noreferrer'],
      ['http://localhost:36413/doc.html', '_blank', 'noopener,noreferrer'],
    ]);
  });

  test('drops script, data and unparsable targets', () => {
    const { calls, open } = record();
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'not a url', '']) {
      openExternalUrl(url, open);
    }
    expect(calls).toEqual([]);
  });
});
