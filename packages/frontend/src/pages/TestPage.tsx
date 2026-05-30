import { useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useI18n } from '../lib/i18n';

export function TestPage(): JSX.Element {
  const { t } = useI18n();
  const [count, setCount] = useState(0);

  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center">
        <section className="surface-1 rounded-[24px] p-5 sm:p-8">
          <div className="flex flex-col gap-3 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase text-[var(--color-muted)]">
                {t('test.kicker')}
              </p>
              <h1 className="mt-2 font-display text-[24px] font-semibold tracking-tight sm:text-[30px]">
                {t('test.title')}
              </h1>
              <p className="mt-2 max-w-[560px] text-[13px] leading-6 text-[var(--color-fg-muted)]">
                {t('test.description')}
              </p>
            </div>
            <div className="rounded-lg bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-[11px] text-[var(--color-fg-muted)] shadow-[inset_0_0_0_1px_var(--color-border)]">
              {t('test.localState')}
            </div>
          </div>

          <div className="grid gap-5 py-6 md:grid-cols-[minmax(0,1fr)_260px] md:items-center">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-5 py-6 sm:px-7 sm:py-8">
              <div className="text-[12px] font-medium text-[var(--color-fg-muted)]">
                {t('test.currentValue')}
              </div>
              <div className="mt-3 font-mono text-[72px] font-semibold leading-none tabular-nums text-[var(--color-fg)] sm:text-[96px]">
                {count}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 md:grid-cols-1">
              <Button
                type="button"
                variant="secondary"
                className="h-12"
                aria-label={t('test.decrement')}
                onClick={() => setCount((value) => value - 1)}
              >
                <Minus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('test.decrement')}</span>
              </Button>
              <Button
                type="button"
                variant="primary"
                className="h-12"
                aria-label={t('test.increment')}
                onClick={() => setCount((value) => value + 1)}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('test.increment')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-12"
                aria-label={t('test.reset')}
                onClick={() => setCount(0)}
              >
                <RotateCcw className="h-4 w-4" />
                <span className="hidden sm:inline">{t('test.reset')}</span>
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-code-bg)] px-4 py-3 font-mono text-[12px] leading-6 text-[var(--color-fg-muted)]">
            {t('test.hint')}
          </div>
        </section>
      </div>
    </div>
  );
}
