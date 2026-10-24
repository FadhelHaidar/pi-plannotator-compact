import React, { useMemo } from 'react';
import { planModelKey, type PlanModelOption } from '../hooks/usePlanModels';

interface PlanModelPickerProps {
  models: PlanModelOption[];
  current: PlanModelOption | null;
  /** `null` = approve with whatever model the host's phase config resolves. */
  value: PlanModelOption | null;
  onChange: (model: PlanModelOption | null) => void;
  disabled?: boolean;
}

/**
 * Model to run the approved plan with. The empty choice is the default and
 * means "no switch": the host keeps the model it would have used anyway, so a
 * reviewer who does not care about this is never surprised by it.
 */
export const PlanModelPicker: React.FC<PlanModelPickerProps> = ({
  models,
  current,
  value,
  onChange,
  disabled = false,
}) => {
  const groups = useMemo(() => {
    const byProvider = new Map<string, PlanModelOption[]>();
    for (const model of models) {
      const list = byProvider.get(model.provider);
      if (list) list.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return Array.from(byProvider, ([provider, entries]) => ({ provider, entries }));
  }, [models]);

  if (models.length === 0) return null;

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only md:not-sr-only">Run with</span>
      <select
        value={value ? planModelKey(value) : ''}
        disabled={disabled}
        title="Model to run the approved plan with"
        onChange={(event) => {
          const key = event.target.value;
          onChange(key ? models.find((model) => planModelKey(model) === key) ?? null : null);
        }}
        className="h-8 max-w-[16rem] rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none transition-colors focus:border-primary disabled:opacity-50"
      >
        <option value="">Use execution settings</option>
        {groups.map(({ provider, entries }) => (
          <optgroup key={provider} label={provider}>
            {entries.map((model) => (
              <option key={planModelKey(model)} value={planModelKey(model)}>
                {model.name}{current && planModelKey(model) === planModelKey(current) ? ' (current)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
};
