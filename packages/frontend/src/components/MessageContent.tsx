import { Children, isValidElement, cloneElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { AgentTimeline, AgentTimelineItem } from './AgentTimeline';
import {
  isStructuredJsonObject,
  StructuredJsonTree,
  type StructuredJsonObject,
  type StructuredJsonValue,
} from './structuredJson';
import { useI18n } from '../lib/i18n';
import type { Agent, MessageTrace, RoomAgent, Task } from '../lib/types';
import { buildAgentTranscript, type AgentTranscriptModel } from './agent-timeline/transcript';

type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string };

export type WorkspaceFileOpenHandler = (path: string) => void;

type JsonValue = StructuredJsonValue;
type JsonObject = StructuredJsonObject;

const fencePattern = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
const streamingCursorToken = '\uE000';
const workspaceDocumentPathPattern = /(^|[^\p{L}\p{N}_./-])((?:docs|\.codex|\.agents)\/[^\s`"'<>]+?\.(?:md|mdx|txt))(?![\p{L}\p{N}_./-])/gu;
const visualCompanionOfferEnglish =
  "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)";
const visualCompanionOfferChinese =
  '有些内容如果能在浏览器里展示，会更容易解释清楚。我可以在过程中为你准备 mockup、图表、方案对比和其他视觉内容。这个功能还比较新，可能会消耗较多 token。要试试看吗？（需要打开一个本地 URL）';

function localizeKnownAssistantMessageText(content: string, locale: 'zh' | 'en'): string {
  if (locale !== 'zh' || !content.includes(visualCompanionOfferEnglish)) return content;
  return content.split(visualCompanionOfferEnglish).join(visualCompanionOfferChinese);
}

export function isVisualCompanionOfferContent(content: string): boolean {
  return content.includes(visualCompanionOfferEnglish) || content.includes(visualCompanionOfferChinese);
}

const jsonValueLabels: Record<string, string> = {
  formal_workflow: '正式工作流',
  ready_to_execute: '准备执行',
  needs_choice: '等待选择方案',
  needs_boundary_confirmation: '等待边界确认',
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
    // info string 里语言标记后可能紧跟正文首字符（如 ```json{ 把 { 粘在语言行），
    // 需拆出语言前缀，把余下内容拼回正文，避免误把 "json{" 当语言名、并丢失开头的 {。
    const { language, extra } = splitFenceInfo(match[1]);
    parts.push({
      type: 'code',
      language,
      value: extra + (match[2] ?? ''),
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

// 拆分围栏 info string：取合法语言标识前缀作为语言；若其后紧贴非空白字符（如 ```json{ 的 {），
// 视为被粘进围栏行的正文并拼回正文；空白分隔的部分按围栏元信息丢弃。
function splitFenceInfo(rawInfo: string | undefined): { language: string; extra: string } {
  const info = rawInfo ?? '';
  const langMatch = info.match(/^\s*([A-Za-z0-9_.+#/-]+)/);
  if (!langMatch) return { language: normalizeFenceLanguage(info), extra: '' };
  const afterLang = info.slice(langMatch[0].length);
  const gluedMatch = afterLang.match(/^\S+/);
  return { language: normalizeFenceLanguage(langMatch[1]), extra: gluedMatch?.[0] ?? '' };
}

export function MessageContent({
  content,
  streaming = false,
  mode,
  trace,
  roomAgents = [],
  globalAgents = [],
  tasks = [],
  suppressTaskExecutionSummary = false,
  suppressWorkflowJsonBlocks = false,
  suppressTraceEvents = false,
  inlineSuffix,
  onOpenWorkspaceFile,
}: {
  content: string;
  streaming?: boolean;
  mode?: 'preview' | 'source';
  trace?: MessageTrace;
  roomAgents?: RoomAgent[];
  globalAgents?: Agent[];
  tasks?: Task[];
  suppressTaskExecutionSummary?: boolean;
  suppressWorkflowJsonBlocks?: boolean;
  suppressTraceEvents?: boolean;
  inlineSuffix?: ReactNode;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
}): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const { locale, t } = useI18n();
  const agentNameById = useMemo(() => buildAgentNameMap(roomAgents, globalAgents), [globalAgents, roomAgents]);
  const taskTitleById = useMemo(() => buildTaskTitleMap(tasks), [tasks]);
  const activeMode = mode ?? 'preview';
  const displayContent = activeMode === 'source' ? content : localizeKnownAssistantMessageText(content, locale);
  const parts = parseMessage(displayContent);
  const markdown = streaming ? isStableStreamingMarkdownContent(displayContent) : isMarkdownContent(displayContent);
  const lastTextPartIndex = findLastTextPartIndex(parts);
  const transcript = activeMode !== 'source' ? buildAgentTranscript(trace, displayContent) : null;

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
          taskTitleById={taskTitleById}
          suppressTaskExecutionSummary={suppressTaskExecutionSummary}
          suppressWorkflowJsonBlocks={suppressWorkflowJsonBlocks}
          suppressTraceEvents={suppressTraceEvents}
          locale={locale}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      ) : activeMode === 'source' ? (
        <CodeBlock
          language="markdown"
          value={content}
          copied={copiedIndex === -1}
          onCopy={() => void copyCode(content, -1)}
          copyLabel={t('message.copy')}
          copiedLabel={t('message.copied')}
        />
      ) : (
        <>
          <div>
            {markdown ? (
              <MarkdownPreview
                content={displayContent}
                streaming={streaming}
                agentNameById={agentNameById}
                taskTitleById={taskTitleById}
                suppressTaskExecutionSummary={suppressTaskExecutionSummary}
                suppressWorkflowJsonBlocks={suppressWorkflowJsonBlocks}
                inlineSuffix={inlineSuffix}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            ) : (
              <>
                {parts.map((part, index) => {
                  if (part.type === 'text') {
                    if (!part.value) return null;
                    return (
                      <span key={`text-${index}`} className="whitespace-pre-wrap break-words">
                        {renderInlineTextReferences(part.value, agentNameById, taskTitleById, 'inline', onOpenWorkspaceFile)}
                        {streaming && index === lastTextPartIndex && <StreamingCursor />}
                        {index === lastTextPartIndex ? renderInlineSuffix(inlineSuffix) : null}
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
                {lastTextPartIndex === -1 ? renderInlineSuffix(inlineSuffix) : null}
              </>
            )}
          </div>
          {!suppressTraceEvents && <AgentTimeline trace={trace} />}
        </>
      )}
    </div>
  );
}

function AgentTranscriptView({
  transcript,
  streaming,
  agentNameById,
  taskTitleById,
  suppressTaskExecutionSummary = false,
  suppressWorkflowJsonBlocks = false,
  suppressTraceEvents = false,
  locale,
  onOpenWorkspaceFile,
}: {
  transcript: AgentTranscriptModel;
  streaming: boolean;
  agentNameById?: Map<string, string>;
  taskTitleById?: Map<string, string>;
  suppressTaskExecutionSummary?: boolean;
  suppressWorkflowJsonBlocks?: boolean;
  suppressTraceEvents?: boolean;
  locale: 'zh' | 'en';
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
}): JSX.Element {
  return (
    <div className="agent-transcript">
      {transcript.items.map((item, index) => {
        if (item.type === 'event' && suppressTraceEvents) return null;

        return item.type === 'text' ? (
          <div key={item.id} className="agent-transcript-text">
            <MarkdownPreview
              content={localizeKnownAssistantMessageText(item.text, locale)}
              streaming={streaming && index === transcript.items.length - 1}
              agentNameById={agentNameById}
              taskTitleById={taskTitleById}
              suppressTaskExecutionSummary={suppressTaskExecutionSummary}
              suppressWorkflowJsonBlocks={suppressWorkflowJsonBlocks}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          </div>
        ) : (
          <div key={item.id} className="agent-transcript-event">
            <AgentTimelineItem event={item.event} presentation="activity" />
          </div>
        );
      })}
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
  taskTitleById,
  suppressTaskExecutionSummary = false,
  suppressWorkflowJsonBlocks = false,
  inlineSuffix,
  onOpenWorkspaceFile,
}: {
  content: string;
  streaming?: boolean;
  agentNameById?: Map<string, string>;
  taskTitleById?: Map<string, string>;
  suppressTaskExecutionSummary?: boolean;
  suppressWorkflowJsonBlocks?: boolean;
  inlineSuffix?: ReactNode;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
}): JSX.Element {
  const { locale, t } = useI18n();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const displayContent = localizeKnownAssistantMessageText(content, locale);
  const parts = parseMessage(displayContent);
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
            if (shouldHideWorkflowJsonBlock(parsedJson.value, {
              suppressTaskExecutionSummary,
              suppressWorkflowJsonBlocks,
            })) {
              return null;
            }
            return (
              <JsonBlock
                key={`preview-json-${index}`}
                language={part.language}
                value={part.value}
                data={parsedJson.value}
                agentNameById={agentNameById}
                suppressTaskExecutionSummary={suppressTaskExecutionSummary}
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
            taskTitleById={taskTitleById}
            inlineSuffix={index === lastTextPartIndex ? inlineSuffix : undefined}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        );
      })}
      {streaming && lastTextPartIndex === -1 && <StreamingCursor />}
      {lastTextPartIndex === -1 ? renderInlineSuffix(inlineSuffix) : null}
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
  suppressTaskExecutionSummary = false,
}: {
  language: string;
  value: string;
  data: JsonValue;
  agentNameById?: Map<string, string>;
  suppressTaskExecutionSummary?: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<'structured' | 'source'>('structured');
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const taskReadiness = getTaskReadiness(data);

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
        ) : (
          <div className="json-tree" aria-label={t('message.jsonTreeAria')}>
            <StructuredJsonTree value={data} />
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
  if (!isStructuredJsonObject(data)) return null;
  const value = data.task_readiness;
  return isStructuredJsonObject(value) ? value : null;
}

function getTaskExecution(data: JsonValue): JsonObject | null {
  if (!isStructuredJsonObject(data)) return null;
  const value = data.task_execution;
  return isStructuredJsonObject(value) ? value : null;
}

function shouldHideWorkflowJsonBlock(
  data: JsonValue,
  options: { suppressTaskExecutionSummary: boolean; suppressWorkflowJsonBlocks: boolean },
): boolean {
  if (options.suppressWorkflowJsonBlocks && (getTaskExecution(data) || getTaskReadiness(data))) {
    return true;
  }
  return options.suppressTaskExecutionSummary && Boolean(getTaskExecution(data));
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

function MarkdownInlineCode({ children }: { children?: ReactNode }): JSX.Element {
  return <code>{children}</code>;
}

function WorkspaceFileReference({
  path,
  onOpen,
}: {
  path: string;
  onOpen: WorkspaceFileOpenHandler;
}): JSX.Element {
  return (
    <button
      type="button"
      className="message-workspace-file-ref"
      data-workspace-file-path={path}
      title={`预览 ${path}`}
      onClick={() => onOpen(path)}
    >
      {path}
    </button>
  );
}

function renderInlineSuffix(suffix: ReactNode): ReactNode {
  if (!suffix) return null;
  return <>{'\u2060'}{suffix}</>;
}

type MarkdownPositionNode = {
  position?: {
    end?: {
      offset?: number;
    };
  };
};

function countMarkdownInlineSuffixTargets(source: string): number {
  const lines = source.split(/\r?\n/);
  let count = 0;
  let inParagraph = false;

  const closeParagraph = () => {
    if (!inParagraph) return;
    count += 1;
    inParagraph = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      continue;
    }
    if (/^#{1,6}\s+\S/.test(trimmed)) {
      closeParagraph();
      count += 1;
      continue;
    }
    if (/^(?:[-*+]|\d+\.)\s+\S/.test(trimmed)) {
      closeParagraph();
      count += 1;
      continue;
    }
    inParagraph = true;
  }
  closeParagraph();
  return count;
}

function shouldRenderInlineSuffixAtNode(node: unknown, suffixTargetEndOffset: number | null): boolean {
  if (suffixTargetEndOffset === null) return false;
  if (!node || typeof node !== 'object') return false;
  return (node as MarkdownPositionNode).position?.end?.offset === suffixTargetEndOffset;
}

function MarkdownText({
  text,
  streaming = false,
  agentNameById,
  taskTitleById,
  inlineSuffix,
  onOpenWorkspaceFile,
}: {
  text: string;
  streaming?: boolean;
  agentNameById?: Map<string, string>;
  taskTitleById?: Map<string, string>;
  inlineSuffix?: ReactNode;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
}): JSX.Element {
  const source = streaming ? `${text}${streamingCursorToken}` : text;
  const hasSuffixTarget = inlineSuffix ? countMarkdownInlineSuffixTargets(source) > 0 : false;
  const suffixTargetEndOffset = hasSuffixTarget ? source.trimEnd().length : null;
  const components = createMarkdownComponents(agentNameById, taskTitleById, {
    inlineSuffix,
    suffixTargetEndOffset,
    onOpenWorkspaceFile,
  });

  return (
    <>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={components}
      urlTransform={sanitizeMarkdownUrl}
    >
      {source}
    </ReactMarkdown>
    {inlineSuffix && !hasSuffixTarget ? renderInlineSuffix(inlineSuffix) : null}
    </>
  );
}

function createMarkdownComponents(
  agentNameById?: Map<string, string>,
  taskTitleById?: Map<string, string>,
  suffixOptions: {
    inlineSuffix?: ReactNode;
    suffixTargetEndOffset: number | null;
    onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
  } = { suffixTargetEndOffset: null },
): Components {
  const renderChildren = (children: ReactNode) =>
    renderMarkdownReferenceChildren(children, agentNameById, taskTitleById, 'markdown', suffixOptions.onOpenWorkspaceFile);

  const renderWithOptionalSuffix = (children: ReactNode, node: unknown) => {
    const content = renderChildren(children);
    if (!suffixOptions.inlineSuffix || !shouldRenderInlineSuffixAtNode(node, suffixOptions.suffixTargetEndOffset)) {
      return content;
    }
    return <>{content}{renderInlineSuffix(suffixOptions.inlineSuffix)}</>;
  };

  return {
    a: ({ href, children }) => {
      const safeHref = href ? sanitizeMarkdownHref(href) : null;
      const content = renderMarkdownReferenceChildren(children, agentNameById, taskTitleById);
      if (!safeHref) return <>{content}</>;
      return (
        <a href={safeHref} target="_blank" rel="noreferrer noopener">
          {content}
        </a>
      );
    },
    h1: ({ node, children }) => <h1>{renderWithOptionalSuffix(children, node)}</h1>,
    h2: ({ node, children }) => <h2>{renderWithOptionalSuffix(children, node)}</h2>,
    h3: ({ node, children }) => <h3>{renderWithOptionalSuffix(children, node)}</h3>,
    h4: ({ node, children }) => <h4>{renderWithOptionalSuffix(children, node)}</h4>,
    h5: ({ node, children }) => <h5>{renderWithOptionalSuffix(children, node)}</h5>,
    h6: ({ node, children }) => <h6>{renderWithOptionalSuffix(children, node)}</h6>,
    p: ({ node, children }) => <p>{renderWithOptionalSuffix(children, node)}</p>,
    li: ({ node, children }) => <li>{renderWithOptionalSuffix(children, node)}</li>,
    blockquote: ({ children }) => <blockquote>{renderChildren(children)}</blockquote>,
    td: ({ children }) => <td>{renderChildren(children)}</td>,
    th: ({ children }) => <th>{renderChildren(children)}</th>,
    img: ({ src, alt }) => {
      const safeSrc = src ? sanitizeMarkdownImageSrc(src) : null;
      if (!safeSrc) return null;
      return <img src={safeSrc} alt={alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
    },
    code: ({ children }) => {
      const workspacePath = suffixOptions.onOpenWorkspaceFile ? getSingleWorkspaceDocumentPath(children) : null;
      if (workspacePath && suffixOptions.onOpenWorkspaceFile) {
        return <WorkspaceFileReference path={workspacePath} onOpen={suffixOptions.onOpenWorkspaceFile} />;
      }
      return <MarkdownInlineCode>{children}</MarkdownInlineCode>;
    },
  };
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

function buildTaskTitleMap(tasks: Task[]): Map<string, string> {
  return new Map(tasks.map((task) => [task.id, task.title]));
}

function renderInlineTextReferences(
  text: string,
  agentNameById?: Map<string, string>,
  taskTitleById?: Map<string, string>,
  keyPrefix = 'inline',
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler,
): string | Array<string | JSX.Element> {
  if (!text) return text;
  const pattern = /(^|[^\p{L}\p{N}_-])#task:([\p{L}\p{N}_-]+)/gu;
  const parts: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const taskId = match[2];
    const refStart = match.index + prefix.length;
    if (match.index > lastIndex) {
      pushMaybeAgentNames(parts, text.slice(lastIndex, match.index), `${keyPrefix}-agent-${lastIndex}`, agentNameById, onOpenWorkspaceFile);
    }
    if (prefix) parts.push(prefix);
    parts.push(
      <TaskReferenceChip
        key={`${keyPrefix}-task-${refStart}`}
        taskId={taskId}
        title={taskTitleById?.get(taskId)}
      />,
    );
    lastIndex = refStart + `#task:${taskId}`.length;
  }

  if (lastIndex === 0) {
    return renderWorkspaceFileReferences(text, keyPrefix, onOpenWorkspaceFile, (remainingText, nestedKeyPrefix) =>
      renderAgentNamesInText(remainingText, agentNameById, nestedKeyPrefix)
    );
  }
  if (lastIndex < text.length) {
    pushMaybeAgentNames(parts, text.slice(lastIndex), `${keyPrefix}-agent-${lastIndex}`, agentNameById, onOpenWorkspaceFile);
  }
  return parts;
}

function renderMarkdownReferenceChildren(
  children: ReactNode,
  agentNameById?: Map<string, string>,
  taskTitleById?: Map<string, string>,
  keyPrefix = 'markdown',
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler,
): ReactNode {
  return Children.map(children, (child, index) => {
    const childKey = `${keyPrefix}-${index}`;
    if (typeof child === 'string') {
      return renderMarkdownTextNode(child, agentNameById, taskTitleById, childKey, onOpenWorkspaceFile);
    }
    if (!isValidElement(child)) return child;
    if (isMarkdownLinkElement(child)) return child;
    if (isMarkdownCodeElement(child)) return child;
    const props = child.props as { children?: ReactNode };
    if (!('children' in props)) return child;
    return cloneElement(child as ReactElement<{ children?: ReactNode }>, {
      children: renderMarkdownReferenceChildren(props.children, agentNameById, taskTitleById, childKey, onOpenWorkspaceFile),
    });
  });
}

function isMarkdownLinkElement(child: ReactElement): boolean {
  if (child.type === 'a') return true;
  const props = child.props as { node?: { tagName?: unknown } };
  return props.node?.tagName === 'a';
}

function isMarkdownCodeElement(child: ReactElement): boolean {
  if (child.type === 'code' || child.type === 'pre' || child.type === MarkdownInlineCode) return true;
  const props = child.props as { node?: { tagName?: unknown } };
  return props.node?.tagName === 'code' || props.node?.tagName === 'pre';
}

function renderMarkdownTextNode(
  text: string,
  agentNameById?: Map<string, string>,
  taskTitleById?: Map<string, string>,
  keyPrefix = 'markdown-text',
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler,
): string | Array<string | JSX.Element> {
  const tokens: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (let index = text.indexOf(streamingCursorToken); index !== -1; index = text.indexOf(streamingCursorToken, lastIndex)) {
    if (index > lastIndex) {
      pushMarkdownReferenceText(tokens, text.slice(lastIndex, index), `${keyPrefix}-${tokenIndex++}`, agentNameById, taskTitleById, onOpenWorkspaceFile);
    }
    tokens.push(<StreamingCursor key={`${keyPrefix}-cursor-${tokenIndex++}`} />);
    lastIndex = index + streamingCursorToken.length;
  }

  if (lastIndex === 0) return renderInlineTextReferences(text, agentNameById, taskTitleById, keyPrefix, onOpenWorkspaceFile);
  if (lastIndex < text.length) {
    pushMarkdownReferenceText(tokens, text.slice(lastIndex), `${keyPrefix}-${tokenIndex++}`, agentNameById, taskTitleById, onOpenWorkspaceFile);
  }
  return tokens;
}

function pushMarkdownReferenceText(
  tokens: Array<string | JSX.Element>,
  text: string,
  keyPrefix: string,
  agentNameById?: Map<string, string>,
  taskTitleById?: Map<string, string>,
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler,
): void {
  const rendered = renderInlineTextReferences(text, agentNameById, taskTitleById, keyPrefix, onOpenWorkspaceFile);
  if (Array.isArray(rendered)) {
    tokens.push(...rendered);
  } else if (rendered) {
    tokens.push(rendered);
  }
}

function pushMaybeAgentNames(
  tokens: Array<string | JSX.Element>,
  text: string,
  keyPrefix: string,
  agentNameById?: Map<string, string>,
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler,
): void {
  const rendered = renderWorkspaceFileReferences(text, keyPrefix, onOpenWorkspaceFile, (remainingText, nestedKeyPrefix) =>
    renderAgentNamesInText(remainingText, agentNameById, nestedKeyPrefix)
  );
  if (Array.isArray(rendered)) {
    tokens.push(...rendered);
  } else if (rendered) {
    tokens.push(rendered);
  }
}

function renderWorkspaceFileReferences(
  text: string,
  keyPrefix: string,
  onOpenWorkspaceFile: WorkspaceFileOpenHandler | undefined,
  renderRemainingText: (text: string, keyPrefix: string) => string | Array<string | JSX.Element>,
): string | Array<string | JSX.Element> {
  if (!onOpenWorkspaceFile || !text) return renderRemainingText(text, keyPrefix);
  workspaceDocumentPathPattern.lastIndex = 0;
  const parts: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = workspaceDocumentPathPattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const path = match[2];
    const pathStart = match.index + prefix.length;
    if (match.index > lastIndex) {
      pushRenderedText(parts, renderRemainingText(text.slice(lastIndex, match.index), `${keyPrefix}-text-${lastIndex}`));
    }
    if (prefix) parts.push(prefix);
    parts.push(
      <WorkspaceFileReference
        key={`${keyPrefix}-workspace-file-${pathStart}`}
        path={path}
        onOpen={onOpenWorkspaceFile}
      />,
    );
    lastIndex = pathStart + path.length;
  }

  if (lastIndex === 0) return renderRemainingText(text, keyPrefix);
  if (lastIndex < text.length) {
    pushRenderedText(parts, renderRemainingText(text.slice(lastIndex), `${keyPrefix}-text-${lastIndex}`));
  }
  return parts;
}

function pushRenderedText(parts: Array<string | JSX.Element>, rendered: string | Array<string | JSX.Element>): void {
  if (Array.isArray(rendered)) {
    parts.push(...rendered);
  } else if (rendered) {
    parts.push(rendered);
  }
}

function getSingleWorkspaceDocumentPath(children: ReactNode): string | null {
  const text = reactNodeToText(children).trim();
  if (!text) return null;
  workspaceDocumentPathPattern.lastIndex = 0;
  const match = workspaceDocumentPathPattern.exec(text);
  if (!match || match[1]) return null;
  return match[2] === text ? text : null;
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join('');
  return '';
}

function TaskReferenceChip({ taskId, title }: { taskId: string; title?: string }): JSX.Element {
  const taskLabel = title?.trim() || `#task:${taskId.slice(0, 6)}`;
  return (
    <span className="message-task-ref-chip" title={`#task:${taskId}`}>
      {`任务:${taskLabel}`}
    </span>
  );
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

function sanitizeMarkdownImageSrc(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;

  try {
    const url = new URL(trimmed);
    return ['http:', 'https:'].includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

const sanitizeMarkdownUrl: UrlTransform = (value) => sanitizeMarkdownHref(value) ?? '';

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
