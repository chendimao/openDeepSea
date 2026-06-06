import { Check, CircleDot, Lightbulb, ShieldAlert } from 'lucide-react';
import type { BrainstormingOption, BrainstormingOptionMaturity } from '../../lib/types';
import { cn } from '../../lib/utils';

interface BrainstormingOptionsPanelProps {
  options: BrainstormingOption[];
  selectedOptionIds?: Set<string> | string[];
  disabled?: boolean;
  onSelect?: (option: BrainstormingOption) => void;
}

const maturityLabels: Record<BrainstormingOptionMaturity, string> = {
  exploratory: '继续讨论',
  boundary_needed: '先定边界',
  actionable: '可直接执行',
};

const maturityTones: Record<BrainstormingOptionMaturity, string> = {
  exploratory: 'text-slate-600 bg-slate-100 border-slate-200',
  boundary_needed: 'text-amber-700 bg-amber-50 border-amber-200',
  actionable: 'text-emerald-700 bg-emerald-50 border-emerald-200',
};

export function BrainstormingOptionsPanel({
  options,
  selectedOptionIds,
  disabled = false,
  onSelect,
}: BrainstormingOptionsPanelProps): JSX.Element | null {
  if (options.length === 0) return null;
  const selected = toSelectedSet(selectedOptionIds);

  return (
    <div className="mt-3 space-y-2" data-brainstorming-options>
      {options.map((option) => {
        const isSelected = selected.has(option.id);
        const isDisabled = disabled || isSelected;
        const Icon = option.maturity === 'exploratory'
          ? Lightbulb
          : option.maturity === 'actionable'
            ? CircleDot
            : ShieldAlert;

        return (
          <article
            key={option.id}
            className={cn(
              'rounded-md border bg-white/85 p-3 text-sm shadow-sm transition',
              isSelected ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-slate-200 hover:border-slate-300',
            )}
          >
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.8} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h4 className="min-w-0 break-words text-[13px] font-semibold leading-5 text-slate-900">{option.title}</h4>
                  {option.recommended && (
                    <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                      推荐
                    </span>
                  )}
                  <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', maturityTones[option.maturity])}>
                    {maturityLabels[option.maturity]}
                  </span>
                </div>
                <p className="mt-1 min-w-0 break-words leading-5 text-slate-700">{option.summary}</p>
                <OptionList items={option.benefits} />
                <OptionList items={option.risks} tone="risk" />
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition',
                  isSelected
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                )}
                disabled={isDisabled}
                aria-pressed={isSelected}
                onClick={() => onSelect?.(option)}
              >
                {isSelected && <Check className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />}
                {isSelected ? '已选择' : '选择此方案'}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function OptionList({ items, tone = 'benefit' }: { items: string[]; tone?: 'benefit' | 'risk' }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className={cn('mt-1.5 space-y-0.5 text-xs leading-5', tone === 'risk' ? 'text-amber-700' : 'text-slate-600')}>
      {items.slice(0, 3).map((item) => (
        <li key={item} className="flex min-w-0 gap-1.5">
          <span aria-hidden="true">-</span>
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function toSelectedSet(value: Set<string> | string[] | undefined): Set<string> {
  if (!value) return new Set();
  return value instanceof Set ? value : new Set(value);
}
