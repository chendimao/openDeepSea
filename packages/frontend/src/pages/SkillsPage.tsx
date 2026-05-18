import { ShieldCheck } from 'lucide-react';
import { SkillsSettingsPanel } from '../components/SkillsSettingsPanel';
import { useI18n } from '../lib/i18n';

export function SkillsPage(): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="files-page">
      <header className="agents-header">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.8} />
            <h1 className="font-display text-[22px] font-semibold tracking-tight">{t('skillsPage.title')}</h1>
          </div>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {t('skillsPage.description')}
          </p>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4">
        <SkillsSettingsPanel showUsageGuide />
      </main>
    </div>
  );
}
