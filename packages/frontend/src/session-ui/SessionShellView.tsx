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
import React, { useState } from 'react';
import type {
  HistoryRecord,
  HistoryRecordStatus,
  Session,
  SessionBottomStatus,
  SessionContract,
  SessionDetail,
  SessionDiffRow,
  SessionEvidenceEvent,
  SessionMessage,
  SessionMode,
  SessionPlanItem,
  SessionRun,
  SessionToolRow,
  SessionWorkspacePayload,
  StatusSnapshot,
} from '../lib/types';
import { sessionStatusTone } from './session-ui-model';

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
          onFilterHistory={onFilterHistory}
        />
        <TranscriptCanvas
          detail={payload.activeSession}
          evidence={payload.evidence}
          onSendMessage={onSendMessage}
          onCommand={onCommand}
        />
        <IntegratedInspector
          payload={payload}
          activeRun={activeRun}
          onCommand={onCommand}
          onCancelRun={onCancelRun}
          onRetryRun={onRetryRun}
          onSaveContract={onSaveContract}
        />
      </main>
      <BottomStatusBar status={payload.bottomStatus} />
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
  const activeProjectName = payload.project.name;
  const projects = payload.projectSwitcher.projects;
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
                {projects.map((project) => (
                  <article className="deepsea-project-card" data-active={project.active ? 'true' : undefined} key={project.id}>
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
                      {project.recentSessions.length === 0 ? (
                        <em>暂无会话</em>
                      ) : project.recentSessions.map((session) => (
                        <button
                          type="button"
                          key={`${project.id}-${session.source}-${session.id}`}
                          onClick={() => {
                            if (typeof window !== 'undefined') window.location.assign(session.href);
                          }}
                        >
                          <strong>{session.title}</strong>
                          <em>{formatRelativeTime(Date.now(), session.updated_at)}</em>
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

function BottomStatusBar({ status }: { status: SessionBottomStatus }): JSX.Element {
  return (
    <footer className="deepsea-bottom-status" aria-label="Session status bar">
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">系统健康状态</span>
        <span className="deepsea-status-dot" data-tone={healthTone(status.health)} />
        <strong>{status.healthLabel}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">索引状态</span>
        <span className="deepsea-status-dot" data-tone={status.indexStatus === 'ready' ? 'primary' : 'warn'} />
        <strong>{status.indexLabel}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <StopCircle aria-hidden="true" />
        <span className="deepsea-bottom-status__label">响应耗时</span>
        <strong>{formatResponseTime(status.lastResponseMs)}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <ShieldCheck aria-hidden="true" />
        <span className="deepsea-bottom-status__label">错误率</span>
        <strong>{formatErrorRate(status.errorRate)}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <RefreshCcw aria-hidden="true" />
        <span className="deepsea-bottom-status__label">网络延迟</span>
        <strong>{status.networkLatencyMs === null ? '--' : `${status.networkLatencyMs}ms`}</strong>
      </div>
      <div className="deepsea-bottom-status__spacer" />
      <div className="deepsea-bottom-status__group">
        <FileText aria-hidden="true" />
        <span className="deepsea-bottom-status__label">API 消耗</span>
        <strong>{status.tokenUsage ? `${status.tokenUsage.total.toLocaleString()} tokens` : '--'}</strong>
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
  onFilterHistory,
}: {
  records: HistoryRecord[];
  activeSession: Session;
  onCommand: (command: string) => void;
  onFilterHistory?: (filters: { q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
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
        <form
          className="deepsea-search"
          onSubmit={(event) => {
            event.preventDefault();
            onFilterHistory?.({ q, status: 'all', mode: 'all' });
          }}
        >
          <Search aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="搜索历史..."
          />
        </form>
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
  const latestRuns = detail.runs.slice(-1);
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
            key={message.id}
            message={message}
          />
        ))}

        {latestRuns.map((run) => {
          const runEvidence = evidence.filter((event) => event.source_run_id === run.id);
          return (
            <React.Fragment key={run.id}>
              <AgentThoughtPanel run={run} evidence={runEvidence} />
              <article className="deepsea-run-log">
                <div>
                  <span className="deepsea-status-chip" data-tone={run.status === 'failed' ? 'danger' : 'ok'}>ASSISTANT</span>
                  <time className="deepsea-mono">{formatClock(run.started_at)}</time>
                </div>
                <p>{runOutputText(run)}</p>
              </article>
            </React.Fragment>
          );
        })}
      </div>
      <DeepseaComposer onCommand={onCommand} onSendMessage={onSendMessage} />
    </section>
  );
}

function TranscriptMessage({
  message,
}: {
  message: SessionMessage;
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
    </article>
  );
}

function AgentThoughtPanel({
  run,
  evidence,
}: {
  run: SessionRun;
  evidence: SessionEvidenceEvent[];
}): JSX.Element | null {
  const thought = agentThoughtText(run, evidence);
  if (!thought) return null;
  const status = run.status === 'failed' ? 'RISK' : run.status === 'completed' ? 'VERIFIED' : 'RUNNING';
  return (
    <section className="deepsea-agent-thought" aria-label="智能体思考过程">
      <div className="deepsea-agent-thought__header">
        <span>
          <Brain aria-hidden="true" />
          <strong>智能体思考过程</strong>
          <em>Agent Thought Process</em>
        </span>
        <mark>{status}</mark>
      </div>
      <p>{thought}</p>
    </section>
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
  onCancelRun,
  onRetryRun,
  onSaveContract,
}: {
  payload: SessionWorkspacePayload;
  activeRun: SessionRun | null;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
}): JSX.Element {
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
        <ContractModule contract={payload.contract} onSaveContract={onSaveContract} />
        <PlanModule items={payload.activeSession.planItems} />
        <RunModule
          run={activeRun}
          status={payload.status}
          onCancelRun={onCancelRun}
          onRetryRun={onRetryRun}
        />
        <ToolsModule rows={payload.toolRows} />
        <DiffModule rows={payload.diffRows} onCommand={onCommand} />
      </div>
    </aside>
  );
}

function ContractModule({
  contract,
  onSaveContract,
}: {
  contract: SessionContract;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState(contract.scope ?? '');
  const [risks, setRisks] = useState(contract.risks.join('\n'));
  const [criteria, setCriteria] = useState(contract.acceptanceCriteria.join('\n'));
  const save = () => {
    onSaveContract?.({
      scope: scope.trim() || null,
      risks: splitLines(risks),
      acceptanceCriteria: splitLines(criteria),
    });
    setEditing(false);
  };

  return (
    <section className="deepsea-glass-card">
      <div className="deepsea-module-title">
        <h3>
          <FileText aria-hidden="true" />
          目标契约 (Contract)
        </h3>
        {editing ? (
          <button type="button" onClick={save}>保存</button>
        ) : (
          <button type="button" onClick={() => setEditing(true)}>编辑</button>
        )}
      </div>
      <div className="deepsea-contract-list">
        <div>
          <span>目标 (Objective)</span>
          <p>{contract.objective}</p>
        </div>
        <div>
          <span>边界 (Scope)</span>
          {editing ? (
            <textarea value={scope} onChange={(event) => setScope(event.currentTarget.value)} />
          ) : (
            <p>{contract.scope ?? '未设置范围'}</p>
          )}
        </div>
        <div>
          <span>风险 (Risks)</span>
          {editing ? (
            <textarea value={risks} onChange={(event) => setRisks(event.currentTarget.value)} />
          ) : contract.risks.length === 0 ? (
            <p><i /> 暂无风险记录</p>
          ) : (
            contract.risks.map((risk) => <p key={risk}><i /> {risk}</p>)
          )}
        </div>
        <div>
          <span>验收 (Acceptance)</span>
          {editing ? (
            <textarea value={criteria} onChange={(event) => setCriteria(event.currentTarget.value)} />
          ) : contract.acceptanceCriteria.length === 0 ? (
            <p>暂无验收标准</p>
          ) : (
            contract.acceptanceCriteria.map((item) => <p key={item}>{item}</p>)
          )}
        </div>
      </div>
    </section>
  );
}

function RunModule({
  run,
  status,
  onCancelRun,
  onRetryRun,
}: {
  run: SessionRun | null;
  status: StatusSnapshot;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
}): JSX.Element {
  const provider = run?.provider ?? status.provider.backend ?? 'codex';
  const model = run?.model ?? status.provider.model ?? 'gpt-test';
  const runLabel = run?.status ?? status.status;
  const cancellable = Boolean(run && (run.status === 'queued' || run.status === 'running' || run.status === 'retrying'));
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
          <button
            type="button"
            aria-label="停止运行"
            disabled={!cancellable}
            onClick={() => run && onCancelRun?.(run.id)}
          >
            <StopCircle aria-hidden="true" />
            停止
          </button>
          <button type="button" aria-label="重新执行" disabled={!run} onClick={() => run && onRetryRun?.(run.id)}>
            <Repeat2 aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    </section>
  );
}

function runOutputText(run: SessionRun): string {
  const output = run.stdout.trim() || run.stderr.trim();
  if (output) return output;
  if (run.status === 'completed') return '未返回可展示回复。';
  if (run.status === 'failed') return run.error ?? '运行失败，暂无错误详情。';
  return '等待智能体输出...';
}

function agentThoughtText(run: SessionRun, evidence: SessionEvidenceEvent[]): string | null {
  const activity = trimDisplayText(run.activity_log);
  if (activity) return activity;
  const evidenceText = evidence
    .map((event) => trimDisplayText(event.summary ?? event.title))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
  return evidenceText || null;
}

function trimDisplayText(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1200).trimEnd()}\n...`;
}

function ToolsModule({ rows }: { rows: SessionToolRow[] }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <div className="deepsea-module-title">
        <h3>工具调用 (TOOLS)</h3>
        <span>{rows.length} 条记录</span>
      </div>
      {rows.length === 0 ? (
        <div className="deepsea-empty">暂无工具调用</div>
      ) : (
      <div className="deepsea-tool-table">
        {rows.map((row, index) => (
          <div key={row.id} data-tone={toolRowTone(row)}>
            <span>{index + 1}</span>
            <strong>{toolActionLabel(row.action)}</strong>
            <p>{row.target}</p>
            <span>{row.durationMs === null ? '--' : `${(row.durationMs / 1000).toFixed(1)}s`}</span>
            {row.status === 'running' ? <span>...</span> : <CheckCircle2 aria-hidden="true" />}
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

function PlanModule({ items }: { items: SessionPlanItem[] }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <h3>会话计划 (Session Plan)</h3>
      {items.length === 0 ? (
        <div className="deepsea-empty">暂无会话计划</div>
      ) : (
      <div className="deepsea-plan-list">
        {items.map((item) => (
          <div data-status={item.status} key={item.id}>
            {item.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <Square aria-hidden="true" />}
            <span>{item.title}</span>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

function DiffModule({
  rows,
  onCommand,
}: {
  rows: SessionDiffRow[];
  onCommand: (command: string) => void;
}): JSX.Element {
  const changedLabel = rows.length === 0 ? '工作区干净' : `${rows.length} 文件已修改`;
  return (
    <section className="deepsea-diff-alert">
      <div className="deepsea-diff-alert__header">
        <h3>待提交变更 <span>(Uncommitted)</span></h3>
        <span data-tone={rows.length === 0 ? 'muted' : 'danger'}>{changedLabel}</span>
      </div>
      <div className="deepsea-diff-card">
        {rows.length === 0 ? (
          <div className="deepsea-diff-row">
            <span className="deepsea-diff-row__index">0</span>
            <span className="deepsea-diff-row__file">
              <FileText aria-hidden="true" />
              <em>working tree clean</em>
            </span>
            <span className="deepsea-diff-row__status" data-tone="muted">
              <strong data-tone="muted">0</strong>
              <CheckCircle2 aria-hidden="true" />
            </span>
          </div>
        ) : rows.map((row, index) => (
          <div className="deepsea-diff-row" key={row.path}>
            <span className="deepsea-diff-row__index">{index + 1}</span>
            <span className="deepsea-diff-row__file">
              <FileText aria-hidden="true" />
              <em>{row.path}</em>
            </span>
            <span className="deepsea-diff-row__status" data-tone={diffRowTone(row)}>
              <strong data-tone={diffRowTone(row)}>{formatDiffDelta(row)}</strong>
              <CheckCircle2 aria-hidden="true" />
            </span>
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

function toolActionLabel(action: string): string {
  const normalized = action.toUpperCase();
  if (normalized === 'READ') return '读取文件';
  if (normalized === 'EDIT') return '文件变更';
  if (normalized === 'WRITE') return '写入文件';
  if (normalized === 'BROWSER') return '浏览器验证';
  if (normalized === 'EXEC') return '执行命令';
  return '工具调用';
}

function formatRelativeTime(now: number, timestamp: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function healthTone(health: SessionBottomStatus['health']): 'ok' | 'warn' | 'danger' {
  if (health === 'error') return 'danger';
  if (health === 'warning') return 'warn';
  return 'ok';
}

function formatResponseTime(value: number | null): string {
  return value === null ? '--' : `${(value / 1000).toFixed(1)}s`;
}

function formatErrorRate(value: number | null): string {
  return value === null ? '--' : `${(value * 100).toFixed(1)}%`;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function toolRowTone(row: SessionToolRow): 'primary' | 'warn' | 'danger' | 'ok' {
  if (row.status === 'failed' || row.severity === 'error' || row.severity === 'critical') return 'danger';
  if (row.status === 'running' || row.severity === 'warning') return 'warn';
  return row.action === 'edit' || row.action === 'write' ? 'ok' : 'primary';
}

function diffRowTone(row: SessionDiffRow): 'ok' | 'danger' | 'warn' | 'muted' {
  if (row.status === 'deleted' || row.status === 'conflicted') return 'danger';
  if (row.status === 'renamed') return 'warn';
  if (row.status === 'modified' || row.status === 'added' || row.status === 'untracked') return 'ok';
  return 'muted';
}

function formatDiffDelta(row: SessionDiffRow): string {
  const additions = row.additions ?? 0;
  const deletions = row.deletions ?? 0;
  if (additions === 0 && deletions === 0) return row.summary ?? row.status;
  if (additions > 0 && deletions === 0) return `+${additions}`;
  if (additions === 0 && deletions > 0) return `-${deletions}`;
  return `+${additions} / -${deletions}`;
}
