import { useMemo, useState } from 'react';
import { Bot, Check, Send, Sparkles } from 'lucide-react';
import type { AcpBackend, AgentInput } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Input, Label, Textarea } from './ui/Input';

const STEPS = [
  { id: 'preferred_user_name', question: '我应该怎么称呼你？', placeholder: '例如：陈工 / 老板 / Alex' },
  { id: 'name', question: '这个智能体叫什么？', placeholder: '例如：前端执行官' },
  { id: 'personality', question: '它是什么性格？', placeholder: '例如：严谨、直接、会主动指出风险' },
  { id: 'responsibilities', question: '它主要做哪些工作？', placeholder: '例如：前端实现、交互修复、UI 验收' },
  { id: 'rules', question: '它有哪些必须遵守的规则？', placeholder: '例如：完成前必须运行构建验证' },
  { id: 'default_acp_backend', question: '默认使用哪个 ACP 后端？', placeholder: 'codex / claudecode / opencode' },
] as const;

type StepId = (typeof STEPS)[number]['id'];
type Answers = Partial<Record<StepId, string>>;

const ACP_BACKENDS: AcpBackend[] = ['codex', 'claudecode', 'opencode'];

export function AgentConversationBuilder({
  onDraft,
}: {
  onDraft: (draft: AgentInput) => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [value, setValue] = useState('');
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const step = STEPS[currentStep];
  const conversation = useMemo(() => buildConversation(answers, currentStep), [answers, currentStep]);

  function submitAnswer() {
    if (!step || !value.trim()) return;
    const nextAnswers = { ...answers, [step.id]: value.trim() };
    setAnswers(nextAnswers);
    setValue('');
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((index) => index + 1);
      return;
    }
    setDraft(buildDraft(nextAnswers));
  }

  function reset() {
    setAnswers({});
    setCurrentStep(0);
    setValue('');
    setDraft(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--color-primary)]" strokeWidth={1.8} />
          <div>
            <h2 className="font-display text-[14px] font-semibold">对话创建智能体</h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--color-fg-muted)]">回答 6 个问题，生成可编辑草稿。</p>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {conversation.map((item, index) => (
          <div
            key={`${item.role}-${index}`}
            className={cn(
              'rounded-lg px-3 py-2 text-[12.5px] leading-relaxed',
              item.role === 'assistant'
                ? 'surface-1 text-[var(--color-fg)]'
                : 'ml-8 bg-[var(--color-primary)] text-[var(--color-primary-fg)]',
            )}
          >
            {item.role === 'assistant' && (
              <Bot className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-[var(--color-primary)]" strokeWidth={1.8} />
            )}
            {item.text}
          </div>
        ))}

        {draft && (
          <div className="surface-1 rounded-lg p-3">
            <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
              已生成草稿
            </div>
            <DraftPreview draft={draft} onChange={setDraft} />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset}>重新回答</Button>
              <Button size="sm" onClick={() => onDraft(draft)}>填入表单</Button>
            </div>
          </div>
        )}
      </div>

      {!draft && step && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--color-fg-muted)]">
            <span>问题 {currentStep + 1} / {STEPS.length}</span>
            <span>{step.id}</span>
          </div>
          <div className="flex gap-2">
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitAnswer();
                }
              }}
              placeholder={step.placeholder}
            />
            <Button onClick={submitAnswer} disabled={!value.trim()} aria-label="提交回答">
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DraftPreview({
  draft,
  onChange,
}: {
  draft: AgentInput;
  onChange: (draft: AgentInput) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>名称</Label>
          <Input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </div>
        <div>
          <Label>Agent ID</Label>
          <Input
            value={draft.agent_id}
            className="font-mono"
            onChange={(event) => onChange({ ...draft, agent_id: event.target.value })}
          />
        </div>
      </div>
      <div>
        <Label>性格</Label>
        <Textarea
          value={draft.personality ?? ''}
          onChange={(event) => onChange({ ...draft, personality: event.target.value })}
        />
      </div>
      <div>
        <Label>规则</Label>
        <Textarea
          value={draft.rules ?? ''}
          onChange={(event) => onChange({ ...draft, rules: event.target.value })}
        />
      </div>
    </div>
  );
}

function buildConversation(answers: Answers, currentStep: number): Array<{ role: 'assistant' | 'user'; text: string }> {
  const items: Array<{ role: 'assistant' | 'user'; text: string }> = [];
  for (let index = 0; index <= currentStep && index < STEPS.length; index += 1) {
    const step = STEPS[index];
    items.push({ role: 'assistant', text: step.question });
    const answer = answers[step.id];
    if (answer) items.push({ role: 'user', text: answer });
  }
  return items;
}

function buildDraft(answers: Answers): AgentInput {
  const name = answers.name?.trim() || '新智能体';
  const backend = normalizeBackend(answers.default_acp_backend);
  return {
    agent_id: slugifyAgentId(name),
    name,
    description: answers.responsibilities ?? null,
    preferred_user_name: answers.preferred_user_name ?? null,
    personality: answers.personality ?? null,
    responsibilities: answers.responsibilities ?? null,
    rules: answers.rules ?? null,
    default_acp_backend: backend,
    default_acp_permission_mode: 'bypass',
  };
}

function normalizeBackend(value: string | undefined): AcpBackend {
  const normalized = value?.trim().toLowerCase();
  return ACP_BACKENDS.includes(normalized as AcpBackend) ? (normalized as AcpBackend) : 'codex';
}

function slugifyAgentId(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 48);
  return `agent-${Date.now().toString(36)}`;
}
