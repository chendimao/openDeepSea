import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { AgentTimeline, AgentTimelineItem } from './AgentTimeline';
import { useI18n } from '../lib/i18n';
import type { Agent, MessageTrace, RoomAgent } from '../lib/types';
import { buildAgentTranscript, type AgentTranscriptModel } from './agent-timeline/transcript';

type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const fencePattern = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;

const jsonFieldLabels: Record<string, string> = {
  task_readiness: '任务准备状态',
  planner_decision: '规划决策',
  mode: '模式',
  status: '状态',
  summary: '摘要',
  next_steps: '下一步',
  agent_id: '智能体',
  goal: '目标',
  awaiting_user_confirmation: '等待确认',
  ready: '是否就绪',
  confidence: '置信度',
  title: '标题',
  description: '描述',
  missing_questions: '缺失问题',
  recommended_mode: '推荐模式',
  execution_intent: '执行意图',
};

const jsonValueLabels: Record<string, string> = {
  formal_workflow: '正式工作流',
  pause_after_suggestion: '建议后暂停',
  auto_continue: '自动继续',
  suggested: '已建议',
  dispatching: '派发中',
  completed: '已完成',
  blocked: '已阻塞',
  lightweight_collaboration: '轻量协作',
  analysis_only: '仅分析',
  implementation: '实现',
  planning: '规划',
  discussion: '讨论',
};

function parseMessage(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  fencePattern.lastIndex = 0;
  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    parts.push({
      type: 'code',
      language: normalizeFenceLanguage(match[1]),
      value: match[2] ?? '',
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: content }];
}

function normalizeFenceLanguage(rawLanguage: string | undefined): string {
  return rawLanguage?.trim().split(/\s+/)[0] || 'text';
}

export function MessageContent({
  content,
  streaming = false,
  mode,
  trace,
  roomAgents = [],
  globalAgents = [],
  suppressPlannerDecisionSummary = false,
}: {
  content: string;
  streaming?: boolean;
  mode?: 'preview' | 'source';
  trace?: MessageTrace;
  roomAgents?: RoomAgent[];
  globalAgents?: Agent[];
  suppressPlannerDecisionSummary?: boolean;
}): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const { t } = useI18n();
  const agentNameById = useMemo(() => buildAgentNameMap(roomAgents, globalAgents), [globalAgents, roomAgents]);
  const parts = parseMessage(content);
  const markdown = streaming ? isStableStreamingMarkdownContent(content) : isMarkdownContent(content);
  const activeMode = mode ?? 'preview';
  const lastTextPartIndex = findLastTextPartIndex(parts);
  const hasFinalContent = content.trim().length > 0 && content.trim() !== '…';
  const transcript = activeMode !== 'source' && !hasFinalContent ? buildAgentTranscript(trace, content) : null;

  const copyCode = async (code: string, index: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1200);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className="message-content">
      {transcript ? (
        <AgentTranscriptView
          transcript={transcript}
          streaming={streaming}
          agentNameById={agentNameById}
          suppressPlannerDecisionSummary={suppressPlannerDecisionSummary}
        />
      ) : (
        <>
          <div>
            {markdown && activeMode === 'preview' ? (
              <MarkdownPreview
                content={content}
                streaming={streaming}
                agentNameById={agentNameById}
                suppressPlannerDecisionSummary={suppressPlannerDecisionSummary}
              />
            ) : (
              <>
                {parts.map((part, index) => {
                  if (part.type === 'text') {
                    if (!part.value) return null;
                    return (
                      <span key={`text-${index}`} className="whitespace-pre-wrap break-words">
                        {renderAgentNamesInText(part.value, agentNameById)}
                        {streaming && index === lastTextPartIndex && <StreamingCursor />}
                      </span>
                    );
                  }

                  const copied = copiedIndex === index;
                  return (
                    <CodeBlock
                      key={`code-${index}`}
                      language={part.language}
                      value={part.value}
                      copied={copied}
                      onCopy={() => void copyCode(part.value, index)}
                      copyLabel={t('message.copy')}
                      copiedLabel={t('message.copied')}
                    />
                  );
                })}
                {streaming && lastTextPartIndex === -1 && <StreamingCursor />}
              </>
            )}
          </div>
          {!hasFinalContent && <AgentTimeline trace={trace} />}
        </>
      )}
    </div>
  );
}

function AgentTranscriptView({
  transcript,
  streaming,
  agentNameById,
  suppressPlannerDecisionSummary = false,
}: {
  transcript: AgentTranscriptModel;
  streaming: boolean;
  agentNameById?: Map<string, string>;
  suppressPlannerDecisionSummary?: boolean;
}): JSX.Element {
  return (
    <div className="agent-transcript">
      {transcript.items.map((item, index) => (
        item.type === 'text' ? (
          <div key={item.id} className="agent-transcript-text">
            <MarkdownPreview
              content={item.text}
              streaming={streaming && index === transcript.items.length - 1}
              agentNameById={agentNameById}
              suppressPlannerDecisionSummary={suppressPlannerDecisionSummary}
            />
          </div>
        ) : (
          <div key={item.id} className="agent-transcript-event">
            <AgentTimelineItem event={item.event} />
          </div>
        )
      ))}
    </div>
  );
}

export function isMarkdownMessageContent(content: string): boolean {
  return isMarkdownContent(content);
}

function findLastTextPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].type === 'text' && parts[index].value.length > 0) return index;
  }
  return -1;
}

function isMarkdownContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (fencePattern.test(trimmed)) {
    fencePattern.lastIndex = 0;
    return true;
  }
  fencePattern.lastIndex = 0;
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}[-*+]\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}\d+\.\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}>\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}---+\s*$/.test(trimmed)
    || /\[[^\]]+\]\([^)]+\)/.test(trimmed)
    || /`[^`\n]+`/.test(trimmed)
    || /\*\*[^*\n]+\*\*/.test(trimmed);
}

function isStableStreamingMarkdownContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (fencePattern.test(trimmed)) {
    fencePattern.lastIndex = 0;
    return true;
  }
  fencePattern.lastIndex = 0;
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}[-*+]\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}\d+\.\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}>\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}---+\s*$/.test(trimmed)
    || /\[[^\]]+\]\([^)]+\)/.test(trimmed);
}

export function MarkdownPreview({
  content,
  streaming = false,
  agentNameById,
  suppressPlannerDecisionSummary = false,
}: {
  content: string;
  streaming?: boolean;
  agentNameById?: Map<string, string>;
  suppressPlannerDecisionSummary?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const parts = parseMessage(content);
  const lastTextPartIndex = findLastTextPartIndex(parts);

  const copyCode = async (code: string, index: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1200);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className="markdown-preview">
      {parts.map((part, index) => {
        if (part.type === 'code') {
          const parsedJson = parseJsonCodeBlock(part.language, part.value);
          if (parsedJson.ok) {
            if (suppressPlannerDecisionSummary && getPlannerDecision(parsedJson.value)) return null;
            return (
              <JsonBlock
                key={`preview-json-${index}`}
                language={part.language}
                value={part.value}
                data={parsedJson.value}
                agentNameById={agentNameById}
                suppressPlannerDecisionSummary={suppressPlannerDecisionSummary}
              />
            );
          }
          return (
            <CodeBlock
              key={`preview-code-${index}`}
              language={part.language}
              value={part.value}
              copied={copiedIndex === index}
              onCopy={() => void copyCode(part.value, index)}
              copyLabel={t('message.copy')}
              copiedLabel={t('message.copied')}
            />
          );
        }
        return (
          <MarkdownText
            key={`preview-text-${index}`}
            text={part.value}
            streaming={streaming && index === lastTextPartIndex}
            agentNameById={agentNameById}
          />
        );
      })}
      {streaming && lastTextPartIndex === -1 && <StreamingCursor />}
    </div>
  );
}

function parseJsonCodeBlock(language: string, value: string): { ok: true; value: JsonValue } | { ok: false } {
  if (!isJsonLanguage(language)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function isJsonLanguage(language: string): boolean {
  return ['json', 'application/json'].includes(language.trim().toLowerCase());
}

function JsonBlock({
  language,
  value,
  data,
  agentNameById,
  suppressPlannerDecisionSummary = false,
}: {
  language: string;
  value: string;
  data: JsonValue;
  agentNameById?: Map<string, string>;
  suppressPlannerDecisionSummary?: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<'structured' | 'source'>('structured');
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const taskReadiness = getTaskReadiness(data);
  const plannerDecision = getPlannerDecision(data);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="json-block">
      <div className="json-block-header">
        <div className="json-block-title">
          <span>{t('message.jsonStructured')}</span>
          <small>{language || 'json'}</small>
        </div>
        <div className="json-block-actions">
          <div className="json-mode-switch" aria-label={t('message.jsonModeAria')}>
            <button
              type="button"
              onClick={() => setMode('structured')}
              className={mode === 'structured' ? 'is-active' : undefined}
              aria-pressed={mode === 'structured'}
            >
              {t('message.jsonStructured')}
            </button>
            <button
              type="button"
              onClick={() => setMode('source')}
              className={mode === 'source' ? 'is-active' : undefined}
              aria-pressed={mode === 'source'}
            >
              {t('message.source')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void copyJson()}
            className="json-copy-button"
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? t('message.copied') : t('message.copy')}
          </button>
        </div>
      </div>
      {mode === 'structured' ? (
        taskReadiness ? (
          <TaskReadinessSummary readiness={taskReadiness} />
        ) : plannerDecision && !suppressPlannerDecisionSummary ? (
          <PlannerDecisionSummary decision={plannerDecision} agentNameById={agentNameById} />
        ) : (
          <div className="json-tree" aria-label={t('message.jsonTreeAria')}>
            <JsonTree value={data} />
          </div>
        )
      ) : (
        <pre className="code-block-pre json-source-pre"><code>{value}</code></pre>
      )}
    </div>
  );
}

function TaskReadinessSummary({ readiness }: { readiness: JsonObject }): JSX.Element {
  const title = typeof readiness.title === 'string' ? readiness.title : '未命名任务';
  const ready = typeof readiness.ready === 'boolean' ? readiness.ready : null;
  const confidence = typeof readiness.confidence === 'number' ? readiness.confidence : null;
  const recommendedMode = typeof readiness.recommended_mode === 'string' ? readiness.recommended_mode : null;
  const intent = typeof readiness.execution_intent === 'string' ? readiness.execution_intent : null;
  const missingQuestions = Array.isArray(readiness.missing_questions) ? readiness.missing_questions.length : null;

  return (
    <section className="json-task-summary" aria-label="任务准备状态">
      <div className="json-task-summary-main">
        <span className={ready === false ? 'is-warning' : 'is-ready'}>
          {ready === false ? '需要补充信息' : '任务准备状态'}
        </span>
        <strong>{title}</strong>
      </div>
      <dl className="json-task-summary-grid">
        <JsonMetric label="是否就绪" value={ready === null ? '未知' : ready ? '是' : '否'} />
        <JsonMetric label="置信度" value={confidence === null ? '未知' : formatConfidence(confidence)} />
        <JsonMetric label="推荐模式" value={formatSemanticJsonString(recommendedMode)} />
        <JsonMetric label="执行意图" value={formatSemanticJsonString(intent)} />
        <JsonMetric label="缺失问题" value={missingQuestions === null ? '未知' : `${missingQuestions} 个`} />
      </dl>
    </section>
  );
}

function JsonMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function getTaskReadiness(data: JsonValue): JsonObject | null {
  if (!isJsonObject(data)) return null;
  const value = data.task_readiness;
  return isJsonObject(value) ? value : null;
}

function PlannerDecisionSummary({
  decision,
  agentNameById,
}: {
  decision: JsonObject;
  agentNameById?: Map<string, string>;
}): JSX.Element {
  const mode = typeof decision.mode === 'string' ? decision.mode : null;
  const status = typeof decision.status === 'string' ? decision.status : null;
  const summary = typeof decision.summary === 'string' ? decision.summary : '无摘要';
  const awaiting = typeof decision.awaiting_user_confirmation === 'boolean' ? decision.awaiting_user_confirmation : null;
  const steps = Array.isArray(decision.next_steps) ? decision.next_steps.filter(isJsonObject) : [];

  return (
    <section className="json-planner-summary" aria-label="规划决策">
      <div className="json-planner-summary-main">
        <span>规划决策</span>
        <strong>{summary}</strong>
      </div>
      <dl className="json-task-summary-grid">
        <JsonMetric label="模式" value={formatSemanticJsonString(mode)} />
        <JsonMetric label="状态" value={formatSemanticJsonString(status)} />
        <JsonMetric label="等待确认" value={awaiting === null ? '未知' : awaiting ? '是' : '否'} />
        <JsonMetric label="下一步数量" value={`${steps.length} 个`} />
      </dl>
      {steps.length > 0 ? (
        <ol className="json-planner-step-list">
          {steps.map((step, index) => (
            <li key={index}>
              <div>
                <span>#{index + 1}</span>
                <strong title={typeof step.agent_id === 'string' ? step.agent_id : undefined}>
                  {formatAgentName(typeof step.agent_id === 'string' ? step.agent_id : null, agentNameById)}
                </strong>
              </div>
              <p>{typeof step.goal === 'string' ? step.goal : '未指定目标'}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="json-planner-empty">当前规划没有可派发的下一步。</p>
      )}
    </section>
  );
}

function getPlannerDecision(data: JsonValue): JsonObject | null {
  if (!isJsonObject(data)) return null;
  const value = data.planner_decision;
  return isJsonObject(value) ? value : null;
}

function JsonTree({ value }: { value: JsonValue }): JSX.Element {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="json-empty">[]</span>;
    return (
      <ol className="json-tree-list is-array">
        {value.map((item, index) => (
          <li key={index}>
            <span className="json-index">{index}</span>
            <JsonTree value={item} />
          </li>
        ))}
      </ol>
    );
  }

  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="json-empty">{'{}'}</span>;
    return (
      <dl className="json-tree-list">
        {entries.map(([key, entryValue]) => (
          <div key={key} className={`json-tree-row ${getJsonTreeRowClass(entryValue)}`}>
            <dt>
              <span>{jsonFieldLabels[key] ?? key}</span>
              {jsonFieldLabels[key] && <small>{key}</small>}
            </dt>
            <dd><JsonTree value={entryValue} /></dd>
          </div>
        ))}
      </dl>
    );
  }

  return <JsonPrimitive value={value} />;
}

function getJsonTreeRowClass(value: JsonValue): string {
  if (Array.isArray(value) || isJsonObject(value)) return 'is-nested';
  if (typeof value === 'string' && getTextDisplayWidth(value) > 24) return 'is-long';
  return 'is-compact';
}

function getTextDisplayWidth(value: string): number {
  return Array.from(value).reduce((width, character) => (
    width + (character.charCodeAt(0) > 255 ? 2 : 1)
  ), 0);
}

function JsonPrimitive({ value }: { value: Exclude<JsonValue, JsonValue[] | JsonObject> }): JSX.Element {
  if (value === null) return <span className="json-primitive is-null">null</span>;
  if (typeof value === 'boolean') {
    return <span className="json-primitive is-boolean">{value ? '是' : '否'}</span>;
  }
  if (typeof value === 'number') return <span className="json-primitive is-number">{String(value)}</span>;
  return <span className="json-primitive is-string">{value}</span>;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatConfidence(value: number): string {
  if (value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return `${value}%`;
}

function formatSemanticJsonString(value: string | null): string {
  if (!value) return '未知';
  return jsonValueLabels[value] ?? value;
}

function StreamingCursor(): JSX.Element {
  return <span className="streaming-cursor" aria-hidden="true" />;
}

function MarkdownText({
  text,
  streaming = false,
  agentNameById,
}: {
  text: string;
  streaming?: boolean;
  agentNameById?: Map<string, string>;
}): JSX.Element {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim().length > 0);
  return (
    <>
      {blocks.map((block, index) => renderMarkdownBlock(
        block,
        index,
        streaming && index === blocks.length - 1,
        agentNameById,
      ))}
    </>
  );
}

function renderMarkdownBlock(
  block: string,
  index: number,
  streaming = false,
  agentNameById?: Map<string, string>,
): JSX.Element {
  const trimmed = block.trim();
  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = Math.min(heading[1].length, 3);
    const Tag = (`h${level}` as keyof JSX.IntrinsicElements);
    return <Tag key={index}>{renderInlineMarkdown(heading[2], agentNameById)}{streaming && <StreamingCursor />}</Tag>;
  }

  if (/^>\s+/m.test(trimmed)) {
    return (
      <blockquote key={index}>
        {renderAgentNamesInText(trimmed.replace(/^>\s?/gm, ''), agentNameById)}
        {streaming && <StreamingCursor />}
      </blockquote>
    );
  }

  const lines = trimmed.split('\n');
  if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
    return (
      <ul key={index}>
        {lines.map((line, i) => (
          <li key={i}>
            {renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, ''), agentNameById)}
            {streaming && i === lines.length - 1 && <StreamingCursor />}
          </li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return (
      <ol key={index}>
        {lines.map((line, i) => (
          <li key={i}>
            {renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''), agentNameById)}
            {streaming && i === lines.length - 1 && <StreamingCursor />}
          </li>
        ))}
      </ol>
    );
  }

  if (/^-{3,}$/.test(trimmed)) {
    return streaming ? (
      <div key={index} className="markdown-rule-block">
        <hr />
        <StreamingCursor />
      </div>
    ) : <hr key={index} />;
  }

  return (
    <p key={index}>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {renderInlineMarkdown(line, agentNameById)}
          {streaming && i === lines.length - 1 && <StreamingCursor />}
        </span>
      ))}
    </p>
  );
}

function renderInlineMarkdown(text: string, agentNameById?: Map<string, string>): Array<string | JSX.Element> {
  const tokens: Array<string | JSX.Element> = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) pushTextWithAgentNames(tokens, text.slice(lastIndex, match.index), match.index, agentNameById);
    if (match[2]) {
      tokens.push(<strong key={match.index}>{renderAgentNamesInText(match[2], agentNameById, `strong-${match.index}`)}</strong>);
    } else if (match[3]) {
      tokens.push(<code key={match.index}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      const href = sanitizeMarkdownHref(match[5]);
      tokens.push(href ? (
        <a key={match.index} href={href} target="_blank" rel="noreferrer noopener">
          {match[4]}
        </a>
      ) : match[4]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) pushTextWithAgentNames(tokens, text.slice(lastIndex), lastIndex, agentNameById);
  return tokens;
}

function buildAgentNameMap(roomAgents: RoomAgent[], globalAgents: Agent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of globalAgents) {
    if (agent.agent_id && agent.name) map.set(agent.agent_id, agent.name);
  }
  for (const agent of roomAgents) {
    if (agent.agent_id && agent.agent_name) map.set(agent.agent_id, agent.agent_name);
  }
  return map;
}

function formatAgentName(agentId: string | null, agentNameById?: Map<string, string>): string {
  if (!agentId) return '未指定智能体';
  return agentNameById?.get(agentId) ?? agentId;
}

function pushTextWithAgentNames(
  tokens: Array<string | JSX.Element>,
  text: string,
  offset: number,
  agentNameById?: Map<string, string>,
): void {
  const rendered = renderAgentNamesInText(text, agentNameById, `agent-${offset}`);
  if (Array.isArray(rendered)) {
    tokens.push(...rendered);
  } else {
    tokens.push(rendered);
  }
}

function renderAgentNamesInText(
  text: string,
  agentNameById?: Map<string, string>,
  keyPrefix = 'agent',
): string | Array<string | JSX.Element> {
  if (!agentNameById || agentNameById.size === 0 || !text) return text;
  const ids = [...agentNameById.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])(${ids.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}_-])`, 'gu');
  const parts: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const agentId = match[2];
    const idStart = match.index + prefix.length;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (prefix) parts.push(prefix);
    parts.push(
      <span key={`${keyPrefix}-${idStart}`} className="agent-display-name" title={agentId}>
        {agentNameById.get(agentId) ?? agentId}
      </span>,
    );
    lastIndex = idStart + agentId.length;
  }
  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function CodeBlock({
  language,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
}: {
  language: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
}): JSX.Element {
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] focus:outline-none focus:glow-accent ease-ocean transition-all"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="code-block-pre"><code>{value}</code></pre>
    </div>
  );
}
