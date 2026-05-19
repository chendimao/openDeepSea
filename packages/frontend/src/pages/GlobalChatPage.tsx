import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Database, MessageCircle, MessagesSquare, Plus, Save, Send, Settings2, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { GlobalChatMessage, GlobalChatSession } from '../lib/types';
import { Button } from '../components/ui/Button';
import { MessageContent } from '../components/MessageContent';
import { cn } from '../lib/utils';

export function GlobalChatPage(): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: sessions = [] } = useQuery({
    queryKey: ['global-chat-sessions'],
    queryFn: api.listGlobalChatSessions,
  });
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  );
  const sessionId = activeSession?.id ?? '';
  const { data: messages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ['global-chat-messages', sessionId],
    queryFn: () => api.listGlobalChatMessages(sessionId),
    enabled: !!sessionId,
  });

  useEffect(() => {
    if (!activeSessionId && sessions[0]) setActiveSessionId(sessions[0].id);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, sessionId]);

  const createSession = useMutation({
    mutationFn: () => api.createGlobalChatSession({ title: t('globalChat.newSession') }),
    onSuccess: (session) => {
      queryClient.setQueryData<GlobalChatSession[]>(['global-chat-sessions'], (prev) => [session, ...(prev ?? [])]);
      setActiveSessionId(session.id);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteGlobalChatSession(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<GlobalChatSession[]>(['global-chat-sessions'], (prev) =>
        (prev ?? []).filter((session) => session.id !== id),
      );
      queryClient.removeQueries({ queryKey: ['global-chat-messages', id] });
      if (activeSessionId === id) setActiveSessionId('');
      setMobileSessionsOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      const session = activeSession ?? await api.createGlobalChatSession({ title: content.slice(0, 40) });
      if (!activeSession) {
        queryClient.setQueryData<GlobalChatSession[]>(['global-chat-sessions'], (prev) => [session, ...(prev ?? [])]);
        setActiveSessionId(session.id);
      }
      return api.sendGlobalChatMessage(session.id, { content });
    },
    onSuccess: (result) => {
      const nextSessionId = result.userMessage.session_id;
      queryClient.invalidateQueries({ queryKey: ['global-chat-sessions'] });
      queryClient.setQueryData<GlobalChatMessage[]>(['global-chat-messages', nextSessionId], (prev) =>
        upsertGlobalChatMessages(prev, [result.userMessage, result.assistantMessage]),
      );
      setActiveSessionId(nextSessionId);
      setDraft('');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendMessage.isPending) return;
    sendMessage.mutate(content);
  };

  return (
    <div className="flex h-full min-h-0 bg-[var(--color-bg)]">
      <aside className="hidden w-[280px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)]/72 p-4 lg:flex lg:flex-col">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-[16px] font-semibold">{t('globalChat.title')}</h2>
            <p className="mt-1 text-[11.5px] text-[var(--color-fg-muted)]">{t('globalChat.description')}</p>
          </div>
          <button
            type="button"
            onClick={() => createSession.mutate()}
            className="sidebar-icon-button"
            aria-label={t('globalChat.newSession')}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-5 min-h-0 flex-1 space-y-1.5 overflow-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group flex w-full items-start gap-2 rounded-md px-3 py-2 text-left ease-ocean transition-all',
                session.id === sessionId
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)] glow-primary'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)]',
              )}
            >
              <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <button
                type="button"
                onClick={() => setActiveSessionId(session.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-[12.5px] font-medium">{session.title}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-[var(--color-muted)]">
                  {formatRelativeTime(session.updated_at)}
                </span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteSession.mutate(session.id);
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                aria-label="delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
              {t('globalChat.noSessions')}
            </div>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.8} />
                <h1 className="truncate font-display text-[22px] font-semibold tracking-tight">
                  {activeSession?.title ?? t('globalChat.title')}
                </h1>
              </div>
              <p className="mt-1 text-[12.5px] text-[var(--color-fg-muted)]">{t('globalChat.description')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                className="px-2 sm:px-3 lg:hidden"
                onClick={() => setMobileSessionsOpen((open) => !open)}
              >
                <MessagesSquare className="h-4 w-4" />
                <span className="hidden sm:inline">{t('globalChat.sessions')}</span>
              </Button>
              <Button type="button" variant="secondary" className="px-2 sm:px-3" onClick={() => createSession.mutate()}>
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('globalChat.newSession')}</span>
              </Button>
            </div>
          </div>
          {mobileSessionsOpen && (
            <div className="mt-3 max-h-[34vh] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 lg:hidden">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-2',
                    session.id === sessionId ? 'bg-[var(--color-surface-raised)]' : 'hover:bg-[var(--color-surface-raised)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setMobileSessionsOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-[12.5px] font-medium">{session.title}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-[var(--color-muted)]">
                      {formatRelativeTime(session.updated_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSession.mutate(session.id)}
                    className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    aria-label="delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-5 text-center text-[12px] text-[var(--color-fg-muted)]">
                  {t('globalChat.noSessions')}
                </div>
              )}
            </div>
          )}
        </header>

        <section className="min-h-0 flex-1 overflow-auto px-5 py-5">
          <div className="mx-auto flex max-w-4xl flex-col gap-3">
            {messages.length === 0 && !messagesLoading ? (
              <div className="flex min-h-[48vh] flex-col items-center justify-center text-center">
                <div className="liquid-logo-small mb-4">
                  <MessageCircle className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <h2 className="font-display text-[20px] font-semibold">{t('globalChat.emptyTitle')}</h2>
                <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
                  {t('globalChat.emptyDescription')}
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <GlobalChatBubble key={message.id} message={message} />
              ))
            )}
            {sendMessage.isPending && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                <Bot className="h-4 w-4 animate-pulse" />
                {t('common.loading')}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </section>

        <form onSubmit={submit} className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]/76 px-5 py-4">
          <div className="mx-auto flex max-w-4xl items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('globalChat.inputPlaceholder')}
              rows={2}
              className="min-h-[52px] flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none transition focus:border-[var(--color-primary)]"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event);
              }}
            />
            <Button type="submit" disabled={!draft.trim() || sendMessage.isPending}>
              <Send className="h-4 w-4" />
              {t('globalChat.send')}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function GlobalChatBubble({ message }: { message: GlobalChatMessage }): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const isUser = message.role === 'user';
  const refs = message.metadata.memory_refs ?? [];
  const configRefs = message.metadata.config_refs ?? [];
  const saveMemory = useMutation({
    mutationFn: () => api.saveGlobalChatMessageAsMemory(message.id, {
      memory_type: 'fact',
      title: message.content.slice(0, 80) || t('globalChat.savedMemory'),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['global-chat-messages', message.session_id] });
      toast.success(t('globalChat.savedMemory'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <article className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
        isUser ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface-raised)] text-[var(--color-primary)]',
      )}>
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn('max-w-[min(760px,82%)]', isUser && 'text-right')}>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
          <span>{isUser ? t('room.currentUser') : t('globalChat.title')}</span>
          <span>{formatRelativeTime(message.created_at)}</span>
        </div>
        <div className={cn(
          'rounded-md border px-3 py-2 text-left shadow-sm',
          isUser
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
            : 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg)]',
          message.status === 'failed' && 'border-red-300',
        )}>
          {isUser ? (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{message.content}</div>
          ) : (
            <MessageContent content={message.content} />
          )}
        </div>
        {!isUser && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => saveMemory.mutate()}
              disabled={saveMemory.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)]"
            >
              <Save className="h-3.5 w-3.5" />
              {t('globalChat.saveMemory')}
            </button>
            {(refs.length > 0 || configRefs.length > 0) && (
              <details className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)]">
                <summary className="cursor-pointer">{t('globalChat.references')}</summary>
                <div className="mt-2 space-y-1">
                  {refs.map((ref) => (
                    <div key={ref.id} className="flex items-center gap-1">
                      <Database className="h-3 w-3" />
                      <span>{ref.title}</span>
                    </div>
                  ))}
                  {configRefs.map((ref) => (
                    <div key={ref} className="flex items-center gap-1">
                      <Settings2 className="h-3 w-3" />
                      <span>{t('globalChat.configReference')}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function upsertGlobalChatMessages(
  prev: GlobalChatMessage[] | undefined,
  messages: GlobalChatMessage[],
): GlobalChatMessage[] {
  const byId = new Map((prev ?? []).map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  return Array.from(byId.values()).sort((a, b) => a.created_at - b.created_at);
}
