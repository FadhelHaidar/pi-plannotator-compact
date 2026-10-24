/**
 * Hook for the approval model picker: the host's model catalog and the model in
 * effect now, from `/api/models` (served only by hosts that can switch models).
 */

import { useCallback, useEffect, useState } from 'react';

export interface PlanModelOption {
  provider: string;
  id: string;
  name: string;
}

export interface UsePlanModelsResult {
  models: PlanModelOption[];
  current: PlanModelOption | null;
  isLoading: boolean;
  /** Stable key for a model, usable as a `<select>` value. */
  keyOf: (model: PlanModelOption) => string;
}

export function planModelKey(model: PlanModelOption): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Fetch the catalog once per session. No catalog (older host, or one that
 * cannot switch models) leaves `models` empty and the picker hidden.
 */
export function usePlanModels(enabled: boolean): UsePlanModelsResult {
  const [models, setModels] = useState<PlanModelOption[]>([]);
  const [current, setCurrent] = useState<PlanModelOption | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setIsLoading(true);
    fetch('/api/models')
      .then(res => res.json())
      .then((data: { models?: PlanModelOption[]; current?: PlanModelOption | null }) => {
        if (cancelled) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setCurrent(data.current ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setCurrent(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const keyOf = useCallback((model: PlanModelOption) => planModelKey(model), []);

  return { models, current, isLoading, keyOf };
}
