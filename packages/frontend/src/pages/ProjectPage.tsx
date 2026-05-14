import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, MessageSquarePlus, Plus, Settings2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent, DialogTrigger } from '../components/ui/Dialog';
import { Input, Label, Textarea } from '../components/ui/Input';
import { useI18n } from '../lib/i18n';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { ProjectSettingsDialog } from '../components/SettingsDialogs';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { t } = useI18n();
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', projectId],
    queryFn: () => api.listRooms(projectId),
    enabled: !!projectId,
  });

  if (!project) return <div className="p-8 text-[var(--color-fg-muted)]">{t('project.loading')}</div>;

  return (
    <div className="h-full overflow-y-auto">
      <header className="px-4 sm:px-8 pt-8 pb-5 border-b border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[22px] font-semibold tracking-tight">{project.name}</h1>
            <span className="min-w-0 truncate text-[12px] font-mono text-[var(--color-muted)]">
              {project.path}
            </span>
            <div className="ml-auto">
              <ProjectSettingsDialog project={project}>
                <Button variant="secondary" size="sm" aria-label={t('project.settings')}>
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('project.settings')}
                </Button>
              </ProjectSettingsDialog>
            </div>
          </div>
          {project.description && (
            <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">{project.description}</p>
          )}
          <div className="mt-4 flex items-center gap-5 text-[12px] font-mono text-[var(--color-fg-muted)]">
            <span>{t('project.stats.rooms', { count: project.stats?.rooms ?? 0 })}</span>
            <span>{t('project.stats.tasks', { count: project.stats?.tasks ?? 0 })}</span>
            <span>{t('project.stats.done', { count: project.stats?.tasksDone ?? 0 })}</span>
            <span>{t('project.stats.inProgress', { count: project.stats?.tasksInProgress ?? 0 })}</span>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-baseline gap-3 mb-4">
            <h2 className="font-display text-[14px] font-medium">{t('project.rooms')}</h2>
            <span className="text-[12px] font-mono text-[var(--color-fg-muted)]">{rooms.length}</span>
            <div className="ml-auto">
              <CreateRoomDialog projectId={projectId} />
            </div>
          </div>

          {rooms.length === 0 ? (
            <WorkspaceEmptyState
              icon={<MessageSquarePlus className="h-9 w-9" strokeWidth={1.75} />}
              title={t('project.emptyRoomsTitle')}
              description={t('project.emptyRoomsDescription')}
              action={<CreateRoomDialog projectId={projectId} buttonText={t('project.createFirstRoom')} buttonIcon="message" />}
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {rooms.map((r) => (
                <RoomItem key={r.id} projectId={projectId} room={r} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RoomItem({ projectId, room }: { projectId: string; room: { id: string; name: string; description: string | null; created_at: number } }) {
  const queryClient = useQueryClient();
  const { t, formatRelativeTime } = useI18n();
  const del = useMutation({
    mutationFn: () => api.deleteRoom(room.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success(t('project.roomDeleted'));
    },
  });

  return (
    <div className="group surface-1 rounded-lg p-4 hover:border-[var(--color-accent)] ease-ocean transition-all relative">
      <Link to={`/projects/${projectId}/rooms/${room.id}`} className="block">
        <div className="flex items-center gap-2 mb-1 pr-8">
          <Hash className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={2} />
          <h3 className="font-display text-[14px] font-semibold truncate">{room.name}</h3>
        </div>
        {room.description && (
          <p className="text-[12px] text-[var(--color-fg-muted)] line-clamp-1 mt-1">{room.description}</p>
        )}
        <p className="text-[11px] font-mono text-[var(--color-muted)] mt-3">{formatRelativeTime(room.created_at)}</p>
      </Link>
      <button
        onClick={() => del.mutate()}
        className="absolute right-2 top-2 p-1.5 rounded-md text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-raised)] ease-ocean"
        aria-label={t('project.deleteRoom')}
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CreateRoomDialog({
  projectId,
  buttonText,
  buttonIcon = 'plus',
}: {
  projectId: string;
  buttonText?: string;
  buttonIcon?: 'plus' | 'message';
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const resolvedButtonText = buttonText ?? t('project.newRoom');

  const create = useMutation({
    mutationFn: () => api.createRoom(projectId, { name, description: description || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success(t('project.roomCreated'));
      setOpen(false);
      setName('');
      setDescription('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          {buttonIcon === 'plus' ? <Plus className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
          {resolvedButtonText}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('project.newRoom')} description={t('project.newRoomDescription')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <Label>{t('project.roomName')}</Label>
            <Input
              autoFocus
              placeholder={t('project.roomNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>{t('project.roomDescription')}</Label>
            <Textarea
              placeholder={t('project.roomDescriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? t('project.creating') : t('common.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
