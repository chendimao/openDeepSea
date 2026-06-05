import {
  AlertTriangle,
  AtSign,
  Bell,
  Brain,
  Bot,
  CheckCircle2,
  ChevronDown,
  FileText,
  Filter,
  GitFork,
  Hash,
  History,
  MessageSquare,
  MessageCircle,
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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type {
  HistoryRecord,
  HistoryRecordStatus,
  Session,
  SessionDetail,
  SessionEvidenceEvent,
  SessionMessage,
  SessionMode,
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
  { path: 'retry_handler.py', delta: '+34', tone: 'ok' },
  { path: 'sync_service.py', delta: '+8', tone: 'ok' },
];

const projectSwitcherCards = [
  {
    name: 'deepsea-command-center',
    path: '~/workspaces/deepsea-command-center',
    active: true,
    sessions: [
      ['优化数据同步模块...', '10:22'],
      ['修复用户权限校验...', '昨天'],
      ['重构 UI 组件库...', '2天前'],
    ],
  },
  {
    name: 'quantum-core-engine',
    path: '~/workspaces/quantum-core',
    active: false,
    sessions: [
      ['核心引擎性能调优', '3天前'],
      ['更新依赖版本', '上周'],
    ],
  },
  {
    name: 'nebula-ui-kit',
    path: '~/design/nebula-ui',
    active: false,
    sessions: [
      ['添加深色模式支持', '1个月前'],
    ],
  },
];

export function SessionShellView({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onFilterHistory,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onFilterHistory?: (filters: { q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }) => void;
}): JSX.Element {
  const activeRun = getActiveRun(payload.activeSession);
  const recentHistory = payload.historyRecords.slice(0, 12);
  const forkTarget = payload.historyRecords[0]?.id;

  return (
    <section className="session-shell deepsea-shell" aria-label="Session Operations Console">
      <TopCommandBar
        payload={payload}
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
      <BottomStatusBar />
    </section>
  );
}

function TopCommandBar({
  payload,
  onCommand,
  forkTarget,
}: {
  payload: SessionWorkspacePayload;
  onCommand: (command: string) => void;
  forkTarget?: string;
}): JSX.Element {
  const pressure = contextPressurePercent(payload.status.context.pressure);
  const activeProjectName = 'deepsea-command-center';
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);

  return (
    <>
      <header className="deepsea-topbar">
        <div className="deepsea-topbar__identity">
          <div className="deepsea-brand">
            <span className="deepsea-brand__mark">
              <img alt="蟹老板 AI 指挥官 Logo" src="/deepsea-krabs-logo.jpg" />
            </span>
            <span>深海指挥中心</span>
          </div>
          <nav className="deepsea-shell-nav" aria-label="项目首页菜单">
            <a href="/">
              <History aria-hidden="true" />
              <span>会话</span>
            </a>
            <a href="/chat">
              <MessageCircle aria-hidden="true" />
              <span>聊天</span>
            </a>
            <a href="/agents">
              <Bot aria-hidden="true" />
              <span>智能体</span>
            </a>
            <a href="/skills">
              <ShieldCheck aria-hidden="true" />
              <span>技能</span>
            </a>
            <a href="/files">
              <FileText aria-hidden="true" />
              <span>资源</span>
            </a>
          </nav>
        </div>

        <div className="deepsea-topbar__actions">
          <div className="deepsea-action-icons">
            <button type="button" className="deepsea-icon-button" aria-label="设置">
              <Settings aria-hidden="true" />
            </button>
            <button type="button" className="deepsea-icon-button deepsea-icon-button--alert" aria-label="通知">
              <Bell aria-hidden="true" />
              <span />
            </button>
          </div>
          <img alt="Profile" className="deepsea-avatar" src="/deepsea-profile-avatar.png" />
        </div>
      </header>

      <div className="deepsea-project-strip" aria-label="Project command bar">
        <div className="deepsea-project-breadcrumb">
          <GitFork aria-hidden="true" />
          <span className="deepsea-mono">workspace</span>
          <ChevronDown aria-hidden="true" />
        </div>
        <div className="deepsea-project-switcher">
          <button
            type="button"
            aria-expanded={projectMenuOpen}
            aria-label="切换项目"
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <strong>{activeProjectName}</strong>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
        <div
          className="deepsea-project-menu"
          data-open={projectMenuOpen ? 'true' : undefined}
          role="dialog"
          aria-label="项目切换器"
          aria-hidden={projectMenuOpen ? undefined : true}
          onClick={() => setProjectMenuOpen(false)}
        >
          <div className="deepsea-project-menu__panel" onClick={(event) => event.stopPropagation()}>
            <div className="deepsea-project-menu__header">
              <div>
                <h2>项目切换器</h2>
                <p>选择一个工作区以继续您的任务</p>
              </div>
              <div>
                <label className="deepsea-project-menu__search">
                  <Search aria-hidden="true" />
                  <input type="search" placeholder="搜索项目..." />
                </label>
                <button type="button" aria-label="关闭项目切换器" onClick={() => setProjectMenuOpen(false)}>
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
            <div className="deepsea-project-menu__body">
              <div className="deepsea-project-grid">
                {projectSwitcherCards.map((project) => (
                  <article className="deepsea-project-card" data-active={project.active ? 'true' : undefined} key={project.name}>
                    {project.active && (
                      <div className="deepsea-project-card__active">
                        <i />
                        <span>当前激活</span>
                      </div>
                    )}
                    <div className="deepsea-project-card__head">
                      <h3>{project.name}</h3>
                      <p className="deepsea-mono">{project.path}</p>
                    </div>
                    <div className="deepsea-project-card__sessions">
                      <span>最近会话</span>
                      {project.sessions.map(([title, time]) => (
                        <button type="button" key={`${project.name}-${title}`}>
                          <strong>{title}</strong>
                          <em>{time}</em>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
                <article className="deepsea-project-card deepsea-project-card--add">
                  <Plus aria-hidden="true" />
                  <span>新建项目</span>
                </article>
              </div>
            </div>
            <div className="deepsea-project-menu__footer">
              <button type="button">
                <Settings aria-hidden="true" />
                管理所有工作区
              </button>
            </div>
          </div>
        </div>
        <div className="deepsea-strip-actions">
          <div className="deepsea-command-group" aria-label="Session command actions">
            <CommandPill label="压缩" kbd="⌘P" icon={Minimize2} command="/compact" onCommand={onCommand} />
            <CommandPill
              label="分叉"
              kbd="⌘B"
              icon={GitFork}
              command={forkTarget ? `/fork history:${forkTarget}` : '/fork'}
              onCommand={onCommand}
            />
            <span className="deepsea-strip-divider" />
            <ContextPressure pressure={pressure} compact />
            <button type="button" className="deepsea-strip-settings" aria-label="工作区设置">
              <Settings aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function BottomStatusBar(): JSX.Element {
  return (
    <footer className="deepsea-bottom-status" aria-label="Session status bar">
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">系统健康状态</span>
        <span className="deepsea-status-dot" data-tone="ok" />
        <strong>良好</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">索引状态</span>
        <span className="deepsea-status-dot" data-tone="primary" />
        <strong>已建立</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <StopCircle aria-hidden="true" />
        <span className="deepsea-bottom-status__label">响应耗时</span>
        <strong>1.2s</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <ShieldCheck aria-hidden="true" />
        <span className="deepsea-bottom-status__label">错误率</span>
        <strong>0.0%</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <RefreshCcw aria-hidden="true" />
        <span className="deepsea-bottom-status__label">网络延迟</span>
        <strong>45ms</strong>
      </div>
      <div className="deepsea-bottom-status__spacer" />
      <div className="deepsea-bottom-status__group">
        <FileText aria-hidden="true" />
        <span className="deepsea-bottom-status__label">API 消耗</span>
        <strong>1,242 tokens</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <button type="button" className="deepsea-bottom-status__export">
        <FileText aria-hidden="true" />
        导出
      </button>
    </footer>
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
  icon: LucideIcon;
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

function ContextPressure({ pressure, compact = false }: { pressure: number; compact?: boolean }): JSX.Element {
  const active = Math.max(1, Math.round(pressure / 10));
  return (
    <div className="deepsea-pressure" data-compact={compact ? 'true' : undefined} aria-label="上下文压力">
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
        <button type="button" className="deepsea-primary-button" data-command="/new" onClick={() => onCommand('/new')}>
          <Plus aria-hidden="true" />
          新建会话
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

        {detail.runs.slice(-1).map((run) => (
          <article className="deepsea-run-log" key={run.id}>
            <div>
              <span className="deepsea-status-chip" data-tone={run.status === 'failed' ? 'danger' : 'ok'}>ASSISTANT</span>
              <time className="deepsea-mono">{formatClock(run.started_at)}</time>
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
            <span>
              <strong>证据摘要</strong>
              <em>{evidence.length} 条记录，最近为 {evidenceTypeLabel(evidence[evidence.length - 1].event_type)}</em>
            </span>
          </div>
          <ChevronDown aria-hidden="true" />
        </div>
      )}
    </article>
  );
}

function DeepseaComposer({
  onSendMessage,
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
      <div className="deepsea-composer__field">
        <input
          aria-label="命令输入"
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          placeholder="输入命令或 / 选择命令，支持 @ 文件、# 历史、! 上下文"
        />
        <div className="deepsea-composer__tools">
          <AtSign aria-hidden="true" />
          <Hash aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <button type="submit" className="deepsea-send-button" aria-label="发送">
            <SendHorizontal aria-hidden="true" />
          </button>
        </div>
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
        {['状态', '契约', '运行', '工具', '计划'].map((tab) => (
          <button type="button" key={tab}>
            {tab}
          </button>
        ))}
      </div>
      <div className="deepsea-inspector__scroll">
        <ContractModule session={session} />
        <PlanModule items={payload.activeSession.planItems} />
        <RunModule run={activeRun} status={payload.status} onCommand={onCommand} />
        <ToolsModule rows={tools} />
        <DiffModule rows={diffs} onCommand={onCommand} />
      </div>
    </aside>
  );
}

function ContractModule({ session }: { session: Session }): JSX.Element {
  return (
    <section className="deepsea-glass-card">
      <div className="deepsea-module-title">
        <h3>
          <FileText aria-hidden="true" />
          目标契约 (Contract)
        </h3>
        <button type="button">编辑</button>
      </div>
      <div className="deepsea-contract-list">
        <div>
          <span>目标 (Objective)</span>
          <p>{session.current_goal ?? session.title}</p>
        </div>
        <div>
          <span>边界 (Scope)</span>
          <p>仅修改 <code className="deepsea-inline-code">sync/</code> 目录，保持现有接口协议不变</p>
        </div>
        <div>
          <span>风险 (Risks)</span>
          <p><i /> 重试逻辑可能导致重复写入，需要幂等性保证</p>
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
  const runLabel = run?.status ?? status.status;
  return (
    <section className="deepsea-inspector-section deepsea-run-section">
      <h3>代理运行 (Active Run)</h3>
      <div className="deepsea-run-card">
        <div className="deepsea-run-card__top">
          <div className="deepsea-run-card__agent">
            <span>
              <Brain aria-hidden="true" />
            </span>
            <div>
              <strong className="deepsea-mono">{formatProviderModel(provider, model)}</strong>
              <em>
                <i />
                {runLabel}
              </em>
            </div>
          </div>
          <div className="deepsea-run-card__time">
            <strong className="deepsea-mono">{run ? formatDuration(run.started_at, run.completed_at ?? Date.now()) : '02:14:05'}</strong>
            <span>运行耗时</span>
          </div>
        </div>
        <div className="deepsea-run-card__actions">
          <button type="button" aria-label="停止运行">
            <StopCircle aria-hidden="true" />
            停止
          </button>
          <button type="button" aria-label="重新执行" onClick={() => onCommand('/status')}>
            <Repeat2 aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    </section>
  );
}

function ToolsModule({ rows }: { rows: Array<{ action: string; path: string; tone: string }> }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <div className="deepsea-module-title">
        <h3>工具调用 (TOOLS)</h3>
        <span>耗时 24.3s | {rows.length} 文件</span>
      </div>
      <div className="deepsea-tool-table">
        {rows.map((row, index) => (
          <div key={`${row.action}-${row.path}-${index}`} data-tone={row.tone}>
            <span>{index + 1}</span>
            <strong>{toolActionLabel(row.action)}</strong>
            <p>{row.path}</p>
            <span>{index === 0 ? '2.1s' : index === 1 ? '3.4s' : '18.8s'}</span>
            {row.tone === 'warn' ? <span>...</span> : <CheckCircle2 aria-hidden="true" />}
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
      <h3>会话计划 (Session Plan)</h3>
      <div className="deepsea-plan-list">
        {planItems.map((item) => (
          <div data-status={item.status} key={item.id}>
            {item.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <Square aria-hidden="true" />}
            <span>{item.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiffModule({
  rows,
  onCommand,
}: {
  rows: Array<{ path: string; delta: string; tone: string }>;
  onCommand: (command: string) => void;
}): JSX.Element {
  return (
    <section className="deepsea-diff-alert">
      <div className="deepsea-diff-alert__header">
        <h3>
          <AlertTriangle aria-hidden="true" />
          待提交变更
        </h3>
        <span>UNCOMMITTED</span>
      </div>
      <div className="deepsea-diff-card">
        {rows.map((row) => (
          <div key={row.path}>
            <span>
              <FileText aria-hidden="true" />
              <em>{row.path}</em>
            </span>
            <strong data-tone={row.tone}>{row.delta}</strong>
          </div>
        ))}
      </div>
      <div className="deepsea-diff-alert__footer">
        <p>存在未应用的 Compact 预览，Fork 可能丢失上下文</p>
        <div>
          <button type="button" onClick={() => onCommand('/compact')}>
            查看预览
            <ChevronDown aria-hidden="true" />
          </button>
          <button type="button" onClick={() => onCommand('/compact')}>
            立即应用
          </button>
        </div>
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

function toolActionLabel(action: string): string {
  const normalized = action.toUpperCase();
  if (normalized === 'READ') return '读取文件';
  if (normalized === 'EXEC') return '执行命令';
  return '工具调用';
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
