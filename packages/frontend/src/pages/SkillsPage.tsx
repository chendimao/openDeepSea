import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { SkillMarketplacePanel } from '../components/SkillMarketplacePanel';
import { SkillRunHistoryPanel } from '../components/SkillRunHistoryPanel';
import { SkillUpdateSettingsPanel } from '../components/SkillUpdateSettingsPanel';
import { SkillsSettingsPanel } from '../components/SkillsSettingsPanel';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function SkillsPage(): JSX.Element {
  const { t } = useI18n();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [historyFilterSkillId, setHistoryFilterSkillId] = useState<string | null>(null);
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: api.listSkills,
  });
  const skills = skillsQuery.data ?? [];
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null,
    [selectedSkillId, skills],
  );

  function selectSkill(skillId: string | null): void {
    setSelectedSkillId(skillId);
    setHistoryFilterSkillId(skillId);
  }

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
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.85fr)]">
          <div className="min-w-0 space-y-4">
            <SkillMarketplacePanel onInstalled={selectSkill} />
            <SkillsSettingsPanel
              showUsageGuide
              selectedSkillId={selectedSkillId}
              onSelectedSkillIdChange={selectSkill}
            />
          </div>
          <div className="min-w-0 space-y-4">
            <SkillUpdateSettingsPanel skill={selectedSkill} />
            <SkillRunHistoryPanel
              selectedSkillId={historyFilterSkillId}
              skills={skills}
              onClearFilter={() => setHistoryFilterSkillId(null)}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
