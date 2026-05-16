import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label, Textarea } from './ui/Input';

export function CreateProjectDialog({
  children,
  open,
  onOpenChange,
}: {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = open ?? internalOpen;
  const setDialogOpen = onOpenChange ?? setInternalOpen;
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const create = useMutation({
    mutationFn: () => api.createProject({ name, path, description: description || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('createProject.added'));
      setDialogOpen(false);
      setName('');
      setPath('');
      setDescription('');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pickFolder = useMutation({
    mutationFn: api.pickDirectory,
    onSuccess: (result) => {
      if (!result.canceled) setPath(result.path);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent
        title={t('createProject.title')}
        description={t('createProject.description')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !path.trim()) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <Label>{t('createProject.name')}</Label>
            <Input
              autoFocus
              placeholder="my-awesome-app"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>{t('createProject.path')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div
                className="min-h-9 flex-1 rounded-md surface-1 px-3 py-2 text-[13px] font-mono text-[var(--color-fg)]"
                title={path || t('createProject.noPathSelected')}
                aria-live="polite"
              >
                {path ? (
                  <span className="break-all">{path}</span>
                ) : (
                  <span className="font-sans text-[var(--color-muted)]">{t('createProject.noPathSelected')}</span>
                )}
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => pickFolder.mutate()}
                disabled={pickFolder.isPending || create.isPending}
                className="shrink-0"
              >
                {pickFolder.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                {pickFolder.isPending ? t('createProject.selectingFolder') : t('createProject.selectFolder')}
              </Button>
            </div>
          </div>
          <div>
            <Label>{t('createProject.projectDescription')}</Label>
            <Textarea
              placeholder={t('createProject.projectDescriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !path.trim()}>
              {create.isPending ? t('createProject.adding') : t('createProject.submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
