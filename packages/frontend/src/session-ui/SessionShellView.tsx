import {
  AlertTriangle,
  AtSign,
  Bell,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileText,
  Filter,
  GitFork,
  Hash,
  History,
  Info,
  MessageSquare,
  Minimize2,
  MoreVertical,
  Plus,
  RefreshCcw,
  Repeat2,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Square,
  StopCircle,
  Terminal,
  TrendingUp,
  UserCircle,
  Waves,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type {
  HistoryRecord,
  Session,
  SessionDetail,
  SessionEvidenceEvent,
  SessionMessage,
  SessionPlanItem,
  SessionRun,
  SessionWorkspacePayload,
  StatusSnapshot,
} from '../lib/types';
import { evidenceTypeLabel, sessionStatusTone } from './session-ui-model';

const fallbackTools = [
  { action: 'READ', path: 'packages/frontend/src/session-ui/SessionShellView.tsx', tone: 'primary' },
  { action: 'READ', path: 'packages/frontend/src/session-ui/session-os.css', tone: 'primary' },
  { action: 'EXEC', path: 'npm run build', tone: 'warn' },
];

const fallbackDiffs = [
  { path: 'SessionShellView.tsx', delta: '+184', tone: 'ok' },
  { path: 'session-os.css', delta: '+312', tone: 'ok' },
  { path: 'AppShell.tsx', delta: '+3', tone: 'ok' },
];

export function SessionShellView({
  payload,
  onSendMessage,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  const activeRun = getActiveRun(payload.activeSession);
  const recentHistory = payload.historyRecords.slice(0, 12);
  const forkTarget = payload.historyRecords[0]?.id;

  return (
    <section className="session-shell deepsea-shell" aria-label="Session Operations Console">
      <TopCommandBar
        payload={payload}
        activeRun={activeRun}
        onCommand={onCommand}
        forkTarget={forkTarget}
      />
      <main className="deepsea-main">
        <HistoryRail
          records={recentHistory}
          activeSession={payload.activeSession.session}
          onCommand={onCommand}
        />
        <TranscriptCanvas
          detail={payload.activeSession}
          evidence={payload.evidence}
          onSendMessage={onSendMessage}
          onCommand={onCommand}
        />
        <IntegratedInspector payload={payload} activeRun={activeRun} onCommand={onCommand} />
      </main>
    </section>
  );
}

function TopCommandBar({
  payload,
  activeRun,
  onCommand,
  forkTarget,
}: {
  payload: SessionWorkspacePayload;
  activeRun: SessionRun | null;
  onCommand: (command: string) => void;
  forkTarget?: string;
}): JSX.Element {
  const session = payload.activeSession.session;
  const provider = payload.status.provider.backend ?? session.provider ?? activeRun?.provider ?? 'codex';
  const model = payload.status.provider.model ?? session.model ?? activeRun?.model ?? 'gpt-test';
  const pressure = contextPressurePercent(payload.status.context.pressure);

  return (
    <header className="deepsea-topbar">
      <div className="deepsea-topbar__identity">
        <div className="deepsea-brand">
          <Waves aria-hidden="true" />
          <span>Deepsea Command</span>
        </div>
        <div className="deepsea-divider" />
        <div className="deepsea-workspace-meta">
          <span className="deepsea-mono">{session.workspace_path ?? payload.project.path ?? '~/workspace/deepsea-command-center'}</span>
          <strong>{payload.status.goal ?? session.current_goal ?? session.title}</strong>
        </div>
      </div>

      <div className="deepsea-topbar__center">
        <div className="deepsea-command-group" aria-label="Session command actions">
          <CommandPill label="新建" kbd="⌘N" icon={Plus} command="/new" onCommand={onCommand} />
          <CommandPill label="压缩" kbd="⌘P" icon={Minimize2} command="/compact" onCommand={onCommand} />
          <CommandPill
            label="分叉"
            kbd="⌘B"
            icon={GitFork}
            command={forkTarget ? `/fork history:${forkTarget}` : '/fork'}
            onCommand={onCommand}
          />
          <CommandPill label="继续执行" kbd="⌘R" icon={RefreshCcw} command="/status" onCommand={onCommand} primary />
        </div>
        <div className="deepsea-model-pill">
          <span className="deepsea-model-pill__model">
            <Brain aria-hidden="true" />
            <span className="deepsea-mono">{formatProviderModel(provider, model)}</span>
          </span>
          <span className="deepsea-online-dot" />
          <strong>在线</strong>
        </div>
      </div>

      <div className="deepsea-topbar__actions">
        <ContextPressure pressure={pressure} />
        <button type="button" className="deepsea-icon-button" aria-label="设置">
          <Settings aria-hidden="true" />
        </button>
        <button type="button" className="deepsea-icon-button deepsea-icon-button--alert" aria-label="通知">
          <Bell aria-hidden="true" />
          <span />
        </button>
        <div className="deepsea-avatar" aria-label="Profile">
          <UserCircle aria-hidden="true" />
        </div>
      </div>
    </header>
  );
}

function CommandPill({
  label,
  kbd,
  icon: Icon,
  command,
  onCommand,
  primary = false,
}: {
  label: string;
  kbd: string;
  icon: typeof Plus;
  command: string;
  onCommand: (command: string) => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className="deepsea-command-pill"
      data-primary={primary ? 'true' : undefined}
      data-command={command}
      onClick={() => onCommand(command)}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <kbd>{kbd}</kbd>
    </button>
  );
}

function ContextPressure({ pressure }: { pressure: number }): JSX.Element {
  const active = Math.max(1, Math.round(pressure / 10));
  return (
    <div className="deepsea-pressure" aria-label="上下文压力">
      <div>
        <span>上下文压力</span>
        <strong>{pressure}%</strong>
      </div>
      <div className="deepsea-pressure__bars">
        {Array.from({ length: 10 }, (_, index) => (
          <span data-active={index < active ? 'true' : undefined} key={index} />
        ))}
      </div>
    </div>
  );
}

function HistoryRail({
  records,
  activeSession,
  onCommand,
}: {
  records: HistoryRecord[];
  activeSession: Session;
  onCommand: (command: string) => void;
}): JSX.Element {
  return (
    <aside className="deepsea-history" aria-label="History Records">
      <div className="deepsea-history__header">
        <div className="deepsea-history__title">
          <div>
            <History aria-hidden="true" />
            <h2>会话历史</h2>
          </div>
          <div className="deepsea-history__tools">
            <Filter aria-hidden="true" />
            <MoreVertical aria-hidden="true" />
          </div>
        </div>
        <label className="deepsea-search">
          <Search aria-hidden="true" />
          <input type="search" placeholder="搜索历史..." />
        </label>
      </div>

      <div className="deepsea-history__list">
        <article className="deepsea-history-card is-active">
          <span className="deepsea-history-card__rail" />
          <div>
            <h3>{activeSession.title}</h3>
            <p className="deepsea-mono">{formatTimeRange(activeSession.created_at, activeSession.updated_at)}</p>
            <div className="deepsea-history-card__footer">
              <span className="deepsea-status-chip" data-tone="primary">运行中</span>
              <span className="deepsea-agent-mini">
                <Brain aria-hidden="true" />
                {formatProviderModel(activeSession.provider ?? 'codex', activeSession.model ?? 'gpt-test')}
              </span>
            </div>
          </div>
        </article>

        {records.length === 0 ? (
          <div className="deepsea-empty">暂无历史记录。使用 New 后会把两段 New 之间的对话归档到这里。</div>
        ) : records.map((record) => (
          <article className="deepsea-history-card" data-status={record.status} key={record.id}>
            <span className="deepsea-history-card__rail" />
            <div>
              <h3>{record.title}</h3>
              <p>{record.summary}</p>
              <p className="deepsea-mono">{formatTimeRange(record.started_at, record.ended_at)}</p>
              <div className="deepsea-history-card__footer">
                <span className="deepsea-status-chip" data-tone={sessionStatusTone(record.status)}>
                  {historyStatusLabel(record.status)}
                </span>
                <div className="deepsea-card-actions">
                  <button type="button" title="Resume" onClick={() => onCommand(`/resume ${record.id}`)}>
                    <RefreshCcw aria-hidden="true" />
                  </button>
                  <button type="button" title="Fork" onClick={() => onCommand(`/fork history:${record.id}`)}>
                    <GitFork aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="deepsea-history__footer">
        <button type="button" className="deepsea-primary-button" onClick={() => onCommand('/new')}>
          <Plus aria-hidden="true" />
          新建作战行动
        </button>
      </div>
    </aside>
  );
}

function TranscriptCanvas({
  detail,
  evidence,
  onSendMessage,
  onCommand,
}: {
  detail: SessionDetail;
  evidence: SessionEvidenceEvent[];
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  const messages = detail.messages.slice(-18);
  return (
    <section className="deepsea-transcript" aria-label="Active Session">
      <div className="deepsea-transcript__scroll">
        <div className="deepsea-transcript__heading">
          <h2>
            <MessageSquare aria-hidden="true" />
            3. 对话记录 <span>(Transcript)</span>
          </h2>
          <button type="button">
            全部展开
            <ChevronDown aria-hidden="true" />
          </button>
        </div>

        {messages.length === 0 ? (
          <div className="deepsea-empty deepsea-empty--center">发送第一条消息开始当前会话。</div>
        ) : messages.map((message) => (
          <TranscriptMessage
            evidence={evidence.filter((event) => event.source_message_id === message.id)}
            key={message.id}
            message={message}
          />
        ))}

        {detail.runs.slice(-3).map((run) => (
          <article className="deepsea-run-log" key={run.id}>
            <div>
              <span className="deepsea-status-chip" data-tone={run.status === 'failed' ? 'danger' : 'ok'}>{run.provider}</span>
              <span className="deepsea-mono">{run.status}</span>
            </div>
            <p>{run.stdout || run.stderr || run.activity_log || run.prompt || 'No output yet'}</p>
          </article>
        ))}
      </div>
      <DeepseaComposer onCommand={onCommand} onSendMessage={onSendMessage} />
    </section>
  );
}

function TranscriptMessage({
  message,
  evidence,
}: {
  message: SessionMessage;
  evidence: SessionEvidenceEvent[];
}): JSX.Element {
  const role = message.role === 'assistant' ? 'ASSISTANT' : message.role.toUpperCase();
  return (
    <article className="deepsea-message" data-role={message.role}>
      <header>
        <span>{role}</span>
        <time className="deepsea-mono">{formatClock(message.created_at)}</time>
        {(message.status === 'queued' || message.status === 'streaming') && <strong>思考中</strong>}
      </header>
      <p>{message.content}</p>
      {evidence.length > 0 && (
        <div className="deepsea-evidence-tray">
          <div>
            <FileText aria-hidden="true" />
            <span>证据摘要：{evidence.length} 条记录，最近为 {evidenceTypeLabel(evidence[evidence.length - 1].event_type)}</span>
          </div>
          <ChevronDown aria-hidden="true" />
        </div>
      )}
    </article>
  );
}

function DeepseaComposer({
  onSendMessage,
  onCommand,
}: {
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  const [content, setContent] = useState('');

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = content.trim();
    if (!next) return;
    onSendMessage(next);
    setContent('');
  };

  return (
    <form className="deepsea-composer" onSubmit={submit}>
      <div className="deepsea-composer__header">
        <h3>
          <Terminal aria-hidden="true" />
          命令输入 <span>(Composer)</span>
        </h3>
        <span className="deepsea-mode-pill">mode: code</span>
      </div>
      <div className="deepsea-composer__field">
        <input
          aria-label="命令输入"
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          placeholder="输入命令或 / 选择命令，支持 @ 文件、# 历史、! 上下文"
        />
        <div className="deepsea-composer__footer">
          <div className="deepsea-command-shortcuts">
            {['/new', '/compact', '/status', '/context'].map((command) => (
              <button type="button" key={command} onClick={() => onCommand(command)}>
                {command}
              </button>
            ))}
          </div>
          <div className="deepsea-composer__tools">
            <AtSign aria-hidden="true" />
            <Hash aria-hidden="true" />
            <AlertTriangle aria-hidden="true" />
            <button type="submit" className="deepsea-send-button" aria-label="发送">
              <SendHorizontal aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div className="deepsea-compact-alert">
        <span>
          <AlertTriangle aria-hidden="true" />
          检测到未应用的 Compact 预览
        </span>
        <button type="button" onClick={() => onCommand('/compact')}>查看预览</button>
      </div>
    </form>
  );
}

function IntegratedInspector({
  payload,
  activeRun,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  activeRun: SessionRun | null;
  onCommand: (command: string) => void;
}): JSX.Element {
  const session = payload.activeSession.session;
  const tools = useMemo(() => collectToolRows(payload.evidence), [payload.evidence]);
  const diffs = useMemo(() => collectDiffRows(payload.evidence, payload.status), [payload.evidence, payload.status]);

  return (
    <aside className="deepsea-inspector" aria-label="Session Inspector">
      <div className="deepsea-tabs" role="tablist" aria-label="Inspector tabs">
        {['状态', '契约', '运行', '工具', '计划'].map((tab, index) => (
          <button type="button" className={index === 0 ? 'is-active' : undefined} key={tab}>
            {tab}
          </button>
        ))}
      </div>
      <div className="deepsea-inspector__scroll">
        <StatusModule status={payload.status} />
        <ContractModule session={session} />
        <RunModule run={activeRun} status={payload.status} onCommand={onCommand} />
        <ToolsModule rows={tools} />
        <PlanModule items={payload.activeSession.planItems} />
        <DiffModule rows={diffs} />
      </div>
    </aside>
  );
}

function StatusModule({ status }: { status: StatusSnapshot }): JSX.Element {
  const pressure = contextPressurePercent(status.context.pressure);
  return (
    <section className="deepsea-inspector-section">
      <h3>
        当前状态 (Status)
        <Info aria-hidden="true" />
      </h3>
      <dl className="deepsea-status-grid">
        <div>
          <dt>当前目标</dt>
          <dd>{status.goal ?? '等待目标声明'}</dd>
        </div>
        <div>
          <dt>阶段</dt>
          <dd><span className="deepsea-mode-pill">{status.mode.toUpperCase()} / {phaseLabel(status.phase)}</span></dd>
        </div>
      </dl>
      <div className="deepsea-progress">
        <div>
          <span>上下文压力</span>
          <strong>{pressure}%</strong>
        </div>
        <span><i style={{ width: `${pressure}%` }} /></span>
      </div>
      <div className="deepsea-next-action">
        <TrendingUp aria-hidden="true" />
        <strong>下一步: {status.nextAction.label}</strong>
      </div>
    </section>
  );
}

function ContractModule({ session }: { session: Session }): JSX.Element {
  return (
    <section className="deepsea-glass-card">
      <div className="deepsea-module-title">
        <h3>目标契约 (Contract)</h3>
        <button type="button">编辑</button>
      </div>
      <div className="deepsea-contract-list">
        <div>
          <span>目标</span>
          <p>{session.current_goal ?? session.title}</p>
        </div>
        <div>
          <span>边界</span>
          <p>仅修改当前会话页视觉层，保持 Session API 与数据模型不变</p>
        </div>
        <div>
          <span>风险</span>
          <p><i /> 全局 AppShell 顶部栏可能影响 4:3 还原</p>
        </div>
      </div>
    </section>
  );
}

function RunModule({
  run,
  status,
  onCommand,
}: {
  run: SessionRun | null;
  status: StatusSnapshot;
  onCommand: (command: string) => void;
}): JSX.Element {
  const provider = run?.provider ?? status.provider.backend ?? 'codex';
  const model = run?.model ?? status.provider.model ?? 'gpt-test';
  return (
    <section className="deepsea-inspector-section">
      <h3>代理运行 (Run)</h3>
      <div className="deepsea-run-card">
        <div className="deepsea-run-card__top">
          <span>
            <Brain aria-hidden="true" />
            <strong className="deepsea-mono">{formatProviderModel(provider, model)}</strong>
          </span>
          <span className="deepsea-run-state">
            <i />
            {run?.status ?? status.status}
          </span>
        </div>
        <div className="deepsea-run-card__bottom">
          <span>
            <ShieldCheck aria-hidden="true" />
            <strong className="deepsea-mono">{run ? formatDuration(run.started_at, run.completed_at ?? Date.now()) : '02:14:05'}</strong>
          </span>
          <div>
            <button type="button" aria-label="停止运行">
              <StopCircle aria-hidden="true" />
            </button>
            <button type="button" aria-label="重新执行" onClick={() => onCommand('/status')}>
              <Repeat2 aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ToolsModule({ rows }: { rows: Array<{ action: string; path: string; tone: string }> }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <div className="deepsea-module-title">
        <h3>工具调用 (Tools)</h3>
        <span>影响 {rows.length} 文件</span>
      </div>
      <div className="deepsea-tool-table">
        {rows.map((row, index) => (
          <div key={`${row.action}-${row.path}-${index}`} data-tone={row.tone}>
            <span>{index + 1}</span>
            <strong>{row.action}</strong>
            <p>{row.path}</p>
            {row.tone === 'warn' ? <span>...</span> : <Check aria-hidden="true" />}
          </div>
        ))}
      </div>
    </section>
  );
}

function PlanModule({ items }: { items: SessionPlanItem[] }): JSX.Element {
  const planItems = items.length > 0 ? items : [
    { id: 'mock-1', title: '分析当前会话页面结构', status: 'completed' },
    { id: 'mock-2', title: '还原 Deepsea 三栏布局', status: 'in_progress' },
    { id: 'mock-3', title: '运行浏览器 smoke test', status: 'pending' },
  ];
  return (
    <section className="deepsea-inspector-section">
      <h3>会话计划 (Plan)</h3>
      <div className="deepsea-plan-list">
        {planItems.map((item) => (
          <div data-status={item.status} key={item.id}>
            {item.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : item.status === 'in_progress' ? <Circle aria-hidden="true" /> : <Square aria-hidden="true" />}
            <span>{item.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiffModule({ rows }: { rows: Array<{ path: string; delta: string; tone: string }> }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <h3>待提交变更 (Diffs)</h3>
      <div className="deepsea-diff-card">
        {rows.map((row) => (
          <div key={row.path}>
            <span>{row.path}</span>
            <strong data-tone={row.tone}>{row.delta}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function getActiveRun(detail: SessionDetail): SessionRun | null {
  return [...detail.runs].reverse().find((run) =>
    run.status === 'queued' || run.status === 'running' || run.status === 'retrying'
  ) ?? detail.runs[detail.runs.length - 1] ?? null;
}

function contextPressurePercent(pressure: StatusSnapshot['context']['pressure']): number {
  if (pressure === 'high') return 78;
  if (pressure === 'medium') return 52;
  return 28;
}

function formatProviderModel(provider: string, model: string): string {
  if (provider === 'claude') return model.includes('Claude') ? model : `Claude ${model}`;
  if (provider === 'codex') return model.includes('gpt') ? model : `Codex ${model}`;
  return `${provider} ${model}`;
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    brainstorming: '头脑风暴',
    planning: '规划',
    implementing: '开发中',
    reviewing: '审查',
    verifying: '验证',
    completed: '完成',
  };
  return labels[phase] ?? phase;
}

function historyStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    archived: '已归档',
    completed: '已完成',
    blocked: '阻塞',
    failed: '失败',
  };
  return labels[status] ?? status;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatTimeRange(start: number, end: number): string {
  const startLabel = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(start));
  const endLabel = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(end));
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  return `${startLabel} - ${endLabel} | ${minutes}m`;
}

function formatDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

function collectToolRows(evidence: SessionEvidenceEvent[]): Array<{ action: string; path: string; tone: string }> {
  const rows = evidence
    .filter((event) => event.event_type === 'tool_call' || event.event_type === 'file_read' || event.event_type === 'test' || event.event_type === 'build')
    .slice(-6)
    .map((event) => ({
      action: event.event_type === 'test' || event.event_type === 'build' ? 'EXEC' : event.event_type === 'file_read' ? 'READ' : 'TOOL',
      path: String(event.payload.path ?? event.payload.command ?? event.summary ?? event.title),
      tone: event.severity === 'warning' ? 'warn' : event.severity === 'error' || event.severity === 'critical' ? 'danger' : 'primary',
    }));
  return rows.length > 0 ? rows : fallbackTools;
}

function collectDiffRows(
  evidence: SessionEvidenceEvent[],
  status: StatusSnapshot,
): Array<{ path: string; delta: string; tone: string }> {
  const rows = evidence
    .filter((event) => event.event_type === 'file_diff')
    .slice(-5)
    .map((event) => ({
      path: String(event.payload.path ?? event.title),
      delta: String(event.payload.delta ?? '+1'),
      tone: String(event.payload.delta ?? '+').startsWith('-') ? 'danger' : 'ok',
    }));
  if (rows.length > 0) return rows;
  if (status.git.changedFileCount > 0) return fallbackDiffs.slice(0, Math.min(status.git.changedFileCount, fallbackDiffs.length));
  return [{ path: 'working tree clean', delta: '0', tone: 'muted' }];
}
