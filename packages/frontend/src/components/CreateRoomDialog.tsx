import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label, Textarea } from './ui/Input';

export function CreateRoomDialog({
  projectId,
  buttonText,
  buttonIcon = 'plus',
  onCreated,
}: {
  projectId: string;
  buttonText?: string;
  buttonIcon?: 'plus' | 'message';
  onCreated?: (roomId: string) => void;
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
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['rooms', 'search', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success(t('project.roomCreated'));
      setOpen(false);
      setName('');
      setDescription('');
      onCreated?.(room.id);
    },
    onError: (err) => toast.error((err as Error).message),
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
          onSubmit={(event) => {
            event.preventDefault();
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
              onChange={(event) => setName(event.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>{t('project.roomDescription')}</Label>
            <Textarea
              placeholder={t('project.roomDescriptionPlaceholder')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
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
