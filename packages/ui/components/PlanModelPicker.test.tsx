/**
 * The approval model picker: hidden without a catalog, defaults to "no switch",
 * and reports the pick (or its absence) to the approval body.
 *
 * What regresses if this fails: the picker swallows a catalog, or preselects a
 * model — which would silently move a reviewer off the model they planned with.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanModelPicker } from './PlanModelPicker';
import type { PlanModelOption } from '../hooks/usePlanModels';

const hasDom = typeof document !== 'undefined';
const MODELS: PlanModelOption[] = [
  { provider: 'anthropic', id: 'claude-opus-4', name: 'Claude Opus 4' },
  { provider: 'google', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(props: {
  models?: PlanModelOption[];
  current?: PlanModelOption | null;
  value?: PlanModelOption | null;
  onChange?: (model: PlanModelOption | null) => void;
}): Promise<{ select: HTMLSelectElement | null; picked: Array<PlanModelOption | null> }> {
  const picked: Array<PlanModelOption | null> = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <PlanModelPicker
        models={props.models ?? MODELS}
        current={props.current ?? MODELS[0]!}
        value={props.value ?? null}
        onChange={props.onChange ?? (model => picked.push(model))}
      />,
    );
  });
  return { select: host.querySelector('select'), picked };
}

describe.skipIf(!hasDom)('PlanModelPicker', () => {
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  test('no catalog renders nothing, so hosts without one never show it', async () => {
    const { select } = await render({ models: [] });
    expect(select).toBeNull();
  });

  test('defaults to execution settings and keeps the current model an explicit choice', async () => {
    const { select } = await render({});
    expect(select!.value).toBe('');
    expect(select!.options[0]!.textContent).toBe('Use execution settings');
    expect(Array.from(select!.options).map(option => option.textContent)).toEqual([
      'Use execution settings',
      'Claude Opus 4 (current)',
      'Gemini 2.5 Flash',
    ]);
  });

  test('picking a model reports it, and going back to the default reports null', async () => {
    const { select, picked } = await render({});
    await act(async () => {
      select!.value = 'google/gemini-2.5-flash';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      select!.value = '';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(picked).toEqual([MODELS[1]!, null]);
  });

  test('a value already picked is reflected on render', async () => {
    const { select } = await render({ value: MODELS[1]! });
    expect(select!.value).toBe('google/gemini-2.5-flash');
  });
});
