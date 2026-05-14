import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { FolderKanban, Home, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import type { Project } from '../lib/types';
import { truncate } from '../lib/utils';

interface CommandMenuProps {
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateProject: () => void;
}

export function CommandMenu({
  projects,
  open,
  onOpenChange,
  onCreateProject,
}: CommandMenuProps): JSX.Element {
  const navigate = useNavigate();
  const { t } = useI18n();

  const go = (to: string) => {
    navigate(to);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="command-menu-overlay" />
        <DialogPrimitive.Content className="command-menu surface-1">
          <DialogPrimitive.Title className="sr-only">{t('command.title')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('command.description')}
          </DialogPrimitive.Description>
          <Command label={t('command.title')}>
            <div className="command-menu-input">
              <Search className="h-4 w-4 text-[var(--color-fg-muted)]" strokeWidth={1.75} />
              <Command.Input placeholder={t('command.placeholder')} />
            </div>
            <Command.List className="command-menu-list">
              <Command.Empty className="px-3 py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
                {t('command.empty')}
              </Command.Empty>

              <Command.Group heading={t('command.group.navigation')}>
                <Command.Item value="dashboard all projects" onSelect={() => go('/')}>
                  <Home className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
                  <span>{t('command.dashboard')}</span>
                </Command.Item>
                <Command.Item value="create project new" onSelect={onCreateProject}>
                  <Plus className="h-4 w-4 text-[var(--color-primary)]" strokeWidth={1.75} />
                  <span>{t('command.createProject')}</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading={t('command.group.projects', { count: projects.length })}>
                {projects.map((project) => (
                  <Command.Item
                    key={project.id}
                    value={`${project.name} ${project.path}`}
                    onSelect={() => go(`/projects/${project.id}`)}
                  >
                    <FolderKanban className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] text-[var(--color-fg)]">{project.name}</div>
                      <div className="truncate font-mono text-[10.5px] text-[var(--color-muted)]">
                        {truncate(project.path, 62)}
                      </div>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
