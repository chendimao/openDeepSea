import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MessageCircleQuestion, Plus, Save, Search, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { AgentConversationBuilder } from '../components/AgentConversationBuilder';
import { Button } from '../components/ui/Button';
import { Input, Label, Textarea } from '../components/ui/Input';
import { api } from '../lib/api';
import type { AcpBackend, AcpPermissionMode, Agent, AgentInput, AgentReference } from '../lib/types';
import { cn } from '../lib/utils';

const EMPTY_FORM: AgentInput = {
  agent_id: '',
  name: '',
  description: '',
  preferred_user_name: '',
  personality: '',
  responsibilities: '',
  rules: '',
  default_acp_backend: 'codex',
  default_acp_permission_mode: 'bypass',
};

export function AgentsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<AgentInput>(EMPTY_FORM);
  const [mode, setMode] = useState<'edit' | 'conversation'>('edit');
  const [deleteReferences, setDeleteReferences] = useState<AgentReference[] | null>(null);
  const queryClient = useQueryClient();
  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
  });
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.agent_id} ${agent.description ?? ''}`.toLowerCase().includes(needle),
    );
  }, [agents, query]);

  useEffect(() => {
    if (selectedAgent) {
      setForm(agentToForm(selectedAgent));
      setIsCreatingNew(false);
      return;
    }
    if (agents.length > 0 && !selectedId && !isCreatingNew && mode === 'edit') {
      setSelectedId(agents[0].id);
      return;
    }
    if (agents.length === 0 && selectedId) setSelectedId(null);
  }, [agents, isCreatingNew, mode, selectedAgent, selectedId]);

  const create = useMutation({
    mutationFn: (input: AgentInput) => api.createAgent(cleanAgentInput(input)),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setSelectedId(agent.id);
      setIsCreatingNew(false);
      setMode('edit');
      toast.success('智能体已创建');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const update = useMutation({
    mutationFn: (input: AgentInput) => {
      if (!selectedId) throw new Error('missing agent');
      return api.updateAgent(selectedId, cleanAgentInput(input));
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setSelectedId(agent.id);
      setIsCreatingNew(false);
      toast.success('智能体已保存');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (agent: Agent) => {
      try {
        await api.deleteAgent(agent.id);
        return null;
      } catch (error) {
        const message = (error as Error).message;
        const refs = extractReferencesFromError(message);
        if (refs) return refs;
        throw error;
      }
    },
    onSuccess: (refs) => {
      if (refs) {
        setDeleteReferences(refs);
        toast.error('该智能体正在被聊天室使用');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setSelectedId(null);
      setForm(EMPTY_FORM);
      toast.success('智能体已删除');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const isNew = !selectedAgent;

  return (
    <div className="agents-page">
      <header className="agents-header">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.8} />
            <h1 className="font-display text-[22px] font-semibold tracking-tight">智能体</h1>
          </div>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-muted)]">
            管理全局智能体库。聊天室可以从这里拉入智能体，并保留聊天室级会话与权限配置。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setMode('conversation');
              setSelectedId(null);
              setIsCreatingNew(false);
              setForm(EMPTY_FORM);
              setDeleteReferences(null);
            }}
          >
            <MessageCircleQuestion className="h-3.5 w-3.5" />
            对话创建
          </Button>
          <Button
            onClick={() => {
              setMode('edit');
              setSelectedId(null);
              setIsCreatingNew(true);
              setForm(EMPTY_FORM);
              setDeleteReferences(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            新建智能体
          </Button>
        </div>
      </header>

      <div className="agents-layout">
        <aside className="agents-list">
          <div className="px-3 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、ID 或简介"
                className="pl-8"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {isLoading ? (
              <div className="px-3 py-5 text-[12px] text-[var(--color-fg-muted)]">加载中...</div>
            ) : filteredAgents.length === 0 ? (
              <div className="px-3 py-5 text-[12px] text-[var(--color-fg-muted)]">暂无智能体</div>
            ) : (
              filteredAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(agent.id);
                    setIsCreatingNew(false);
                    setMode('edit');
                    setDeleteReferences(null);
                  }}
                  className={cn('agent-list-item', selectedId === agent.id && mode === 'edit' && 'is-active')}
                >
                  <span className="agent-list-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{agent.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--color-fg-muted)]">
                      {agent.agent_id}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--color-muted)]">
                    <Users className="h-3 w-3" />
                    {agent.reference_count}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="agents-editor">
          {mode === 'conversation' ? (
            <AgentConversationBuilder
              onDraft={(draft) => {
                setForm(draft);
                setMode('edit');
                setSelectedId(null);
                setIsCreatingNew(true);
              }}
            />
          ) : (
            <AgentEditor
              form={form}
              selectedAgent={selectedAgent}
              isNew={isNew}
              isSaving={create.isPending || update.isPending}
              isDeleting={remove.isPending}
              deleteReferences={deleteReferences}
              onChange={setForm}
              onSave={() => {
                setDeleteReferences(null);
                if (isNew) create.mutate(form);
                else update.mutate(form);
              }}
              onDelete={() => {
                if (selectedAgent) remove.mutate(selectedAgent);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function AgentEditor({
  form,
  selectedAgent,
  isNew,
  isSaving,
  isDeleting,
  deleteReferences,
  onChange,
  onSave,
  onDelete,
}: {
  form: AgentInput;
  selectedAgent: Agent | null;
  isNew: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  deleteReferences: AgentReference[] | null;
  onChange: (form: AgentInput) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const canSave = form.agent_id.trim().length > 0 && form.name.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="agent-editor-avatar">{(form.name || '智').slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[17px] font-semibold">
              {isNew ? '新建智能体' : form.name || selectedAgent?.name}
            </h2>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-fg-muted)]">
              {isNew ? '创建后可被任意聊天室拉入' : selectedAgent?.agent_id}
            </p>
          </div>
          <div className="flex gap-2">
            {!isNew && (
              <Button variant="danger" onClick={onDelete} disabled={isDeleting}>
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            )}
            <Button onClick={onSave} disabled={!canSave || isSaving}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? '保存中...' : isNew ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {deleteReferences && (
          <div className="mb-4 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-3 text-[12.5px] text-[var(--color-fg)]">
            <div className="font-medium text-[var(--color-danger)]">该智能体正在被聊天室使用，不能直接删除。</div>
            <div className="mt-2 space-y-1">
              {deleteReferences.map((ref) => (
                <div key={ref.room_id} className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {ref.room_name} · {ref.room_id}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Field label="智能体名称">
            <Input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Agent ID">
            <Input
              value={form.agent_id}
              className="font-mono"
              onChange={(event) => onChange({ ...form, agent_id: event.target.value })}
            />
          </Field>
          <Field label="称呼用户为什么">
            <Input
              value={form.preferred_user_name ?? ''}
              onChange={(event) => onChange({ ...form, preferred_user_name: event.target.value })}
            />
          </Field>
          <Field label="默认 ACP 后端">
            <select
              value={form.default_acp_backend ?? ''}
              onChange={(event) => onChange({ ...form, default_acp_backend: (event.target.value || null) as AcpBackend | null })}
              className="surface-1 h-10 w-full rounded-md px-3 font-mono text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
            >
              <option value="">不默认启用</option>
              <option value="codex">Codex</option>
              <option value="claudecode">Claude Code</option>
              <option value="opencode">OpenCode</option>
            </select>
          </Field>
          <Field label="默认权限">
            <select
              value={form.default_acp_permission_mode ?? 'bypass'}
              onChange={(event) => onChange({ ...form, default_acp_permission_mode: event.target.value as AcpPermissionMode })}
              className="surface-1 h-10 w-full rounded-md px-3 font-mono text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
            >
              <option value="bypass">bypass</option>
              <option value="workspace-write">workspace-write</option>
              <option value="read-only">read-only</option>
            </select>
          </Field>
          <Field label="简介">
            <Input
              value={form.description ?? ''}
              onChange={(event) => onChange({ ...form, description: event.target.value })}
            />
          </Field>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Field label="性格">
            <Textarea
              value={form.personality ?? ''}
              className="min-h-[150px]"
              onChange={(event) => onChange({ ...form, personality: event.target.value })}
            />
          </Field>
          <Field label="主要工作">
            <Textarea
              value={form.responsibilities ?? ''}
              className="min-h-[150px]"
              onChange={(event) => onChange({ ...form, responsibilities: event.target.value })}
            />
          </Field>
          <Field label="行为规则">
            <Textarea
              value={form.rules ?? ''}
              className="min-h-[150px]"
              onChange={(event) => onChange({ ...form, rules: event.target.value })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function agentToForm(agent: Agent): AgentInput {
  return {
    agent_id: agent.agent_id,
    name: agent.name,
    description: agent.description ?? '',
    preferred_user_name: agent.preferred_user_name ?? '',
    personality: agent.personality ?? '',
    responsibilities: agent.responsibilities ?? '',
    rules: agent.rules ?? '',
    default_acp_backend: agent.default_acp_backend,
    default_acp_permission_mode: agent.default_acp_permission_mode,
  };
}

function cleanAgentInput(input: AgentInput): AgentInput {
  return {
    agent_id: input.agent_id.trim(),
    name: input.name.trim(),
    description: normalizeOptional(input.description),
    preferred_user_name: normalizeOptional(input.preferred_user_name),
    personality: normalizeOptional(input.personality),
    responsibilities: normalizeOptional(input.responsibilities),
    rules: normalizeOptional(input.rules),
    default_acp_backend: input.default_acp_backend || null,
    default_acp_permission_mode: input.default_acp_permission_mode || 'bypass',
  };
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function extractReferencesFromError(message: string): AgentReference[] | null {
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as { references?: AgentReference[] };
    return Array.isArray(parsed.references) ? parsed.references : null;
  } catch {
    return null;
  }
}
