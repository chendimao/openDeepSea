import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Hash, MessageSquarePlus, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent, DialogTrigger } from '../components/ui/Dialog';
import { Input, Label, Textarea } from '../components/ui/Input';
import { useI18n } from '../lib/i18n';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { ProjectSettingsDialog } from '../components/SettingsDialogs';
import type { Room } from '../lib/types';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { t } = useI18n();
  const [roomQuery, setRoomQuery] = useState('');
  const [debouncedRoomQuery, setDebouncedRoomQuery] = useState('');
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
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedRoomQuery(roomQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [roomQuery]);

  const hasRoomSearch = debouncedRoomQuery.length > 0;
  const { data: roomSearch, isFetching: isRoomSearchFetching } = useQuery({
    queryKey: ['rooms', 'search', projectId, debouncedRoomQuery],
    queryFn: () => api.searchRooms(projectId, { query: debouncedRoomQuery }),
    enabled: !!projectId && hasRoomSearch,
  });
  const visibleRooms = useMemo(
    () => hasRoomSearch ? roomSearch?.results.map((result) => result.room) ?? [] : rooms,
    [hasRoomSearch, roomSearch, rooms],
  );
  const roomSearchStatus = hasRoomSearch
    ? isRoomSearchFetching
      ? t('project.roomSearchLoading')
      : roomSearch?.degraded
        ? t('project.roomSearchFallback')
        : null
    : null;

  if (!project) return <div className="p-8 text-[var(--color-fg-muted)]">{t('project.loading')}</div>;

  return (
    <div className="h-full overflow-y-auto">
      <header className="px-4 sm:px-8 pt-8 pb-5 border-b border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/"
              className="inline-grid h-8 w-8 place-items-center rounded-lg text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:glow-primary"
              aria-label={t('project.backToProjects')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <h1 className="min-w-0 font-display text-[22px] font-semibold tracking-tight">{project.name}</h1>
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
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="font-display text-[14px] font-medium">{t('project.rooms')}</h2>
            <span className="text-[12px] font-mono text-[var(--color-fg-muted)]">
              {hasRoomSearch ? `${visibleRooms.length} / ${rooms.length}` : rooms.length}
            </span>
            <div className="relative ml-auto w-full sm:w-[320px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" />
              <Input
                value={roomQuery}
                onChange={(event) => setRoomQuery(event.target.value)}
                placeholder={t('project.roomSearchPlaceholder')}
                className="pl-9 pr-9"
                aria-label={t('project.roomSearchPlaceholder')}
              />
              {roomQuery.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => setRoomQuery('')}
                  className="absolute right-2 top-1/2 inline-grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:glow-primary"
                  aria-label={t('common.clear')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="max-sm:w-full">
              <CreateRoomDialog projectId={projectId} />
            </div>
          </div>
          {roomSearchStatus && (
            <div className="mb-3 text-[11px] text-[var(--color-fg-muted)]">
              {roomSearchStatus}
            </div>
          )}

          {rooms.length === 0 && !hasRoomSearch ? (
            <WorkspaceEmptyState
              icon={<MessageSquarePlus className="h-9 w-9" strokeWidth={1.75} />}
              title={t('project.emptyRoomsTitle')}
              description={t('project.emptyRoomsDescription')}
              action={<CreateRoomDialog projectId={projectId} buttonText={t('project.createFirstRoom')} buttonIcon="message" />}
            />
          ) : hasRoomSearch && !isRoomSearchFetching && visibleRooms.length === 0 ? (
            <WorkspaceEmptyState
              icon={<Search className="h-9 w-9" strokeWidth={1.75} />}
              title={t('project.noRoomMatchesTitle')}
              description={t('project.noRoomMatchesDescription')}
              action={
                <Button variant="secondary" onClick={() => setRoomQuery('')}>
                  <X className="h-4 w-4" /> {t('common.clearSearch')}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {visibleRooms.map((r) => (
                <RoomItem key={r.id} projectId={projectId} room={r} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RoomItem({ projectId, room }: { projectId: string; room: Room }) {
  const queryClient = useQueryClient();
  const { t, formatRelativeTime } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteRoom(room.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['rooms', 'search', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success(t('project.roomDeleted'));
      setConfirmOpen(false);
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
        onClick={() => setConfirmOpen(true)}
        className="absolute right-2 top-2 p-1.5 rounded-md text-[var(--color-muted)] opacity-70 hover:opacity-100 hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-raised)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:glow-primary ease-ocean"
        aria-label={t('project.deleteRoom')}
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent title={t('project.deleteRoom')} description={t('project.deleteRoomConfirm', { name: room.name })}>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>
              {del.isPending ? t('common.deleting') : t('common.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
    mutationFn: () => api.createRoom(projectId, {
      name,
      description: description || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['rooms', 'search', projectId] });
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
