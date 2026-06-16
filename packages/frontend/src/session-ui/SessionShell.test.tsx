import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActiveSessionSummary, ProjectUsedAgentsPayload, SessionAgentEvent, SessionMessage, SessionWorkspacePayload } from '../lib/types';
import { I18nProvider } from '../lib/i18n';
import {
  SessionShellView,
  SESSION_SIDEBAR_PREFS_STORAGE_KEY,
  buildProjectReorderInput,
  buildSessionKnowledgeActionKey,
  buildSessionSidebarModel,
  buildTranscriptFollowKey,
  buildSessionRunTranscriptItems,
  buildVisualCompanionAcceptanceSubmit,
  getLatestUserMessageKey,
  getSessionRunThinkingDuration,
  isSessionInspectorVisibleForWorkspacePane,
  isTranscriptNearBottom,
  readSessionSidebarPrefs,
  recordVisualCompanionOfferAccepted,
  shouldShowVisualCompanionAction,
  shouldIgnoreProjectDragStart,
  sortSessionsForSidebar,
  syncExpandedProjectIds,
  writeSessionSidebarPrefs,
  type SessionKnowledgeActionKey,
  type SessionKnowledgeSaveInput,
} from './SessionShellView';

const sessionOsCss = readFileSync(new URL('./session-os.css', import.meta.url), 'utf8');
const sessionShellViewSource = readFileSync(new URL('./SessionShellView.tsx', import.meta.url), 'utf8');
const localStorageValues = new Map<string, string>();

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    },
    clear: () => {
      localStorageValues.clear();
    },
  },
  configurable: true,
});

test('SessionShell renders Deepsea command center modules', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /Session Operations Console/);
  assert.match(html, /项目智能体/);
  assert.match(html, /设置会话规划智能体/);
  assert.match(html, /workspace/);
  assert.match(html, /OpenClaw/);
  assert.doesNotMatch(html, /Project command bar/);
  assert.doesNotMatch(html, /切换项目/);
  assert.doesNotMatch(html, /项目切换器/);
  assert.doesNotMatch(html, /选择一个工作区以继续您的任务/);
  assert.doesNotMatch(html, /deepsea-command-center/);
  assert.doesNotMatch(html, /quantum-core-engine/);
  assert.doesNotMatch(html, /nebula-ui-kit/);
  assert.doesNotMatch(html, /retry_handler\.py/);
  assert.doesNotMatch(html, /sync_service\.py/);
  assert.doesNotMatch(html, /1,242 tokens/);
  assert.doesNotMatch(html, /分析当前会话页面结构/);
  assert.doesNotMatch(html, /还原 Deepsea 三栏布局/);
  assert.doesNotMatch(html, /运行浏览器 smoke test/);
  assert.doesNotMatch(html, /当前激活/);
  assert.doesNotMatch(html, /deepsea-project-card--add/);
  assert.doesNotMatch(html, /管理所有工作区/);
  assert.match(html, /上下文压力/);
  assert.match(html, /Session status bar/);
  assert.doesNotMatch(html, /系统健康状态/);
  assert.doesNotMatch(html, /索引状态/);
  assert.match(html, /新建会话/);
  assert.doesNotMatch(html, /新建聊天/);
  assert.doesNotMatch(html, /deepsea-project-chat-section/);
  assert.doesNotMatch(html, /暂无聊天/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /Project Sessions/);
  assert.doesNotMatch(html, /接口联调/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /会话历史/);
  assert.match(html, /对话记录/);
  assert.match(html, /会话中间工作区/);
  assert.match(html, /文件浏览器/);
  assert.doesNotMatch(html, /prompt-area-container/);
  assert.match(html, /data-session-composer-textarea="true"/);
  assert.match(html, /粘贴文件会上传到项目文件库/);
  assert.match(html, /目标契约/);
  assert.match(html, /原因 \(Reason\)/);
  assert.match(html, /用户描述了 active runs 删除失败/);
  assert.match(html, /会话计划/);
  assert.match(html, /代理运行/);
  assert.match(html, /工具调用/);
  assert.match(html, /本次会话变更/);
  assert.match(html, /Session Changes/);
  assert.match(html, /本会话 1 个文件变更/);
  assert.match(html, /\+12 \/ -3/);
  assert.match(html, /立即应用/);
  assert.match(html, /data-command="\/compact"/);
  assert.match(html, /\/fork history:history-1/);
  assert.match(html, /Project Sessions/);
  assert.doesNotMatch(html, /task-workspace/);
  assert.doesNotMatch(html, /Deepsea Command/);
  assert.doesNotMatch(html, /deepsea-model-status/);
  assert.doesNotMatch(html, /当前状态/);
});

test('SessionShell renders current session token usage in the bottom status bar', () => {
  const payload = createPayload();
  payload.bottomStatus.tokenUsage = {
    input: 10_000,
    output: 2_345,
    total: 12_345,
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Token 消耗/);
  assert.match(html, /12,345 tokens/);
  assert.doesNotMatch(html, /API 消耗/);
});

test('SessionShell renders current session todo count beside the session title', () => {
  const payload = createPayload();
  payload.activeSession.planItems = [
    {
      id: 'plan-1',
      session_id: 'session-1',
      parent_id: null,
      title: '接入待办统计 API',
      description: null,
      status: 'pending',
      priority: 1,
      source: 'plan',
      evidence_event_id: null,
      created_at: Date.now() - 30_000,
      updated_at: Date.now() - 20_000,
      completed_at: null,
    },
    {
      id: 'plan-2',
      session_id: 'session-1',
      parent_id: null,
      title: '渲染标题徽标',
      description: null,
      status: 'in_progress',
      priority: 2,
      source: 'plan',
      evidence_event_id: null,
      created_at: Date.now() - 20_000,
      updated_at: Date.now() - 10_000,
      completed_at: null,
    },
    {
      id: 'plan-3',
      session_id: 'session-1',
      parent_id: null,
      title: '完成旧计划',
      description: null,
      status: 'completed',
      priority: 3,
      source: 'plan',
      evidence_event_id: null,
      created_at: Date.now() - 10_000,
      updated_at: Date.now() - 5_000,
      completed_at: Date.now() - 5_000,
    },
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /SessionOS 迁移/);
  assert.match(html, /data-session-todo-count="true"/);
  assert.match(html, /aria-label="当前会话待办数量：2"/);
  assert.match(html, /待办 <strong>2<\/strong>/);
});

test('SessionShell renders workflow spec and plan gates as read-only artifacts', () => {
  const payload = createPayload();
  payload.activeSession.workflowArtifacts = [
    {
      id: 'artifact-plan-1',
      workflow_run_id: 'workflow-run-1',
      artifact_type: 'plan',
      version: 1,
      status: 'reviewing',
      title: 'Planner 控制的执行计划',
      content: '只读计划\n\n1. 由 planner 分配任务\n2. 用户确认后执行',
      structured_data: null,
      created_by_agent_id: 'planner',
      change_request_message_id: null,
      approved_by: null,
      approved_at: null,
      created_at: Date.now(),
    },
  ];
  payload.activeSession.workflowGates = [{
    kind: 'plan_confirm',
    workflow_run_id: 'workflow-run-1',
    artifact_version_id: 'artifact-plan-1',
    status: 'pending',
    reason: '执行前必须确认 plan 版本',
  }];

  const html = renderSessionShell(payload);
  const workflowMessageIndex = html.indexOf('data-workflow-chat-message="true"');
  const composerIndex = html.indexOf('deepsea-composer-anchor');
  const workflowMessageArea = html.slice(workflowMessageIndex, composerIndex);

  assert.match(html, /Plan v1/);
  assert.match(html, /data-workflow-chat-message="true"/);
  assert.match(html, /执行前必须确认 plan 版本/);
  assert.match(html, /请求修改/);
  assert.match(html, /确认/);
  assert.doesNotMatch(workflowMessageArea, /<textarea\b/);
  assert.match(sessionShellViewSource, /workflowArtifactChangeRequest:\s*\{/);
  assert.match(sessionShellViewSource, /workflowRunId:\s*artifact\.workflow_run_id/);
  assert.match(sessionShellViewSource, /artifactVersionId:\s*artifact\.id/);
});

test('SessionShell renders workflow spec approval action', () => {
  const payload = createPayload();
  payload.activeSession.workflowArtifacts = [
    {
      id: 'artifact-spec-1',
      workflow_run_id: 'workflow-run-spec-1',
      artifact_type: 'spec',
      version: 1,
      status: 'draft',
      title: '项目删除修复规格',
      content: '确认删除项目前停止 active runs。',
      structured_data: null,
      created_by_agent_id: 'planner',
      change_request_message_id: null,
      approved_by: null,
      approved_at: null,
      created_at: Date.now(),
    },
  ];
  payload.activeSession.workflowGates = [{
    kind: 'spec_confirm',
    workflow_run_id: 'workflow-run-spec-1',
    artifact_version_id: 'artifact-spec-1',
    status: 'pending',
    reason: '等待用户确认 planner 生成的需求/设计规格。',
  }];

  const html = renderSessionShell(payload);
  assert.match(html, /data-workflow-chat-message="true"/);
  assert.match(html, /等待用户确认/);
  assert.match(html, /Spec v1/);
  assert.match(html, /确认/);
  assert.match(html, /data-workflow-artifact-action="approve"/);
});

test('SessionShell renders workflow chat message with gate and agent summaries', () => {
  const payload = createPayload();
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-1',
    selected_intent: 'standard_development',
    active_stage: 'planning',
    controller: 'planner',
    blocker: null,
    next_action: '等待 plan gate',
  };
  payload.activeSession.workflowArtifacts = [{
    id: 'artifact-plan-1',
    workflow_run_id: 'workflow-run-1',
    artifact_type: 'plan',
    version: 1,
    status: 'reviewing',
    title: '实施计划',
    content: '# Plan\n\n- step',
    structured_data: null,
    created_by_agent_id: 'planner',
    change_request_message_id: null,
    approved_by: null,
    approved_at: null,
    created_at: Date.now(),
  }];
  payload.activeSession.workflowGates = [{
    kind: 'plan_confirm',
    workflow_run_id: 'workflow-run-1',
    artifact_version_id: 'artifact-plan-1',
    status: 'pending',
    reason: '需要用户确认',
  }];
  payload.activeSession.workflowAgentAssignments = [{
    task_id: 'task-1',
    task_title: '实现 Mission Strip',
    role: 'executor',
    execution_mode: 'serial',
    assigned_agent_id: 'agent-codex',
    assigned_agent_name: 'Codex',
    backend: 'codex',
    fallback_reason: null,
    scope_write: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
  }];

  const html = renderSessionShell(payload, { onApproveWorkflowArtifact: () => undefined });
  const workflowMessageIndex = html.indexOf('data-workflow-chat-message="true"');
  const transcriptScrollIndex = html.indexOf('data-transcript-scroll="true"');

  assert.match(html, /data-workflow-chat-message="true"/);
  assert.match(html, /规划师 \(Planner\)/);
  assert.match(html, /aria-label="展开当前对话中的全部可折叠内容"/);
  assert.match(html, /data-workflow-state-stream="true"/);
  assert.doesNotMatch(html, /data-workflow-view-toggle="true"/);
  assert.doesNotMatch(html, /data-session-workflow-map="mission"/);
  assert.doesNotMatch(html, /data-workflow-flow-root="true"/);
  assert.doesNotMatch(html, /flow-path-parallel/);
  assert.match(html, /等待 plan gate/);
  assert.match(html, /1 个门禁/);
  assert.match(html, /Codex/);
  assert.match(html, /data-card-tone="agent"/);
  assert.match(html, /data-card-tone="gate"/);
  assert.match(html, /deepsea-workflow-state-step/);
  assert.match(html, /data-workflow-state-stream="true"/);
  assert.match(html, /data-workflow-artifact-action="approve"/);
  assert.doesNotMatch(html, /data-workflow-mission-strip="true"/);
  assert.ok(workflowMessageIndex >= 0);
  assert.ok(workflowMessageIndex > transcriptScrollIndex);
});

test('SessionShell merges workflow events into a compact preview inside the transcript message', () => {
  const payload = createPayload();
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-merge-1',
    selected_intent: 'standard_development',
    active_stage: 'planning',
    controller: 'planner',
    next_action: '等待用户确认当前 workflow artifact。',
    blocker: null,
  };
  payload.activeSession.runs = [];
  payload.activeSession.agentEvents = [];
  payload.activeSession.messages = [
    ...payload.activeSession.messages,
    ...Array.from({ length: 6 }, (_, index): SessionMessage => ({
      id: `workflow-merge-${index + 1}`,
      session_id: payload.activeSession.session.id,
      role: 'assistant',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: `workflow event ${index + 1}: ${'merged content '.repeat(8)}${index + 1}`,
      message_type: 'system',
      status: 'completed',
      metadata: JSON.stringify({
        workflow_run_id: 'workflow-run-merge-1',
        event_type: `workflow_step_${index + 1}`,
      }),
      created_at: Date.now() + index,
    })),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /Execution Log 合并事件/);
  assert.match(html, /已合并前 5 条 workflow 事件/);
  assert.match(html, /workflow event 6:/);
  assert.doesNotMatch(html, /workflow event 5:/);
  assert.doesNotMatch(html, /workflow event 1:/);
  assert.doesNotMatch(html, /workflow event 1:.*workflow event 2:.*workflow event 3:.*workflow event 4:.*workflow event 5:.*workflow event 6:/s);
});

test('SessionShell renders workflow events as a compact one-line summary in flow mode', () => {
  const payload = createPayload();
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-compact-1',
    selected_intent: 'standard_development',
    active_stage: 'planning',
    controller: 'planner',
    blocker: null,
    next_action: '等待用户确认当前 workflow artifact。',
  };
  payload.activeSession.runs = [];
  payload.activeSession.agentEvents = [];
  payload.activeSession.messages = [
    ...payload.activeSession.messages,
    ...Array.from({ length: 3 }, (_, index): SessionMessage => ({
      id: `workflow-compact-${index + 1}`,
      session_id: payload.activeSession.session.id,
      role: 'assistant',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: `workflow event ${index + 1}: compact`,
      message_type: 'system',
      status: 'completed',
      metadata: JSON.stringify({
        workflow_run_id: 'workflow-run-compact-1',
        event_type: `workflow_step_${index + 1}`,
      }),
      created_at: Date.now() + index,
    })),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /data-compact="true"/);
  assert.match(html, /workflow event 3: compact/);
  assert.doesNotMatch(html, /workflow event 1: compact/);
  assert.doesNotMatch(html, /workflow event 2: compact/);
});

test('SessionShell renders workflow as a transcript message instead of a top mission panel', () => {
  const payload = createPayload();
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-chat-1',
    selected_intent: 'standard_development',
    active_stage: 'planning',
    controller: 'planner',
    blocker: null,
    next_action: '等待用户确认 plan artifact。',
  };
  payload.activeSession.workflowArtifacts = [{
    id: 'artifact-plan-chat-1',
    workflow_run_id: 'workflow-run-chat-1',
    artifact_type: 'plan',
    version: 1,
    status: 'reviewing',
    title: '实施计划',
    content: '# Plan',
    structured_data: null,
    created_by_agent_id: 'planner',
    change_request_message_id: null,
    approved_by: null,
    approved_at: null,
    created_at: Date.now(),
  }];
  payload.activeSession.workflowGates = [{
    kind: 'plan_confirm',
    workflow_run_id: 'workflow-run-chat-1',
    artifact_version_id: 'artifact-plan-chat-1',
    status: 'pending',
    reason: '等待用户确认 planner 生成的计划。',
  }];

  const html = renderSessionShell(payload, { onApproveWorkflowArtifact: () => undefined });
  const transcriptScrollIndex = html.indexOf('data-transcript-scroll="true"');
  const workflowMessageIndex = html.indexOf('data-workflow-chat-message="true"');

  assert.doesNotMatch(html, /data-workflow-mission-strip="true"/);
  assert.match(html, /data-workflow-chat-message="true"/);
  assert.match(html, /等待用户确认 plan artifact。/);
  assert.match(html, /data-workflow-artifact-action="approve"/);
  assert.ok(workflowMessageIndex > transcriptScrollIndex);
});

test('SessionShell merges consecutive workflow transcript messages into one workflow chat group', () => {
  const payload = createPayload();
  const now = Date.now();
  payload.activeSession.workflowController = null;
  payload.activeSession.workflowArtifacts = [];
  payload.activeSession.workflowGates = [];
  payload.activeSession.workflowAgentAssignments = [];
  payload.activeSession.runs = [];
  payload.activeSession.messages = [
    {
      id: 'msg-user-workflow-merge',
      session_id: payload.activeSession.session.id,
      role: 'user',
      sender_id: 'user',
      sender_name: 'User',
      content: '继续处理这个任务。',
      message_type: 'text',
      status: 'completed',
      metadata: null,
      created_at: now,
    },
    {
      id: 'msg-workflow-1',
      session_id: payload.activeSession.session.id,
      role: 'assistant',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: '子任务「实现前端界面和状态刷新」的 implementation 阶段已完成，进入 review。',
      message_type: 'text',
      status: 'completed',
      metadata: null,
      created_at: now + 1_000,
    },
    {
      id: 'msg-workflow-2',
      session_id: payload.activeSession.session.id,
      role: 'assistant',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: '产品经理检测到子任务「实现前端界面和状态刷新」异常：TDD evidence gate requires records。',
      message_type: 'text',
      status: 'completed',
      metadata: null,
      created_at: now + 2_000,
    },
  ];

  const html = renderSessionShell(payload);

  assert.equal((html.match(/data-workflow-chat-message="true"/g) ?? []).length, 1);
  assert.match(html, /2 条工作流事件/);
  assert.match(html, /data-compact="true"/);
  assert.doesNotMatch(html, /implementation 阶段已完成/);
  assert.match(html, /TDD evidence gate requires records/);
  assert.doesNotMatch(html, /data-workflow-mission-strip="true"/);
});

test('SessionShell only attaches live workflow state to the latest workflow chat group', () => {
  const payload = createPayload();
  const now = Date.now();
  payload.activeSession.runs = [];
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-current',
    selected_intent: 'standard_development',
    active_stage: 'agent_assignment',
    controller: 'worker',
    blocker: '等待人工处理。',
    next_action: '等待人工处理。',
  };
  payload.activeSession.workflowAgentAssignments = [
    {
      task_id: 'task-current',
      task_title: '实现当前流程',
      role: 'executor',
      execution_mode: 'parallel',
      assigned_agent_id: 'agent-current',
      assigned_agent_name: '当前执行者',
      backend: 'codex',
      fallback_reason: null,
      scope_write: ['packages/backend/src/repos/projects.ts'],
    },
  ];
  payload.activeSession.messages = [
    {
      id: 'msg-user-before-workflow',
      session_id: payload.activeSession.session.id,
      role: 'user',
      sender_id: 'user',
      sender_name: 'User',
      content: '开始处理。',
      message_type: 'text',
      status: 'completed',
      metadata: null,
      created_at: now,
    },
    {
      id: 'msg-workflow-old',
      session_id: payload.activeSession.session.id,
      role: 'system',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: '工作流已启动，进入 planning 阶段。',
      message_type: 'text',
      status: 'completed',
      metadata: JSON.stringify({ event_type: 'workflow_started', workflow_run_id: 'workflow-run-current' }),
      created_at: now + 1_000,
    },
    {
      id: 'msg-user-change-request',
      session_id: payload.activeSession.session.id,
      role: 'user',
      sender_id: 'user',
      sender_name: 'User',
      content: '请修改 spec v1：',
      message_type: 'text',
      status: 'completed',
      metadata: null,
      created_at: now + 2_000,
    },
    {
      id: 'msg-workflow-latest',
      session_id: payload.activeSession.session.id,
      role: 'system',
      sender_id: 'workflow',
      sender_name: '工作流',
      content: '产品经理检测到子任务异常：unknown。',
      message_type: 'text',
      status: 'completed',
      metadata: JSON.stringify({ event_type: 'workflow_recovery_decided', workflow_run_id: 'workflow-run-current' }),
      created_at: now + 3_000,
    },
  ];

  const html = renderSessionShell(payload);
  const transcriptScrollIndex = html.indexOf('data-transcript-scroll="true"');
  const transcriptEndIndex = html.indexOf('class="deepsea-transcript__end"');
  const transcriptHtml = transcriptScrollIndex >= 0 && transcriptEndIndex > transcriptScrollIndex
    ? html.slice(transcriptScrollIndex, transcriptEndIndex)
    : html;

  assert.equal((transcriptHtml.match(/data-workflow-chat-message="true"/g) ?? []).length, 2);
  assert.equal((transcriptHtml.match(/data-workflow-state-stream="true"/g) ?? []).length, 1);
  assert.match(transcriptHtml, /工作流已启动/);
  assert.match(transcriptHtml, /产品经理检测到子任务异常/);
  const firstWorkflowIndex = transcriptHtml.indexOf('data-workflow-chat-message="true"');
  const secondWorkflowIndex = transcriptHtml.indexOf('data-workflow-chat-message="true"', firstWorkflowIndex + 1);
  assert.ok(firstWorkflowIndex >= 0);
  assert.ok(secondWorkflowIndex > firstWorkflowIndex);
  const firstWorkflowHtml = transcriptHtml.slice(firstWorkflowIndex, secondWorkflowIndex);
  const latestWorkflowHtml = transcriptHtml.slice(secondWorkflowIndex);
  assert.doesNotMatch(firstWorkflowHtml, /data-workflow-flow-root="true"/);
  assert.doesNotMatch(firstWorkflowHtml, /data-workflow-view-toggle="true"/);
  assert.doesNotMatch(firstWorkflowHtml, /当前执行者/);
  assert.match(latestWorkflowHtml, /data-workflow-state-stream="true"/);
  assert.doesNotMatch(latestWorkflowHtml, /data-workflow-flow-root="true"/);
  assert.doesNotMatch(latestWorkflowHtml, /data-workflow-view-toggle="true"/);
  assert.match(latestWorkflowHtml, /当前执行者/);
});

test('SessionShell keeps workflow chat layout compact by default', () => {
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow\s*\{[^}]*width:\s*100%/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow::before\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow\.is-blocked\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat__summary-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat\s*\{[^}]*gap:\s*7px/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-state-stream::before\s*\{[^}]*display:\s*none/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__head\s*\{[^}]*display:\s*none/s);
  assert.match(sessionOsCss, /\.deepsea-run-state-stream \.deepsea-workflow-state-stream__head\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__phase\s*\{/);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__nodes\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__steps\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step\s*\{[^}]*grid-template-columns:\s*20px\s+minmax\(0,\s*1fr\)/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step__icon\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step__icon svg\s*\{[^}]*width:\s*12px/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow\.is-blocked \.deepsea-workflow-state-step\[data-card-tone="gate"\]\s*\{[^}]*border-color:\s*color-mix\(in srgb,\s*var\(--deepsea-warn\)/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat__summary-text\s*\{[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-state-step:nth-child\(n \+ 3\)\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-events__compact\s*\{[^}]*grid-template-columns:\s*minmax\(88px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-events__compact span\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-events\[data-compact="true"\] \.deepsea-workflow-events__header\s*\{[^}]*display:\s*none/s);
});

test('SessionShell surfaces workflow approval action in the inspector', () => {
  const payload = createPayload();
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-spec-1',
    selected_intent: 'standard_development',
    active_stage: 'brainstorming',
    controller: 'planner',
    blocker: null,
    next_action: '等待用户确认规格',
  };
  payload.activeSession.workflowArtifacts = [
    {
      id: 'artifact-spec-1',
      workflow_run_id: 'workflow-run-spec-1',
      artifact_type: 'spec',
      version: 1,
      status: 'draft',
      title: '项目删除修复规格',
      content: '确认删除项目前停止 active runs。',
      structured_data: null,
      created_by_agent_id: 'planner',
      change_request_message_id: null,
      approved_by: null,
      approved_at: null,
      created_at: Date.now(),
    },
  ];
  payload.activeSession.workflowGates = [{
    kind: 'spec_confirm',
    workflow_run_id: 'workflow-run-spec-1',
    artifact_version_id: 'artifact-spec-1',
    status: 'pending',
    reason: '等待用户确认 planner 生成的需求/设计规格。',
  }];

  const html = renderSessionShell(payload, { onApproveWorkflowArtifact: () => undefined });
  const inspector = html.match(/<aside[^>]+aria-label="Session Inspector"[\s\S]*?<\/aside>/)?.[0] ?? '';
  const workflowModule = inspector.match(/<section[^>]+data-workflow-inspector="true"[\s\S]*?<\/section>/)?.[0] ?? '';

  assert.match(inspector, /Workflow 状态/);
  assert.match(inspector, /等待用户确认/);
  assert.match(inspector, /确认 spec/);
  assert.match(workflowModule, /data-workflow-artifact-action="approve"/);
  assert.doesNotMatch(workflowModule, /disabled=""/);
});

test('SessionShell surfaces running workflow progress in the inspector without a session run', () => {
  const payload = createPayload();
  payload.activeSession.runs = [];
  payload.activeSession.agentEvents = [];
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-run-active-1',
    selected_intent: 'standard_development',
    active_stage: 'implementation',
    controller: 'worker',
    blocker: null,
    next_action: '正在执行已确认的任务计划。',
  };

  const html = renderSessionShell(payload);
  const inspector = html.match(/<aside[^>]+aria-label="Session Inspector"[\s\S]*?<\/aside>/)?.[0] ?? '';

  assert.match(inspector, /data-workflow-inspector="true"/);
  assert.match(inspector, /data-state="running"/);
  assert.match(inspector, /运行中/);
  assert.match(inspector, /正在执行已确认的任务计划。/);
  assert.match(inspector, /implementation · worker/);
});

test('SessionShell hides artifact confirm action after approval while keeping change request action', () => {
  const payload = createPayload();
  payload.activeSession.workflowArtifacts = [
    {
      id: 'artifact-plan-approved-1',
      workflow_run_id: 'workflow-run-approved-1',
      artifact_type: 'plan',
      version: 1,
      status: 'approved',
      title: '已确认执行计划',
      content: '已确认计划\n\n1. 执行已确认的任务拆解',
      structured_data: null,
      created_by_agent_id: 'planner',
      change_request_message_id: null,
      approved_by: 'user',
      approved_at: Date.now(),
      created_at: Date.now(),
    },
  ];
  payload.activeSession.workflowGates = [{
    kind: 'plan_confirm',
    workflow_run_id: 'workflow-run-approved-1',
    artifact_version_id: 'artifact-plan-approved-1',
    status: 'approved',
    reason: '已确认的执行计划；如需调整，请请求 planner 修改。',
  }];

  const html = renderSessionShell(payload);
  const workflowMessageIndex = html.indexOf('data-workflow-chat-message="true"');
  const composerIndex = html.indexOf('deepsea-composer-anchor');
  const workflowMessageArea = html.slice(workflowMessageIndex, composerIndex);

  assert.match(html, /data-workflow-chat-message="true"/);
  assert.doesNotMatch(html, /data-workflow-artifact-action="approve"/);
  assert.doesNotMatch(workflowMessageArea, /Plan v1/);
  assert.doesNotMatch(workflowMessageArea, /请求修改/);
  assert.doesNotMatch(workflowMessageArea, /data-workflow-artifact-action="request-change"/);
});

test('SessionShell renders workflow controller and agent assignment table', () => {
  const payload = createPayload();
  payload.activeSession.runs = [];
  payload.activeSession.workflowController = {
    workflow_run_id: 'workflow-1',
    selected_intent: 'standard_development',
    active_stage: 'agent_assignment',
    controller: 'planner',
    blocker: null,
    next_action: '等待用户确认计划',
  };
  payload.activeSession.workflowAgentAssignments = [{
    task_id: 'task-1',
    task_title: '实现设置页',
    role: 'executor',
    assigned_agent_id: 'fullstack-engineer',
    assigned_agent_name: '全栈工程师',
    backend: 'codex',
    fallback_reason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
    execution_mode: 'serial',
    scope_write: ['packages/frontend/src/pages/SettingsPage.tsx'],
  }];

  const html = renderSessionShell(payload);

  assert.match(html, /data-workflow-chat-message="true"/);
  assert.match(html, /data-workflow-state-stream="true"/);
  assert.match(html, /deepsea-workflow-state-step/);
  assert.doesNotMatch(html, /data-workflow-flow-root="true"/);
  assert.match(html, /Parallel Execution 并行执行/);
  assert.match(html, /1\. 任务分配与并行启动/);
  assert.match(html, /2\. 并行执行进度/);
  assert.doesNotMatch(html, /Execution Log/);
  assert.match(html, /全栈工程师/);
  assert.match(html, /未找到更匹配/);
  assert.doesNotMatch(html, /data-workflow-view-toggle="true"/);
});

test('SessionShell renders agent run as flow capsule with event rail', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.runs = [{
    ...run,
    id: 'run-flow-1',
    agent_id: 'agent-codex',
    status: 'running',
    stdout: '执行输出正文',
    stderr: '',
    activity_log: '',
    phase: 'implementing',
  }];
  payload.activeSession.agentEvents = [{
    id: 'event-flow-1',
    session_id: run.session_id,
    agent_id: 'agent-codex',
    run_id: 'run-flow-1',
    seq: 1,
    channel: 'event',
    event_type: 'tool_call',
    content: '读取 SessionShellView.tsx',
    payload_json: null,
    created_at: Date.now(),
  }];

  const html = renderSessionShell(payload);

  assert.match(html, /data-run-flow-capsule="true"/);
  assert.match(html, /data-run-event-rail="true"/);
  assert.match(html, /data-run-dynamic-monitor="true"/);
  assert.match(html, /执行链路/);
  assert.match(html, /实时活动/);
  assert.match(html, /deepsea-run-state-stream/);
  assert.match(html, /deepsea-workflow-state-step/);
  assert.match(html, /deepsea-workflow-state-step__progress/);
  assert.doesNotMatch(html, /Agent Run Flow 执行流转/);
  assert.doesNotMatch(html, /data-session-workflow-map="run"/);
  assert.doesNotMatch(html, /flow-path-sequential/);
  assert.doesNotMatch(html, /deepsea-workflow-flow-card/);
  assert.match(html, /输出已流入消息时间线/);
  assert.match(html, /implementing/);
  assert.match(html, /执行输出正文/);
});

test('SessionShell keeps agent run body as a vertical chat message layout', () => {
  assert.match(sessionOsCss, /\.deepsea-run-capsule__header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s);
  assert.match(sessionOsCss, /\.deepsea-run-capsule__header \.deepsea-message-tools\s*\{[^}]*align-self:\s*start/s);
  assert.match(sessionOsCss, /\.deepsea-run-capsule__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(
    sessionOsCss,
    /\.deepsea-run-capsule__body\s*\{[^}]*grid-template-columns:\s*minmax\(128px,\s*168px\)\s+minmax\(0,\s*1fr\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*width:\s*100%/s);
  assert.match(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*border-bottom:\s*1px solid/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*border-right:\s*1px solid/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-run-event-rail\s*\{[^}]*grid-auto-flow:\s*column/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-run-log\s*>\s*div,/);
  assert.match(sessionOsCss, /\.deepsea-run-log:not\(\.deepsea-run-capsule\)\s*>\s*div,/);
});

test('SessionShell keeps workflow chat layout stacked like a chat message', () => {
  assert.match(sessionOsCss, /\.deepsea-transcript\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow\s*\{[^}]*width:\s*100%/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat__summary-row\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat__summary-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-chat__badges\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__head\s*\{[^}]*display:\s*none/s);
  assert.match(sessionOsCss, /\.deepsea-run-state-stream \.deepsea-workflow-state-stream__head\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__phase\s*\{/);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__nodes\s*\{[^}]*padding-left:\s*16px/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__nodes::before\s*\{[^}]*animation:\s*workflowFlowLine/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-node__head\s*\{[^}]*justify-content:\s*space-between/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-node__dot\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__steps\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-stream__steps\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step\s*\{[^}]*grid-template-columns:\s*20px\s+minmax\(0,\s*1fr\)/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step__icon\s*\{[^}]*display:\s*inline-flex/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-state-step:nth-child\(n \+ 3\)\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step__progress\s*\{[^}]*height:\s*3px/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-state-step__progress span\s*\{[^}]*background:\s*var\(--deepsea-primary\)/s);
  assert.match(sessionOsCss, /\.deepsea-run-state-stream\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-workflow-events__compact\s*\{[^}]*grid-template-columns:\s*minmax\(88px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(sessionOsCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-events\[data-compact="true"\] \.deepsea-workflow-events__header\s*\{[^}]*display:\s*none/s);
  assert.match(sessionOsCss, /@container \(max-width:\s*500px\)/);
});

test('SessionShell makes workflow assignment cards collapse under narrow transcript widths', () => {
  const narrowContainerCss = sessionOsCss.match(/@container \(max-width:\s*500px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(narrowContainerCss, /\.deepsea-message\.deepsea-message--workflow \.deepsea-workflow-state-step/);
  assert.match(narrowContainerCss, /\.deepsea-run-capsule \.deepsea-workflow-state-step/);
  assert.match(narrowContainerCss, /\.deepsea-workflow-state-stream__steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(narrowContainerCss, /grid-template-columns:\s*20px\s+minmax\(0,\s*1fr\)/);
});

test('SessionShell renders active session change summaries in the sidebar rows', () => {
  const payload = createPayload();
  payload.activeSessions = payload.activeSessions.map((session) =>
    session.id === payload.activeSession.session.id
      ? { ...session, latest_event_summary: '本会话 2 个文件变更' }
      : session
  );

  const html = renderSessionShell(payload);

  assert.match(html, /data-session-change-summary="true"/);
  assert.match(html, /本会话 2 个文件变更/);
});

test('SessionShell renders local git state in the bottom path area', () => {
  const payload = createPayload();
  payload.status.git = {
    branchName: 'feat/bottom-git',
    changedFileCount: 4,
    hasUncommittedDiff: true,
    conflictRisk: 'low',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Git: feat\/bottom-git, 4 changed/);
  assert.match(html, /feat\/bottom-git/);
  assert.match(html, /4 changed/);
  assert.match(html, /data-git-state="changed"/);
});

test('SessionShell renders clean git state when there are no local changes', () => {
  const payload = createPayload();
  payload.status.git = {
    branchName: 'main',
    changedFileCount: 0,
    hasUncommittedDiff: false,
    conflictRisk: 'none',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Git: main, clean/);
  assert.match(html, /main/);
  assert.match(html, /clean/);
  assert.match(html, /data-git-state="clean"/);
});

test('SessionShell prioritizes git conflicts over changed file count', () => {
  const payload = createPayload();
  payload.status.git = {
    branchName: 'merge/recovery',
    changedFileCount: 7,
    hasUncommittedDiff: true,
    conflictRisk: 'high',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Git: merge\/recovery, conflicts/);
  assert.match(html, /merge\/recovery/);
  assert.match(html, /conflicts/);
  assert.match(html, /data-git-state="conflicts"/);
});

test('SessionShell renders detached when git branch is missing', () => {
  const payload = createPayload();
  payload.status.git = {
    branchName: null,
    changedFileCount: 0,
    hasUncommittedDiff: false,
    conflictRisk: 'none',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Git: detached, clean/);
  assert.match(html, /detached/);
  assert.match(html, /clean/);
});

test('SessionShell only shows the right inspector on the transcript pane', () => {
  assert.equal(isSessionInspectorVisibleForWorkspacePane('transcript'), true);
  assert.equal(isSessionInspectorVisibleForWorkspacePane('file-browser'), false);
});

test('SessionShell renders tool rows as detail buttons', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-tool-row-button="true"/);
  assert.match(html, /aria-label="查看工具调用详情：packages\/frontend\/src\/session-ui\/SessionShell\.tsx"/);
});

test('SessionShell renders uploaded attachments on transcript messages', () => {
  const payload = createPayload();
  payload.activeSession.messages[0] = {
    ...payload.activeSession.messages[0]!,
    content: '分析这些附件',
    metadata: JSON.stringify({
      attachments: [
        {
          id: 'file-text-1',
          fileId: 'file-text-1',
          name: 'brief.txt',
          mimeType: 'text/plain',
          size: 1536,
          url: '/uploads/files/project-1/brief.txt',
          isImage: false,
        },
        {
          id: 'file-image-1',
          fileId: 'file-image-1',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 2048,
          url: '/uploads/files/project-1/screen.png',
          isImage: true,
        },
      ],
    }),
  };

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-message-attachments/);
  assert.match(html, /brief\.txt/);
  assert.match(html, /screen\.png/);
  assert.match(html, /src="\/uploads\/files\/project-1\/screen\.png"/);
  assert.match(html, /aria-label="预览图片附件：screen\.png"/);
  assert.match(html, /1\.5 KB/);
  assert.match(html, /2\.0 KB/);
});

test('SessionShell renders save knowledge action only on assistant transcript messages', () => {
  const payload = createPayload();
  const userMessage = payload.activeSession.messages[0]!;
  payload.activeSession.messages = [
    {
      ...userMessage,
      id: 'message-user',
      role: 'user',
      sender_id: 'user',
      sender_name: '大哥',
      content: '请整理这段上下文。',
    },
    {
      ...userMessage,
      id: 'message-system',
      role: 'system',
      sender_id: 'system',
      sender_name: '系统',
      content: '系统提示内容。',
      created_at: userMessage.created_at + 1,
    },
    {
      ...userMessage,
      id: 'message-assistant',
      role: 'assistant',
      sender_id: 'planner',
      sender_name: '规划师',
      content: '## 结论\n\n可以沉淀为长期上下文。',
      created_at: userMessage.created_at + 2,
    },
  ];
  payload.activeSession.runs = [];
  const savedKeys: string[] = [];

  const html = renderSessionShell(payload, {
    onSaveKnowledge: (input) => savedKeys.push(input.key),
  });

  assert.match(html, /aria-label="保存消息为知识"/);
  assert.match(html, /保存为知识/);
  assert.equal((html.match(/保存为知识/g) ?? []).length, 1);
  assert.match(html, /class="deepsea-message__action"/);
  assert.doesNotMatch(html, /保存中/);
  assert.deepEqual(savedKeys, []);
});

test('SessionShell renders a visual companion accept button for brainstorming preview offers', () => {
  const payload = createPayload();
  const baseMessage = payload.activeSession.messages[0]!;
  payload.activeSession.messages = [{
    ...baseMessage,
    id: 'message-visual-companion',
    role: 'assistant',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)",
  }];
  payload.activeSession.runs = [];

  const html = renderSessionShell(payload);

  assert.match(html, /data-action="visual-companion"/);
  assert.match(html, /打开设计预览/);
  assert.match(html, /data-acceptance-message="同意，打开设计预览。"/);
  assert.deepEqual(buildVisualCompanionAcceptanceSubmit(), { content: '同意，打开设计预览。' });
});

test('shouldShowVisualCompanionAction hides accepted visual companion offers', () => {
  const offer = "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)";

  assert.equal(shouldShowVisualCompanionAction({
    role: 'assistant',
    displayMode: 'preview',
    content: offer,
    accepted: false,
  }), true);
  assert.equal(shouldShowVisualCompanionAction({
    role: 'assistant',
    displayMode: 'preview',
    content: offer,
    accepted: true,
  }), false);
  assert.equal(shouldShowVisualCompanionAction({
    role: 'assistant',
    displayMode: 'source',
    content: offer,
    accepted: false,
  }), false);
});

test('recordVisualCompanionOfferAccepted rejects repeated clicks for the same offer', () => {
  const acceptedKeys = new Set<string>();

  assert.equal(recordVisualCompanionOfferAccepted(acceptedKeys, 'message:offer-1'), true);
  assert.equal(recordVisualCompanionOfferAccepted(acceptedKeys, 'message:offer-1'), false);
  assert.equal(recordVisualCompanionOfferAccepted(acceptedKeys, 'run:offer-1'), true);
  assert.deepEqual([...acceptedKeys], ['message:offer-1', 'run:offer-1']);
});

test('SessionShell renders a visual companion accept button for run output offers', () => {
  const payload = createPayload();
  payload.activeSession.runs[0] = {
    ...payload.activeSession.runs[0]!,
    stdout: "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)",
  };

  const html = renderSessionShell(payload);

  assert.match(html, /data-action="visual-companion"/);
  assert.match(html, /打开设计预览/);
  assert.match(html, /data-acceptance-message="同意，打开设计预览。"/);
});

test('SessionShell renders copy action on user system and assistant messages', () => {
  const payload = createPayload();
  const baseMessage = payload.activeSession.messages[0]!;
  payload.activeSession.messages = [
    {
      ...baseMessage,
      id: 'message-user',
      role: 'user',
      sender_id: 'user',
      sender_name: '大哥',
      content: '用户消息',
    },
    {
      ...baseMessage,
      id: 'message-system',
      role: 'system',
      sender_id: 'system',
      sender_name: '系统',
      content: '系统消息',
      created_at: baseMessage.created_at + 1,
    },
    {
      ...baseMessage,
      id: 'message-assistant',
      role: 'assistant',
      sender_id: 'planner',
      sender_name: '规划师',
      content: '智能体回复',
      created_at: baseMessage.created_at + 2,
    },
  ];
  payload.activeSession.runs = [];

  const html = renderSessionShell(payload);

  assert.equal((html.match(/aria-label="复制消息内容"/g) ?? []).length, 3);
  assert.equal((html.match(/>复制</g) ?? []).length, 3);
});

test('SessionShell disables the save knowledge action while saving a message action key', () => {
  const payload = createPayload();
  payload.activeSession.messages[0] = {
    ...payload.activeSession.messages[0]!,
    role: 'assistant',
    sender_id: 'planner',
    sender_name: '规划师',
    content: '保存中的智能体回复',
  };
  payload.activeSession.runs = [];

  const html = renderSessionShell(payload, {
    onSaveKnowledge: () => undefined,
    savingKnowledgeKey: 'message:message-1',
  });

  assert.match(html, /保存中/);
  assert.match(html, /disabled=""/);
});

test('SessionShell renders copy and save knowledge actions on agent run output', () => {
  const payload = createPayload();
  payload.activeSession.messages = [];
  payload.activeSession.runs = [{
    ...payload.activeSession.runs[0]!,
    id: 'run-copy-save',
    agent_id: 'planner',
    stdout: '## Run 输出\n\n这是一段智能体运行输出。',
    activity_log: '',
    stderr: '',
  }];

  const html = renderSessionShell(payload, {
    onSaveKnowledge: () => undefined,
  });

  assert.match(html, /aria-label="复制智能体输出"/);
  assert.match(html, /aria-label="保存智能体输出为知识"/);
  assert.match(html, /保存为知识/);
  assert.match(html, /复制/);
});

test('SessionShell renders generated image tool result evidence as transcript artifacts', () => {
  const payload = createPayload();
  payload.evidence.push({
    id: 'evidence-image-tool',
    session_id: 'session-1',
    seq: 2,
    event_type: 'tool_result',
    severity: 'info',
    source_run_id: 'run-1',
    source_message_id: null,
    title: '图片生成结果',
    summary: '已生成 1 张图片。',
    payload: {
      tool_name: 'generate_image',
      job_id: 'image-job-1',
      status: 'completed',
      error: null,
      outputs: [{
        file_id: 'file-image-output-1',
        resource_id: 'file:file-image-output-1',
        url: '/uploads/files/project-1/generated.png',
        slot: 1,
      }],
    },
    created_at: Date.now(),
  });

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-generated-artifacts/);
  assert.match(html, /图片生成结果/);
  assert.match(html, /href="\/uploads\/files\/project-1\/generated\.png"/);
  assert.match(html, /src="\/uploads\/files\/project-1\/generated\.png"/);
  assert.match(html, /aria-label="打开生成图片：file-image-output-1"/);
});

test('SessionShell renders active run as compact list row', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /deepsea-run-table/);
  assert.match(html, /1 条记录/);
  assert.match(html, /gpt-5\.5/);
  assert.match(html, /aria-label="运行状态：完成"/);
  assert.match(html, /aria-label="停止运行"/);
  assert.doesNotMatch(html, /deepsea-run-card/);
  assert.doesNotMatch(html, /运行耗时/);
});

test('SessionShell does not render retry action for completed active run', () => {
  const html = renderSessionShell(createPayload(), { onRetryRun: () => undefined });

  assert.match(html, /deepsea-run-table/);
  assert.match(html, /aria-label="运行状态：完成"/);
  assert.doesNotMatch(html, /aria-label="重新执行"/);
});

test('SessionShell renders active run danger state without success semantics', () => {
  const payload = createPayload();
  payload.activeSession.runs[0] = {
    ...payload.activeSession.runs[0]!,
    status: 'failed',
    error: '执行失败',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /data-tone="danger"/);
  assert.match(html, /aria-label="运行状态：失败"/);
  assert.match(html, /<strong>失败<\/strong>/);
  assert.doesNotMatch(html, /aria-label="运行状态：完成"/);
});

test('SessionShell renders failed run output with collapsed error details and a visible retry action', () => {
  const payload = createPayload();
  payload.activeSession.runs[0] = {
    ...payload.activeSession.runs[0]!,
    status: 'failed',
    stdout: '准备启动可视化辅助。',
    stderr: 'fatal: Unable to create .git/index.lock: Operation not permitted',
    activity_log: '收尾阶段尝试提交变更。',
    error: 'Error: listen EPERM: operation not permitted 127.0.0.1:55063',
  };

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });
  const thoughtIndex = html.indexOf('class="deepsea-agent-thought"');
  const errorDetailsIndex = html.indexOf('class="deepsea-run-error-details"');
  const runBodyIndex = html.indexOf('class="deepsea-run-log-body"');

  assert.match(html, /准备启动可视化辅助。/);
  assert.match(html, /<details class="deepsea-run-error-details"/);
  assert.doesNotMatch(html, /<details class="deepsea-run-error-details" open/);
  assert.ok(thoughtIndex >= 0);
  assert.ok(errorDetailsIndex > thoughtIndex);
  assert.ok(errorDetailsIndex < runBodyIndex);
  assert.match(html, /错误详情/);
  assert.match(html, /stderr/);
  assert.match(html, /fatal: Unable to create \.git\/index\.lock/);
  assert.match(html, /listen EPERM/);
  assert.match(html, /继续失败回复/);
  assert.match(html, /aria-label="继续失败回复"/);
});

test('SessionShell backfills failed run reason from raw ACP tool events', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.runs[0] = {
    ...run,
    status: 'failed',
    stdout: '准备启动可视化辅助。',
    stderr: '',
    error: null,
  };
  payload.activeSession.agentEvents = [{
    id: 'event-tool-failed',
    session_id: run.session_id,
    agent_id: run.agent_id,
    run_id: run.id,
    seq: 1,
    channel: 'event',
    event_type: 'tool_call_update',
    content: '',
    payload_json: JSON.stringify({
      rawType: 'tool_call_update',
      rawEvent: {
        method: 'session/update',
        params: {
          update: {
            content: [{ content: { text: 'Error: listen EPERM: operation not permitted 127.0.0.1:55063' } }],
            rawOutput: { exit_code: 1 },
          },
        },
      },
    }),
    created_at: Date.now(),
  }];

  const html = renderSessionShell(payload);

  assert.match(html, /listen EPERM/);
  assert.doesNotMatch(html, /运行失败，暂无错误详情。/);
});

test('SessionShell renders tool row duration from the individual tool event', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    durationMs: 343,
    runDurationMs: 21_423,
  };

  const html = renderSessionShell(payload);

  assert.match(html, /0\.3s/);
  assert.doesNotMatch(html, /21\.4s/);
});

test('SessionShell renders tool row relative record time beside duration', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    durationMs: 343,
    runDurationMs: 21_423,
    created_at: Date.now(),
  };

  const html = renderSessionShell(payload);

  assert.match(html, /class="deepsea-tool-row-duration">0\.3s<\/span>/);
  assert.match(html, /class="deepsea-tool-row-time">刚刚<\/span>/);
});

test('SessionShell renders compact tool rows without ordinal numbers', () => {
  const html = renderSessionShell(createPayload());

  assert.doesNotMatch(html, /<span class="deepsea-tool-row-index">1<\/span>/);
  assert.match(html, /class="deepsea-tool-row-duration"/);
  assert.match(html, /class="deepsea-tool-row-time"/);
});

test('SessionShell renders failed tool rows with an X status icon', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    status: 'failed',
    severity: 'error',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /data-tool-row-status="failed"/);
  assert.match(html, /aria-label="工具调用状态：失败"/);
  assert.match(html, /data-tool-row-status="failed"[^>]*><svg[^>]+lucide-x/s);
});

test('SessionShell keeps the tool call list height bounded with internal scrolling', () => {
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*max-height:\s*min\(320px,\s*36dvh\)/s);
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

test('SessionShell keeps planner skill picker bounded with internal scrolling', () => {
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*max-height:\s*min\(320px,\s*48vh\)/s);
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

test('SessionShell renders upload and knowledge file buttons beside send', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="上传文件"/);
  assert.match(html, /aria-label="从知识库选择文件"/);
  assert.match(html, /type="file"/);
  assert.match(sessionOsCss, /\.deepsea-composer__file-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-composer__icon-button\s*\{[^}]*width:\s*30px/s);
});

test('SessionShell styles selected planner skill chips separately from attachments', () => {
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chips\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip\s*\{[^}]*background:\s*rgba\(99,\s*102,\s*241,\s*0\.12\)/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip\s*\{[^}]*color:\s*rgb\(49,\s*46,\s*129\)/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip__name\s*\{[^}]*font-family:\s*var\(--deepsea-mono\)/s);
});

test('SessionShell includes project tree row pin and drag feedback styles', () => {
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*opacity:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:hover \.deepsea-project-node__button,[\s\S]*padding-right:\s*56px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:hover \.deepsea-project-node__actions/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:focus-within \.deepsea-project-node__actions/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions:has\(\.deepsea-project-node__icon-button\[aria-expanded="true"\]\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*grid-template-columns:\s*14px minmax\(0,\s*1fr\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*border:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*background:\s*transparent/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*opacity:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap:hover \.deepsea-project-session-pin/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-section\[data-drop-target="true"\]/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-section\[data-dragging="true"\]/s);
});

test('SessionShell project rail CSS keeps the reference-style compact hierarchy', () => {
  assert.match(sessionOsCss, /\.deepsea-main\s*\{[^}]*grid-template-columns:\s*292px minmax\(500px,\s*1fr\) 420px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-main\.deepsea-main--without-inspector\s*\{[^}]*grid-template-columns:\s*292px minmax\(500px,\s*1fr\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading\s*\{[^}]*margin-bottom:\s*12px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-tree-heading:hover,\s*\.deepsea-project-tree-heading:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading > span\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading > span\s*\{[^}]*line-height:\s*18px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading button\s*\{[^}]*width:\s*22px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading button\s*\{[^}]*height:\s*22px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node\s*\{[^}]*min-height:\s*30px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-node:hover,\s*\.deepsea-project-node:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.doesNotMatch(
    sessionOsCss,
    /\.deepsea-project-tree-section\[data-active="true"\] \.deepsea-project-node,[\s\S]*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-node__button\s*\{[^}]*padding:\s*3px 10px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__button svg\s*\{[^}]*width:\s*14px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__label strong\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__sessions\s*\{[^}]*margin:\s*4px 0 6px 0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*padding-left:\s*10px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin svg\s*\{[^}]*width:\s*14px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row\s*\{[^}]*min-height:\s*28px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row\s*\{[^}]*padding:\s*4px 8px 4px 4px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-session-row-wrap:hover,\s*\.deepsea-project-session-row-wrap:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\[data-current="true"\]\s*\{[^}]*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\[data-current="true"\]\s*\{[^}]*box-shadow:\s*none/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-session-row\[data-current="true"\]\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__title\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*min-width:\s*46px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*font-size:\s*12px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*text-align:\s*right/s);
});

test('SessionShell styles sidebar organize menu and time rows', () => {
  assert.match(sessionOsCss, /\.deepsea-project-filter-menu\s*\{[^}]*z-index:\s*80/s);
  assert.match(sessionOsCss, /\.deepsea-project-filter-menu__item\s*\{[^}]*min-height:\s*28px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row--time\s*\{[^}]*min-height:\s*42px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__stack\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__project\s*\{[^}]*font-size:\s*11px/s);
});

test('SessionShell renders current session when active sessions are absent from legacy payloads', () => {
  const { activeSessions: _activeSessions, ...legacyPayload } = createPayload();

  const html = renderSessionShell(legacyPayload as unknown as SessionWorkspacePayload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /SessionOS 迁移/);
});

test('SessionShell expands the current project by default and collapses other projects', () => {
  const payload = createPayload();
  payload.projectSwitcher.projects.push({
    id: 'project-empty',
    name: 'EmptyProject',
    path: '/workspace/empty',
    active: false,
    created_at: Date.now() - 10_000,
    updated_at: Date.now() - 10_000,
    pinned_at: null,
    sort_order: null,
    recentSessions: [],
  });

  const html = renderSessionShell(payload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /OpenClaw/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /EmptyProject/);
  assert.match(html, /SessionOS 迁移/);
  assert.doesNotMatch(html, /接口联调/);
  assert.doesNotMatch(html, /暂无活跃会话/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-sortable="true"[^>]*draggable="true"/);
  assert.match(html, /data-sortable="false"[^>]*draggable="false"[\s\S]*AnotherProject/);
  assert.match(html, /data-project-session-row="true"/);
});

test('SessionShell hides project-level actions for orphan fallback projects', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="打开 OpenClaw 项目操作菜单"/);
  assert.match(html, /aria-label="新建 OpenClaw 会话"/);
  assert.doesNotMatch(html, /aria-label="打开 AnotherProject 项目操作菜单"/);
  assert.doesNotMatch(html, /aria-label="新建 AnotherProject 会话"/);
});

test('SessionShell uses Radix project action menu with only rename and remove items', () => {
  const html = renderSessionShell(createPayload());

  assert.match(sessionShellViewSource, /import \* as DropdownMenu from '@radix-ui\/react-dropdown-menu'/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Root/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Trigger asChild>/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Item/);
  assert.match(sessionShellViewSource, /编辑名称/);
  assert.match(sessionShellViewSource, /移除/);
  assert.doesNotMatch(html, /在“访达”中打开/);
  assert.doesNotMatch(html, /创建永久工作树/);
  assert.doesNotMatch(html, /归档聊天/);
  assert.doesNotMatch(sessionShellViewSource, /data-disabled="true"/);
  assert.doesNotMatch(sessionShellViewSource, /<div\s+className="deepsea-project-node__menu"/);
  assert.doesNotMatch(sessionShellViewSource, /aria-hidden={projectMenuOpen/);
  assert.doesNotMatch(sessionShellViewSource, /data-state={projectMenuOpen/);
  assert.doesNotMatch(sessionShellViewSource, /role="menuitem"/);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*top:\s*30px/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*right:\s*8px/s);
});

test('SessionShell renders sidebar organize menu and create project action', () => {
  localStorageValues.clear();
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="筛选、排序和整理会话"/);
  assert.match(html, /aria-label="添加项目"/);
  assert.match(sessionShellViewSource, /整理/);
  assert.match(sessionShellViewSource, /按项目/);
  assert.match(sessionShellViewSource, /时间顺序列表/);
  assert.match(sessionShellViewSource, /排序条件/);
  assert.match(sessionShellViewSource, /已创建/);
  assert.match(sessionShellViewSource, /已更新/);
  assert.match(sessionShellViewSource, /所有聊天/);
  assert.match(sessionShellViewSource, /置顶/);
});

test('writeSessionSidebarPrefs ignores localStorage persistence failures', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      setItem: () => {
        throw new Error('storage disabled');
      },
    },
    configurable: true,
  });

  try {
    assert.doesNotThrow(() => writeSessionSidebarPrefs({
      groupMode: 'time',
      sortMode: 'updated',
      visibility: 'all',
    }));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
  }
});

test('session sidebar prefs ignore localStorage getter failures', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => {
      throw new Error('storage unavailable');
    },
    configurable: true,
  });

  try {
    assert.deepEqual(readSessionSidebarPrefs(), {
      groupMode: 'project',
      sortMode: 'updated',
      visibility: 'all',
    });
    assert.doesNotThrow(() => writeSessionSidebarPrefs({
      groupMode: 'time',
      sortMode: 'updated',
      visibility: 'all',
    }));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
  }
});

test('SessionShell renders time ordered sidebar rows from stored preferences', () => {
  localStorageValues.clear();
  localStorageValues.set(SESSION_SIDEBAR_PREFS_STORAGE_KEY, JSON.stringify({
    groupMode: 'time',
    sortMode: 'updated',
    visibility: 'all',
  }));
  const payload = createPayload();
  payload.projectSwitcher.projects.push({
    id: 'project-2',
    name: 'AnotherProject',
    path: '/workspace/another',
    active: false,
    created_at: Date.now() - 12_000,
    updated_at: Date.now() - 8_000,
    pinned_at: null,
    sort_order: null,
    recentSessions: [],
  });

  const html = renderSessionShell(payload);

  assert.match(html, /data-session-sidebar-mode="time"/);
  assert.match(html, /<span>聊天<\/span>/);
  assert.match(html, /data-session-sidebar-time-row="true"/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /aria-label="切换 OpenClaw 项目展开状态"/);
});

test('SessionShell source wires project and session action callbacks', () => {
  assert.match(
    sessionShellViewSource,
    /<DropdownMenu\.Item[\s\S]*onSelect=\{\(\) => \{[\s\S]*if \(item\.label === '编辑名称'\) onRenameProject\?\.\(project\);[\s\S]*else onRemoveProject\?\.\(project\);[\s\S]*\}\}/,
  );
  assert.match(
    sessionShellViewSource,
    /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*onToggleSessionPin\?\.\(session\);[\s\S]*\}\}/,
  );
  assert.match(
    sessionShellViewSource,
    /const input = buildProjectReorderInput\(projects, draggingProjectId, targetProject\.id\);[\s\S]*if \(input\) onReorderProjects\?\.\(input\);/,
  );
});

test('SessionShell renders project row without a collapse icon before the project name', () => {
  localStorageValues.clear();
  const html = renderSessionShell(createPayload());

  assert.doesNotMatch(html, /data-project-collapse-icon="true"/);
  assert.match(html, /lucide-folder-open/);
});

test('SessionShell renders session pin buttons independently from opening sessions', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-session-pin-button="true"/);
  assert.match(html, /aria-label="置顶会话：SessionOS 迁移"/);
  assert.match(html, /data-session-pin-button="true"[^>]*data-pinned="false"/);
});

test('buildProjectReorderInput returns same-layer reorder ids', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: null, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: null, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.deepEqual(buildProjectReorderInput(projects, 'project-3', 'project-1'), {
    ids: ['project-3', 'project-1', 'project-2'],
    pinned: false,
  });
});

test('buildSessionKnowledgeActionKey distinguishes messages and runs', () => {
  assert.equal(buildSessionKnowledgeActionKey('message', 'message-1'), 'message:message-1');
  assert.equal(buildSessionKnowledgeActionKey('run', 'run-1'), 'run:run-1');
});

test('buildProjectReorderInput ignores same item and cross-layer reorders', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: now - 10, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: null, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.equal(buildProjectReorderInput(projects, 'project-2', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'project-1', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'missing-project', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'project-2', 'missing-project'), null);
  assert.equal(buildProjectReorderInput(projects, 'orphan:x', 'project-2'), null);
  assert.equal(buildProjectReorderInput([
    ...projects,
    { id: 'orphan:x', name: 'Orphan', path: '/orphan', active: false, recentSessions: [], created_at: now, pinned_at: null, sort_order: null },
  ], 'project-2', 'orphan:x'), null);
});

test('buildProjectReorderInput returns pinned layer ids for pinned same-layer reorder', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: now - 30, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: now - 20, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.deepEqual(buildProjectReorderInput(projects, 'project-2', 'project-1'), {
    ids: ['project-2', 'project-1'],
    pinned: true,
  });
});

test('sortSessionsForSidebar uses last viewed time before updated time', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({
      id: 'updated-only',
      project_id: 'project-1',
      title: '仅更新',
      updated_at: now - 1_000,
      last_viewed_at: null,
    }),
    createActiveSummary({
      id: 'viewed',
      project_id: 'project-1',
      title: '已查看',
      updated_at: now - 10_000,
      last_viewed_at: now,
    }),
    createActiveSummary({
      id: 'older',
      project_id: 'project-1',
      title: '更早',
      updated_at: now - 20_000,
      last_viewed_at: null,
    }),
  ];

  assert.deepEqual(sortSessionsForSidebar(sessions, 'updated').map((session) => session.id), [
    'viewed',
    'updated-only',
    'older',
  ]);
});

test('sortSessionsForSidebar falls back to id when timestamps and titles tie', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({ id: 'session-b', project_id: 'project-1', title: '重复标题', created_at: now, updated_at: now }),
    createActiveSummary({ id: 'session-a', project_id: 'project-1', title: '重复标题', created_at: now, updated_at: now }),
  ];

  assert.deepEqual(sortSessionsForSidebar(sessions, 'updated').map((session) => session.id), [
    'session-a',
    'session-b',
  ]);
});

test('buildSessionSidebarModel filters pinned sessions and hides empty projects', () => {
  const now = Date.now();
  const projects = [
    {
      id: 'project-a',
      name: 'Project A',
      path: '/workspace/a',
      active: false,
      created_at: now - 3_000,
      updated_at: now - 2_000,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    },
    {
      id: 'project-empty',
      name: 'Empty Project',
      path: '/workspace/empty',
      active: false,
      created_at: now - 1_000,
      updated_at: now - 1_000,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    },
  ];
  const sessions = [
    createActiveSummary({
      id: 'normal',
      project_id: 'project-a',
      title: '普通会话',
      pinned_at: null,
      created_at: now - 4_000,
      updated_at: now - 4_000,
    }),
    createActiveSummary({
      id: 'pinned',
      project_id: 'project-a',
      title: '置顶会话',
      pinned_at: now,
      created_at: now - 5_000,
      updated_at: now - 5_000,
    }),
  ];
  const model = buildSessionSidebarModel({
    projects,
    sessions,
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'missing-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-a',
    currentProjectName: 'Project A',
    normalizedQuery: '',
    prefs: { groupMode: 'project', sortMode: 'updated', visibility: 'pinned' },
  });

  assert.equal(model.heading, '项目');
  assert.deepEqual(model.projects.map((project) => project.id), ['project-a']);
  assert.deepEqual(model.projects[0]?.sessions.map((session) => session.id), ['pinned']);
  assert.equal(model.emptyMessage, '暂无置顶会话。');
});

test('buildSessionSidebarModel hides empty projects even when the project itself matches search', () => {
  const now = Date.now();
  const model = buildSessionSidebarModel({
    projects: [{
      id: 'project-empty',
      name: 'Empty Project',
      path: '/workspace/empty',
      active: false,
      created_at: now - 1_000,
      updated_at: now,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    }],
    sessions: [],
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'archived-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-empty',
    currentProjectName: 'Empty Project',
    normalizedQuery: 'empty',
    prefs: { groupMode: 'project', sortMode: 'updated', visibility: 'all' },
  });

  assert.deepEqual(model.projects, []);
});

test('buildSessionSidebarModel creates time ordered flat session rows', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({
      id: 'old',
      project_id: 'project-a',
      project_name: 'Project A',
      title: '旧会话',
      created_at: now - 50_000,
      updated_at: now - 40_000,
      last_viewed_at: null,
    }),
    createActiveSummary({
      id: 'recent-view',
      project_id: 'project-b',
      project_name: 'Project B',
      title: '最近查看',
      created_at: now - 60_000,
      updated_at: now - 55_000,
      last_viewed_at: now - 1_000,
    }),
  ];
  const model = buildSessionSidebarModel({
    projects: [],
    sessions,
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'archived-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-a',
    currentProjectName: 'Project A',
    normalizedQuery: '',
    prefs: { groupMode: 'time', sortMode: 'updated', visibility: 'all' },
  });

  assert.equal(model.heading, '聊天');
  assert.deepEqual(model.timeRows.map((session) => session.id), ['recent-view', 'old']);
  assert.deepEqual(model.projects, []);
});

test('syncExpandedProjectIds opens the current project without overwriting existing project state', () => {
  assert.deepEqual(
    syncExpandedProjectIds(
      { 'project-1': true, 'project-2': false, 'project-3': true },
      [{ id: 'project-1' }, { id: 'project-2' }, { id: 'project-3' }, { id: 'project-4' }],
      'project-2',
    ),
    {
      'project-1': true,
      'project-2': true,
      'project-3': true,
      'project-4': false,
    },
  );
});

test('shouldIgnoreProjectDragStart is SSR-safe and wired into project drag start', () => {
  const globalWithElement = globalThis as { Element?: unknown };
  const originalElement = globalWithElement.Element;

  assert.equal(shouldIgnoreProjectDragStart(null), false);
  assert.equal(shouldIgnoreProjectDragStart({} as EventTarget), false);
  class FakeElement {
    constructor(private readonly match: boolean) {}

    closest(): object | null {
      return this.match ? {} : null;
    }
  }
  globalWithElement.Element = FakeElement;
  try {
    assert.equal(shouldIgnoreProjectDragStart(new FakeElement(true) as unknown as EventTarget), true);
    assert.equal(shouldIgnoreProjectDragStart(new FakeElement(false) as unknown as EventTarget), false);
    assert.equal(shouldIgnoreProjectDragStart(null), false);
  } finally {
    if (originalElement === undefined) delete globalWithElement.Element;
    else globalWithElement.Element = originalElement;
  }
  assert.match(sessionShellViewSource, /shouldIgnoreProjectDragStart\(event\.target\)/);
});

test('SessionShell does not add an archived current session to the project tree fallback', () => {
  localStorageValues.clear();
  const payload = createPayload();
  payload.activeSessions = [];
  payload.activeSession.session.status = 'archived';
  payload.activeSession.session.phase = 'archived';
  payload.activeSession.session.archived_at = Date.now();

  const html = renderSessionShell(payload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /没有匹配的会话。/);
  assert.doesNotMatch(html, /data-project-session-row="true"/);
});

test('SessionShell renders empty run state without fake run values', () => {
  const payload = createPayload();
  payload.activeSession.runs = [];

  const html = renderSessionShell(payload);

  assert.match(html, /暂无代理运行/);
  assert.doesNotMatch(html, /deepsea-run-card/);
  assert.doesNotMatch(html, /运行耗时/);
  assert.doesNotMatch(html, new RegExp(['02', '14', '05'].join(':')));
});

test('SessionShell renders agent thought above run output without leaking runtime prompt', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.prompt = '本轮 prompt 来源由 SessionOS Context Inspector 记录。\n\n## Context Sources\n### AGENTS.md\n内部运行时提示不应显示';
  run.status = 'running';
  run.stdout = '';
  run.stderr = '';
  run.activity_log = '分析用户问题，检查会话上下文，并准备简短回复。';

  const html = renderSessionShell(payload);
  const thoughtTag = getAgentThoughtTag(html);
  const thoughtIndex = html.indexOf('class="deepsea-agent-thought"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');

  assert.doesNotMatch(html, /本轮 prompt 来源由 SessionOS Context Inspector 记录/);
  assert.match(html, /智能体思考过程/);
  assert.match(html, /分析用户问题，检查会话上下文，并准备简短回复。/);
  assert.match(html, /等待智能体输出/);
  assert.match(thoughtTag, /data-active="true"/);
  assert.match(thoughtTag, /\sopen=""/);
  assert.ok(thoughtIndex >= 0);
  assert.ok(runLogBodyIndex > thoughtIndex);
});

test('SessionShell collapses completed agent thought by default', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.activity_log = '完成态思考文本默认隐藏，用户需要时可展开查看。';

  const html = renderSessionShell(payload);
  const thoughtTag = getAgentThoughtTag(html);

  assert.match(thoughtTag, /data-active="false"/);
  assert.doesNotMatch(thoughtTag, /\sopen=""/);
  assert.match(html, /展开/);
  assert.match(html, /完成态思考文本默认隐藏，用户需要时可展开查看。/);
});

test('SessionShell keeps previous assistant replies in transcript timeline', () => {
  const payload = createPayload();
  const now = Date.now();
  const firstMessage = payload.activeSession.messages[0]!;
  const firstRun = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [
    {
      ...firstMessage,
      id: 'message-older',
      content: '第一轮问题',
      created_at: now - 80_000,
    },
    {
      ...firstMessage,
      id: 'message-newer',
      content: '第二轮问题',
      created_at: now - 40_000,
    },
  ];
  payload.activeSession.runs = [
    {
      ...firstRun,
      id: 'run-older',
      stdout: '第一轮回复仍然可见',
      started_at: now - 70_000,
      updated_at: now - 65_000,
      completed_at: now - 65_000,
    },
    {
      ...firstRun,
      id: 'run-newer',
      stdout: '第二轮回复也可见',
      started_at: now - 30_000,
      updated_at: now - 25_000,
      completed_at: now - 25_000,
    },
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /第一轮回复仍然可见/);
  assert.match(html, /第二轮回复也可见/);
  assert.ok(html.indexOf('第一轮问题') < html.indexOf('第一轮回复仍然可见'));
  assert.ok(html.indexOf('第一轮回复仍然可见') < html.indexOf('第二轮问题'));
  assert.ok(html.indexOf('第二轮问题') < html.indexOf('第二轮回复也可见'));
});

test('SessionShell renders actual agent names for assistant transcript entries', () => {
  const payload = createPayload();
  const now = Date.now();
  const userMessage = payload.activeSession.messages[0]!;
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [
    {
      ...userMessage,
      id: 'message-user',
      sender_id: 'user',
      sender_name: '大哥',
      role: 'user',
      content: '请修复群聊消息标签',
      created_at: now - 80_000,
    },
    {
      ...userMessage,
      id: 'message-agent',
      sender_id: 'frontend-executor',
      sender_name: '前端执行官',
      role: 'assistant',
      content: '我会更新消息标签。',
      created_at: now - 70_000,
    },
  ];
  payload.activeSession.runs = [{
    ...run,
    agent_id: 'frontend-executor',
    stdout: '已更新消息标签。',
    started_at: now - 60_000,
    updated_at: now - 55_000,
    completed_at: now - 55_000,
  }];

  const html = renderSessionShell(payload);

  assert.match(html, /前端执行官/);
  assert.ok(html.indexOf('前端执行官') < html.indexOf('我会更新消息标签。'));
  assert.ok(html.lastIndexOf('前端执行官') < html.indexOf('已更新消息标签。'));
  assert.doesNotMatch(html, /ASSISTANT/);
});

test('SessionShell resolves run labels from project agent names instead of ids', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [{
    ...payload.activeSession.messages[0]!,
    content: '请执行前端任务',
  }];
  payload.activeSession.runs = [{
    ...run,
    agent_id: 'frontend-executor',
    stdout: '已执行前端任务。',
  }];

  const html = renderSessionShell(payload, {
    projectAgents: createProjectUsedAgentsPayload({
      agent_id: 'frontend-executor',
      name: '前端执行官',
    }),
  });

  assert.match(html, /前端执行官/);
  assert.ok(html.indexOf('前端执行官') < html.indexOf('已执行前端任务。'));
  assert.doesNotMatch(html, /frontend-executor/);
  assert.doesNotMatch(html, /ASSISTANT/);
});

test('SessionShell keeps composer in layout flow below the transcript scroll area', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-transcript-scroll="true"/);
  assert.match(html, /data-transcript-end="true"/);
  assert.match(sessionOsCss, /\.deepsea-transcript__scroll\s*\{[^}]*padding:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-composer-anchor\s*\{[^}]*position:\s*static/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-composer-anchor\s*\{[^}]*position:\s*absolute/s);
  assert.match(sessionOsCss, /\.deepsea-transcript__end\s*\{[^}]*min-height:\s*1px/s);
});

test('SessionShell stretches the empty transcript so the composer stays at the workspace bottom', () => {
  const payload = createPayload();
  payload.activeSession.messages = [];
  payload.activeSession.runs = [];
  payload.activeSession.agentEvents = [];

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-empty deepsea-empty--center/);
  assert.match(html, /发送第一条消息开始当前会话。/);
  assert.match(html, /data-session-composer-textarea="true"/);
  assert.match(sessionOsCss, /\.deepsea-center-workspace \.flexlayout__tab\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-transcript\s*\{[^}]*height:\s*100%/s);
});

test('isTranscriptNearBottom respects the transcript follow threshold', () => {
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 } as HTMLElement), true);
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 } as HTMLElement), false);
});

test('buildTranscriptFollowKey changes when active run output streams in place', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  const firstKey = buildTranscriptFollowKey({
    runs: [{ ...run, id: 'run-streaming', stdout: '第一段', updated_at: 10 }],
    timelineEndKey: 'run:run-streaming',
  });
  const secondKey = buildTranscriptFollowKey({
    runs: [{ ...run, id: 'run-streaming', stdout: '第一段\n第二段', updated_at: 11 }],
    timelineEndKey: 'run:run-streaming',
  });

  assert.notEqual(firstKey, secondKey);
});

test('getLatestUserMessageKey ignores assistant messages', () => {
  const payload = createPayload();
  const base = payload.activeSession.messages[0]!;

  assert.equal(getLatestUserMessageKey([
    { ...base, id: 'assistant-message', role: 'assistant', created_at: 20 },
    { ...base, id: 'user-message', role: 'user', created_at: 10 },
  ]), 'user-message:10');
});

test('SessionShell renders markdown controls and thinking duration in transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages[0] = {
    ...payload.activeSession.messages[0]!,
    content: '请检查 `packages/frontend` 的 Markdown 展示',
  };
  run.stdout = ['## 分析结果', '', '- 已读取消息区', '- 需要补齐源码切换'].join('\n');
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = 19_000;

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-markdown-switch/);
  assert.match(html, /预览/);
  assert.match(html, /源码/);
  assert.match(html, /思考 18s/);
  assert.match(html, /markdown-preview/);
  assert.match(html, /分析结果/);
});

test('SessionShell renders run status beside thinking duration in transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'running';
  run.stdout = '正在处理。';
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = null;

  const runningHtml = renderSessionShell(payload);
  assert.match(runningHtml, /class="deepsea-run-status" data-tone="warn">运行中<\/span>/);

  run.status = 'failed';
  run.error = '执行失败';
  run.completed_at = 19_000;
  const failedHtml = renderSessionShell(payload);
  assert.match(failedHtml, /class="deepsea-run-status" data-tone="danger">失败<\/span>/);

  run.status = 'completed';
  run.error = null;
  const completedHtml = renderSessionShell(payload);
  assert.match(completedHtml, /class="deepsea-run-status" data-tone="ok">完成<\/span>/);

  run.status = 'cancelled';
  run.stdout = '';
  run.stderr = '';
  const cancelledHtml = renderSessionShell(payload);
  assert.match(cancelledHtml, /class="deepsea-run-status" data-tone="muted">已取消<\/span>/);
  assert.match(cancelledHtml, /<mark>CANCELLED<\/mark>/);
  assert.match(cancelledHtml, /运行已取消。/);
  assert.doesNotMatch(cancelledHtml, /<mark>RUNNING<\/mark>/);
  assert.doesNotMatch(cancelledHtml, /等待智能体输出/);
});

test('SessionShell renders a retry icon next to the failed transcript status chip', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'failed';
  run.error = '执行失败';

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });

  assert.match(html, /class="deepsea-run-status-group"/);
  assert.match(html, /class="deepsea-run-status" data-tone="danger">失败<\/span><button[^>]+aria-label="继续失败回复"/);
  assert.match(html, /lucide-repeat2/);
});

test('SessionShell only renders retry action on the latest failed transcript run', () => {
  const payload = createPayload();
  const staleRun = {
    ...payload.activeSession.runs[0]!,
    id: 'run-stale-failed',
    status: 'failed' as const,
    error: '旧运行失败',
    started_at: 1_000,
    updated_at: 2_000,
    completed_at: 2_000,
  };
  const latestRun = {
    ...payload.activeSession.runs[0]!,
    id: 'run-latest-completed',
    status: 'completed' as const,
    stdout: '最新回复完成',
    error: null,
    started_at: 3_000,
    updated_at: 4_000,
    completed_at: 4_000,
  };
  payload.activeSession.runs = [staleRun, latestRun];

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });

  assert.match(html, /class="deepsea-run-status" data-tone="danger">失败<\/span>/);
  assert.match(html, /class="deepsea-run-status" data-tone="ok">完成<\/span>/);
  assert.doesNotMatch(html, /aria-label="继续失败回复"/);
  assert.doesNotMatch(html, /aria-label="重试失败运行"/);
});

test('SessionShell hides retry action when a newer transcript message follows a failed run', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'failed';
  run.error = '执行失败';
  payload.activeSession.messages.push({
    ...payload.activeSession.messages[0]!,
    id: 'message-after-failed-run',
    content: '分析最新问题',
    created_at: run.started_at + 1_000,
  });

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });

  assert.match(html, /class="deepsea-run-status" data-tone="danger">失败<\/span>/);
  assert.doesNotMatch(html, /aria-label="继续失败回复"/);
  assert.doesNotMatch(html, /aria-label="重试失败运行"/);
});

test('SessionShell renders retry action for the latest interrupted run', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'interrupted';
  run.stdout = '';
  run.error = '运行中断';

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });

  assert.match(html, /class="deepsea-run-status" data-tone="danger">失败<\/span><button[^>]+aria-label="重试失败运行"/);
  assert.match(html, /aria-label="运行状态：失败"/);
  assert.match(html, /aria-label="重试失败运行"/);
});

test('SessionShell marks completed runs with provider wrap-up errors as interrupted and retryable', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '已写入 spec。';
  run.stderr = '';
  run.error = null;
  run.started_at = 1_000;
  run.updated_at = 20_000;
  run.completed_at = 19_000;
  payload.activeSession.messages[0]!.created_at = 500;
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'run-completed',
      seq: 1,
      channel: 'event',
      event_type: 'run_completed',
      created_at: 19_000,
    }),
    createAgentEvent({
      id: 'provider-error',
      seq: 2,
      channel: 'activity',
      event_type: 'protocol.stderr',
      content: '\u001b[31mERROR\u001b[0m 429 Too Many Requests',
      created_at: 20_000,
    }),
  ];

  const html = renderSessionShell(payload, { onRetryRun: () => undefined });

  assert.match(html, /class="deepsea-run-status" data-tone="warn" title="ERROR 429 Too Many Requests">收尾中断<\/span><button[^>]+aria-label="重新收尾"/);
  assert.doesNotMatch(html, /class="deepsea-run-status" data-tone="ok">完成<\/span>/);
  assert.match(html, /aria-label="运行状态：收尾中断"/);
  assert.equal((html.match(/aria-label="重新收尾"/g) ?? []).length, 2);
});

test('SessionShell keeps run status chips aligned with the thinking chip', () => {
  assert.match(sessionOsCss, /\.deepsea-thinking-duration,\s*\.deepsea-run-status,\s*\.deepsea-run-status-retry\s*\{[^}]*--deepsea-run-chip-height:\s*18px;[^}]*height:\s*var\(--deepsea-run-chip-height\);[^}]*min-height:\s*var\(--deepsea-run-chip-height\);/s);
  assert.match(sessionOsCss, /\.deepsea-thinking-duration,\s*\.deepsea-run-status\s*\{[^}]*padding:\s*0 6px;[^}]*font-size:\s*8px;[^}]*line-height:\s*1;/s);
});

test('SessionShell separates ACP tool records from answer text in chat transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.stdout = '我会先分析当前项目。找到入口和脚本。已完成。';
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = 19_000;
  payload.activeSession.agentEvents = [
    createAgentEvent({ id: 'event-answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '我会先分析当前项目。', created_at: 19_000 }),
    createAgentEvent({ id: 'event-thinking', seq: 2, channel: 'thinking', event_type: 'reasoning_delta', content: '判断需要读取 package.json。' }),
    createAgentEvent({
      id: 'event-read',
      seq: 3,
      channel: 'tool',
      event_type: 'tool_call',
      content: '',
      payload_json: JSON.stringify({ rawEvent: { params: { update: { rawInput: { command: ['sed', '-n', '1,120p', 'package.json'] } } } } }),
    }),
    createAgentEvent({ id: 'event-answer-2', seq: 4, channel: 'answer', event_type: 'agent_message_chunk', content: '找到入口和脚本。' }),
    createAgentEvent({
      id: 'event-command',
      seq: 5,
      channel: 'tool',
      event_type: 'tool_call',
      content: '',
      payload_json: JSON.stringify({ rawEvent: { params: { update: { rawInput: { command: ['npm', 'run', 'build'] } } } } }),
    }),
    createAgentEvent({ id: 'event-answer-3', seq: 6, channel: 'answer', event_type: 'agent_message_chunk', content: '已完成。' }),
  ];

  const html = renderSessionShell(payload);
  const runLogIndex = html.indexOf('class="deepsea-run-log"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');
  const thoughtTextIndex = html.indexOf('判断需要读取 package.json。');

  assert.match(html, /思考 18s/);
  assert.ok(runLogIndex < html.indexOf('我会先分析当前项目。'));
  assert.match(html, /找到入口和脚本。/);
  assert.match(html, /已完成。/);
  assert.doesNotMatch(html, /Thinking/);
  assert.match(html, /Read File/);
  assert.match(html, /Run Command/);
  assert.ok(thoughtTextIndex >= 0);
  assert.ok(thoughtTextIndex > runLogIndex);
  assert.ok(thoughtTextIndex < runLogBodyIndex);
  assert.ok(runLogIndex < html.indexOf('找到入口和脚本。'));
  assert.ok(html.indexOf('找到入口和脚本。') < html.indexOf('已完成。'));
});

test('SessionShell renders a details icon for tool calls after an answer segment', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '准备修改。修改完成。';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '准备修改。' }),
    createAgentEvent({
      id: 'event-edit',
      seq: 2,
      channel: 'event',
      event_type: 'tool_call',
      payload_json: JSON.stringify({ trace: { name: 'Edit', input: '{"path":"SessionShellView.tsx"}' } }),
    }),
    createAgentEvent({ id: 'answer-2', seq: 3, channel: 'answer', event_type: 'agent_message_chunk', content: '修改完成。' }),
  ];

  const html = renderSessionShell(payload);
  const firstTextIndex = html.indexOf('准备修改。');
  const detailsIndex = html.indexOf('查看本段调用详情');
  const secondTextIndex = html.indexOf('修改完成。');

  assert.match(html, /aria-label="查看本段调用详情"/);
  assert.match(html, /class="[^"]*deepsea-run-timeline__details-button/);
  assert.match(html, /lucide-info/);
  assert.doesNotMatch(html, /期间 1 个调用/);
  assert.doesNotMatch(html, /deepsea-run-timeline__text-footer/);
  assert.ok(firstTextIndex >= 0);
  assert.ok(detailsIndex > firstTextIndex);
  assert.ok(secondTextIndex > detailsIndex);
});

test('SessionShell portals run event details outside the transcript stacking context', () => {
  assert.match(sessionShellViewSource, /createPortal\(/);
  assert.match(sessionShellViewSource, /document\.body/);
});

test('buildSessionRunTranscriptItems keeps only answer text in chat transcript', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '第一句。' }),
    createAgentEvent({ id: 'answer-2', seq: 2, channel: 'answer', event_type: 'agent_message_chunk', content: '第二句。' }),
    createAgentEvent({ id: 'thinking', seq: 3, channel: 'thinking', event_type: 'reasoning_delta', content: '准备搜索。' }),
    createAgentEvent({ id: 'answer-3', seq: 4, channel: 'answer', event_type: 'agent_message_chunk', content: '第三句。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '第一句。第二句。第三句。',
  ]);
});

test('buildSessionRunTranscriptItems separates answer text around ACP tool markers', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '准备修改。' }),
    createAgentEvent({
      id: 'edit',
      seq: 2,
      channel: 'event',
      event_type: 'tool_call',
      payload_json: JSON.stringify({ trace: { name: 'Edit' } }),
    }),
    createAgentEvent({ id: 'answer-2', seq: 3, channel: 'answer', event_type: 'agent_message_chunk', content: '修改完成。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? {
    text: item.text,
    events: item.events.map((event) => event.label),
  } : {
    text: `[${item.label}]`,
    events: [],
  }), [
    { text: '准备修改。', events: ['Edit'] },
    { text: '修改完成。', events: [] },
  ]);
});

test('buildSessionRunTranscriptItems groups plan update markers after the previous answer text', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '先给出计划。' }),
    createAgentEvent({
      id: 'plan-update',
      seq: 2,
      channel: 'event',
      event_type: 'plan_update',
      payload_json: JSON.stringify({ entries: [{ title: '补充验证', status: 'pending' }] }),
    }),
    createAgentEvent({ id: 'answer-2', seq: 3, channel: 'answer', event_type: 'agent_message_chunk', content: '继续说明。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? {
    text: item.text,
    events: item.events.map((event) => event.label),
  } : {
    text: `[${item.label}]`,
    events: [],
  }), [
    { text: '先给出计划。', events: ['Update Plan'] },
    { text: '继续说明。', events: [] },
  ]);
});

test('buildSessionRunTranscriptItems ignores ACP protocol noise events', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '第一段。' }),
    createAgentEvent({ id: 'available', seq: 2, channel: 'event', event_type: 'available_commands_update' }),
    createAgentEvent({ id: 'wrapped-token', seq: 3, channel: 'event', event_type: 'agent_message_chunk' }),
    createAgentEvent({ id: 'usage', seq: 4, channel: 'event', event_type: 'usage_update' }),
    createAgentEvent({ id: 'done', seq: 5, channel: 'event', event_type: 'run_completed' }),
    createAgentEvent({ id: 'answer-2', seq: 6, channel: 'answer', event_type: 'agent_message_chunk', content: '第二段。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '第一段。第二段。',
  ]);
});

test('buildSessionRunTranscriptItems keeps answer text without content sniffing', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'fallback',
      seq: 1,
      channel: 'answer',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n',
    }),
    createAgentEvent({
      id: 'command-start',
      seq: 2,
      channel: 'answer',
      event_type: 'item.started',
      content: "开始命令：/bin/zsh -lc 'rtk find .'\n",
      payload_json: JSON.stringify({ trace: null }),
    }),
    createAgentEvent({
      id: 'answer',
      seq: 3,
      channel: 'answer',
      event_type: 'item.completed',
      content: '✅ 结论：页面已分析。',
    }),
    createAgentEvent({
      id: 'command-completed',
      seq: 4,
      channel: 'answer',
      event_type: 'item.completed',
      content: "完成命令：/bin/zsh -lc 'rtk find .'\n",
      payload_json: JSON.stringify({ trace: null }),
    }),
  ], '[ACP fallback]\n开始命令：rtk find\n✅ 结论：页面已分析。\n完成命令：rtk find');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    "[ACP fallback] codex protocol server unavailable, using legacy CLI.\n开始命令：/bin/zsh -lc 'rtk find .'\n✅ 结论：页面已分析。完成命令：/bin/zsh -lc 'rtk find .'",
  ]);
});

test('buildSessionRunTranscriptItems keeps process-looking answer chunks before final answer', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'preface-1',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
    }),
    createAgentEvent({
      id: 'preface-2',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
    }),
  ], [
    '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
    '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
    '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
  ].join(''));

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    [
      '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
      '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
      '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
    ].join(''),
  ]);
});

test('buildSessionRunTranscriptItems keeps follow-up answer chunks before global skills answer', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'preface-1',
      seq: 1,
      channel: 'answer',
      event_type: 'item.completed',
      content: '我会按“全局安装”先核对 `~/.codex/skills`，再单独标出 Superpowers 插件缓存里暴露的技能。',
    }),
    createAgentEvent({
      id: 'preface-2',
      seq: 2,
      channel: 'answer',
      event_type: 'item.completed',
      content: '刚才第一轮发现 `~/.codex/skills` 里有普通用户技能，也发现 Superpowers 有两份同名来源。现在补查隐藏目录和 `~/.agents/skills`，因为全局技能里有一部分放在这些位置。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'item.completed',
      content: '当前全局安装/暴露的 skills，按唯一名称去重后共 **28 个**。',
    }),
  ], '');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    [
      '我会按“全局安装”先核对 `~/.codex/skills`，再单独标出 Superpowers 插件缓存里暴露的技能。',
      '刚才第一轮发现 `~/.codex/skills` 里有普通用户技能，也发现 Superpowers 有两份同名来源。现在补查隐藏目录和 `~/.agents/skills`，因为全局技能里有一部分放在这些位置。',
      '当前全局安装/暴露的 skills，按唯一名称去重后共 **28 个**。',
    ].join(''),
  ]);
});

test('buildSessionRunTranscriptItems ignores structured non-answer channels', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'activity',
      seq: 1,
      channel: 'activity',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] using legacy CLI\n',
    }),
    createAgentEvent({
      id: 'thinking',
      seq: 2,
      channel: 'thinking',
      event_type: 'reasoning_delta',
      content: '我会先分析上下文。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '✅ 结论：截图展示的是工具调用列表。',
    }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '✅ 结论：截图展示的是工具调用列表。',
  ]);
});

test('buildSessionRunTranscriptItems keeps tokenized answer text literally', () => {
  const text = [
    '我会先恢复现场：读取 Superpowers 入口要求和当前未提交改动。',
    '本轮使用 using-superpowers 做会话入口检查。',
    '若确认是前端实现/调整，会再按需加载前端相关 skill。',
    '当前现场只有一个前端 UI 文件被改动。',
    '我会继续把这块做完整。',
  ].join('');
  const items = buildSessionRunTranscriptItems(
    [...text].map((char, index) => createAgentEvent({
      id: `chunk-${index}`,
      seq: index + 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: char,
    })),
    text,
  );

  assert.deepEqual(items, [{ type: 'text', id: 'text-0', text, events: [] }]);
});

test('SessionShell keeps process-looking answer text in run body', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '我会直接按上传文件读取图片，然后基于截图内容做结构化分析。✅ 结论：截图展示的是工具调用列表。';
  run.stderr = '';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'preface',
      seq: 1,
      channel: 'answer',
      event_type: 'item.completed',
      content: '我会直接按上传文件读取图片，然后基于截图内容做结构化分析。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 2,
      channel: 'answer',
      event_type: 'item.completed',
      content: '✅ 结论：截图展示的是工具调用列表。',
    }),
  ];

  const html = renderSessionShell(payload);
  const runLogIndex = html.indexOf('data-run-flow-capsule="true"');

  assert.ok(runLogIndex >= 0);
  assert.ok(html.indexOf('我会直接按上传文件读取图片') > runLogIndex);
  assert.match(html, /✅ 结论：截图展示的是工具调用列表。/);
});

test('SessionShell renders run thought inside assistant message area', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '我会按项目本地目录来核对。当前项目级安装的 skill 只有 1 个：impeccable';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'preface',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '我会按项目本地目录来核对。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前项目级安装的 skill 只有 1 个：impeccable',
    }),
  ];

  const html = renderSessionShell(payload);
  const assistantIndex = html.indexOf('class="deepsea-message deepsea-message--agent-run" data-role="assistant"');
  const thoughtIndex = html.indexOf('class="deepsea-agent-thought"');
  const runLogIndex = html.indexOf('class="deepsea-run-log"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');

  assert.ok(assistantIndex >= 0);
  assert.ok(thoughtIndex > assistantIndex);
  assert.ok(thoughtIndex > runLogIndex);
  assert.ok(thoughtIndex < runLogBodyIndex);
});

test('SessionShell renders stderr literally when stdout is empty', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '';
  run.stderr = '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n开始命令：rtk find .\n';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'fallback',
      seq: 1,
      channel: 'answer',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n',
    }),
    createAgentEvent({
      id: 'command-start',
      seq: 2,
      channel: 'answer',
      event_type: 'item.started',
      content: '开始命令：rtk find .\n',
    }),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /ACP fallback/);
  assert.match(html, /开始命令：rtk find \./);
  assert.doesNotMatch(html, /未返回可展示回复。/);
});

test('SessionShell renders a concise active session title with the full title available', () => {
  const payload = createPayload();
  payload.activeSession.session.title = '用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出';
  payload.projectSwitcher.projects[0]!.recentSessions[0]!.title = payload.activeSession.session.title;

  const html = renderSessionShell(payload);

  assert.match(html, /title="用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出"/);
  assert.match(html, /用户在当前会话第一次发送消息的时候.../);
  assert.doesNotMatch(html, />用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出</);
});

test('getSessionRunThinkingDuration formats active and completed durations', () => {
  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'running',
    started_at: 1_000,
    updated_at: 1_000,
    completed_at: null,
  }, [], 19_400), { label: '思考中 18s', active: true });

  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'completed',
    started_at: 1_000,
    updated_at: 126_000,
    completed_at: 126_000,
  }, [], 200_000), { label: '思考 2m 5s', active: false });
});

test('getSessionRunThinkingDuration stops at the first answer event', () => {
  const run = {
    status: 'running' as const,
    started_at: 1_000,
    updated_at: 60_000,
    completed_at: null,
  };

  assert.deepEqual(getSessionRunThinkingDuration(run, [
    createAgentEvent({
      id: 'thinking-before-answer',
      seq: 1,
      channel: 'thinking',
      event_type: 'reasoning_delta',
      content: '分析中',
      created_at: 5_000,
    }),
    createAgentEvent({
      id: 'answer-first',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '开始回复。',
      created_at: 8_000,
    }),
    createAgentEvent({
      id: 'answer-second',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '继续回复。',
      created_at: 20_000,
    }),
  ], 90_000), { label: '思考 7s', active: false });
});

test('getSessionRunThinkingDuration does not keep paused runs active', () => {
  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'paused',
    started_at: 1_000,
    updated_at: 12_000,
    completed_at: null,
  }, [], 90_000), { label: '思考 11s', active: false });
});

test('SessionShell renders a blinking cursor while a run is streaming', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'running';
  run.stdout = '开始回复。';
  run.started_at = 1_000;
  run.updated_at = 8_000;
  run.completed_at = null;
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'answer',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '开始回复。',
      created_at: 8_000,
    }),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /streaming-cursor/);
});

test('SessionShell hides the streaming cursor after a run completes', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '已完成。';
  run.started_at = 1_000;
  run.updated_at = 8_000;
  run.completed_at = 8_000;
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'answer',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '已完成。',
      created_at: 8_000,
    }),
  ];

  const html = renderSessionShell(payload);

  assert.doesNotMatch(html, /streaming-cursor/);
});

test('SessionShell CSS makes only chat body text one size smaller and defines streaming cursor', () => {
  assert.match(sessionOsCss, /\.deepsea-message-body,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-run-log-body,[\s\S]*line-height:\s*19px/);
  assert.match(sessionOsCss, /\.deepsea-message-body \.message-content,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-message-body \.markdown-preview p,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-run-log-body \.streaming-cursor\s*\{/);
  assert.match(sessionOsCss, /@keyframes deepsea-cursor-blink/);
});

test('SessionShell groups message actions and markdown switch in one compact toolbar', () => {
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(sessionOsCss, /\.deepsea-message__action\[data-action="copy"\]\s*\{[^}]*color:\s*var\(--deepsea-primary-bright\)/s);
  assert.match(sessionOsCss, /\.deepsea-message__action\[data-state="copied"\]\s*\{[^}]*background:\s*var\(--deepsea-primary-bright\)/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-message__action \+ \.deepsea-markdown-switch/);
});

test('SessionShell renders pending risk approval messages as a table with decision buttons', () => {
  const payload = createPayload();
  payload.activeSession.messages.push(createRiskGateMessage({
    id: 'risk-gate-1',
    sourceMessageId: 'message-1',
    status: 'pending',
    created_at: Date.now() - 10_000,
  }));

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-risk-approval/);
  assert.match(html, /data-approval-status="pending"/);
  assert.match(html, /deepsea-risk-approval__table/);
  assert.match(html, /风险级别/);
  assert.match(html, /medium/);
  assert.match(html, /任务类型/);
  assert.match(html, /fullstack_change/);
  assert.match(html, /原因/);
  assert.match(html, /front\/back workflow changes require approval/);
  assert.match(html, /执行方式/);
  assert.match(html, /hybrid/);
  assert.match(html, /data-approval-action="approve"/);
  assert.match(html, /aria-label="确定执行风险任务"/);
  assert.match(html, />确定</);
  assert.match(html, /data-approval-action="reject"/);
  assert.match(html, /aria-label="取消本次风险任务"/);
  assert.match(html, />取消</);
  assert.doesNotMatch(html, /请回复/);
});

test('SessionShell uses the latest risk approval decision to hide stale gate buttons', () => {
  const payload = createPayload();
  const sourceMessageId = 'message-1';
  payload.activeSession.messages.push(createRiskGateMessage({
    id: 'risk-gate-1',
    sourceMessageId,
    status: 'pending',
    created_at: Date.now() - 20_000,
    approvalCreatedAt: Date.now() - 20_000,
  }));
  payload.activeSession.messages.push(createRiskGateMessage({
    id: 'risk-gate-decision-1',
    sourceMessageId,
    status: 'approved',
    includeApprovalCard: false,
    content: '风险确认已确认，正在启动 planner 执行原任务。',
    created_at: Date.now() - 5_000,
    approvalCreatedAt: Date.now() - 20_000,
    approvalDecidedAt: Date.now() - 5_000,
  }));

  const html = renderSessionShell(payload);

  assert.match(html, /data-approval-status="approved"/);
  assert.match(html, /已确认执行/);
  assert.doesNotMatch(html, /data-approval-action="approve"/);
  assert.doesNotMatch(html, /data-approval-action="reject"/);
});

test('SessionShell renders a concise active session title with the full title available', () => {
  const payload = createPayload();
  payload.activeSession.session.title = '用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出';
  payload.projectSwitcher.projects[0]!.recentSessions[0]!.title = payload.activeSession.session.title;

  const html = renderSessionShell(payload);

  assert.match(html, /title="用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出"/);
  assert.match(html, /用户在当前会话第一次发送消息的时候.../);
  assert.doesNotMatch(html, />用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出</);
});

function getAgentThoughtTag(html: string): string {
  const match = html.match(/<details class="deepsea-agent-thought"[^>]*>/);
  assert.ok(match, 'expected an agent thought details element');
  return match[0];
}

function createRiskGateMessage(input: {
  id: string;
  sourceMessageId: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  includeApprovalCard?: boolean;
  content?: string;
  approvalCreatedAt?: number;
  approvalDecidedAt?: number;
}): SessionMessage {
  const riskAssessment = {
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
    requiresApproval: true,
    approvalReason: 'front/back workflow changes require approval',
    confidence: 0.86,
    reasons: ['front/back workflow changes require approval'],
    scopeRead: ['packages/frontend', 'packages/backend'],
    scopeWrite: ['packages/frontend/src/session-ui', 'packages/backend/src'],
    verificationCommands: [{
      command: 'npm run build',
      reason: '验证前后端 TypeScript 和前端打包',
      required: true,
    }],
  };
  const approvalCard = {
    riskLevel: 'medium',
    taskKind: 'fullstack_change',
    summary: 'front/back workflow changes require approval',
    approvalReason: 'front/back workflow changes require approval',
    agents: ['planner', 'frontend-dev', 'backend-dev'],
    executionMode: 'hybrid',
    scopeRead: ['packages/frontend', 'packages/backend'],
    scopeWrite: ['packages/frontend/src/session-ui', 'packages/backend/src'],
    verification: [{
      command: 'npm run build',
      reason: '验证前后端 TypeScript 和前端打包',
      required: true,
    }],
    risks: [],
    assumptions: [],
  };
  const sessionApproval = {
    status: input.status,
    sourceMessageId: input.sourceMessageId,
    originalContent: '实现一个需要前后端联动的任务',
    riskAssessment,
    approvalCard,
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [],
    createdAt: input.approvalCreatedAt ?? input.created_at,
    ...(input.approvalDecidedAt ? { decidedAt: input.approvalDecidedAt } : {}),
  };
  const metadata: Record<string, unknown> = {
    session_approval: sessionApproval,
    source_message_id: input.sourceMessageId,
  };
  if (input.includeApprovalCard !== false) {
    metadata.risk_assessment = riskAssessment;
    metadata.approval_card = approvalCard;
  }
  return {
    id: input.id,
    session_id: 'session-1',
    role: 'system',
    sender_id: 'risk-gate',
    sender_name: '风险门禁',
    content: input.content ?? [
      '风险确认：该任务被判定为 medium 风险，需要确认后再启动 planner。',
      '任务类型：fullstack_change',
      '原因：front/back workflow changes require approval',
      '执行方式：hybrid',
      '请回复“确认”继续执行，或回复“取消”放弃本次执行。',
    ].join('\n'),
    message_type: 'system',
    status: 'completed',
    metadata: JSON.stringify(metadata),
    created_at: input.created_at,
  };
}

function createAgentEvent(input: Partial<SessionAgentEvent> & Pick<SessionAgentEvent, 'id' | 'seq' | 'channel' | 'event_type'>): SessionAgentEvent {
  return {
    id: input.id,
    session_id: input.session_id ?? 'session-1',
    agent_id: input.agent_id ?? 'planner',
    run_id: input.run_id ?? 'run-1',
    seq: input.seq,
    channel: input.channel,
    event_type: input.event_type,
    content: input.content ?? '',
    payload_json: input.payload_json ?? null,
    created_at: input.created_at ?? Date.now(),
  };
}

export function createPayload(): SessionWorkspacePayload {
  const now = Date.now();
  return {
    project: {
      id: 'project-1',
      name: 'OpenClaw',
      path: '/workspace/openclaw',
      description: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: now - 10_000,
      updated_at: now,
    },
    activeSession: {
      session: {
        id: 'session-1',
        project_id: 'project-1',
        title: 'SessionOS 迁移',
        current_goal: '把旧协作工作流切换为活跃会话模型',
        mode: 'code',
        phase: 'implementing',
        status: 'active',
        provider: 'codex',
        model: 'gpt-5.5',
        workspace_path: '/workspace/openclaw',
        worktree_path: null,
        branch_name: 'feat/session-os',
        forked_from_session_id: null,
        forked_from_history_record_id: null,
        latest_compaction_id: null,
        latest_context_manifest_id: 'context-1',
        closed_at: null,
        pinned_at: null,
        last_viewed_at: now - 120_000,
        created_at: now - 7_200_000,
        updated_at: now,
        archived_at: null,
      },
      messages: [{
        id: 'message-1',
        session_id: 'session-1',
        role: 'user',
        sender_id: 'user',
        sender_name: '大哥',
        content: '继续执行计划',
        message_type: 'text',
        status: 'completed',
        metadata: null,
        created_at: now - 60_000,
      }],
      runs: [{
        id: 'run-1',
        session_id: 'session-1',
        agent_id: 'planner',
        provider: 'codex',
        model: 'gpt-5.5',
        status: 'completed',
        mode: 'code',
        phase: 'implementing',
        prompt: '继续执行计划',
        stdout: 'done',
        stderr: '',
        activity_log: '',
        error: null,
        acp_session_id: 'acp-1',
        runtime_profile_snapshot: null,
        started_at: now - 50_000,
        updated_at: now - 40_000,
        completed_at: now - 40_000,
      }],
      agentEvents: [],
      planItems: [{
        id: 'plan-1',
        session_id: 'session-1',
        parent_id: null,
        title: '实现 SessionOS 组件',
        description: null,
        status: 'in_progress',
        priority: 1,
        source: 'plan',
        evidence_event_id: null,
        created_at: now - 100_000,
        updated_at: now - 50_000,
        completed_at: null,
      }],
      compactions: [],
      checkpoints: [],
      evidence: [{
        id: 'evidence-1',
        session_id: 'session-1',
        seq: 1,
        event_type: 'file_diff',
        severity: 'info',
        source_run_id: 'run-1',
        source_message_id: null,
        title: 'File diff',
        summary: 'Updated session UI',
        payload: { path: 'packages/frontend/src/session-ui/SessionShell.tsx' },
        created_at: now - 30_000,
      }],
    },
    activeSessions: [
      {
        id: 'session-2',
        project_id: 'project-2',
        project_name: 'AnotherProject',
        project_path: '/workspace/another',
        title: '接口联调',
        status: 'blocked',
        phase: 'blocked',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        pinned_at: now - 4_000,
        created_at: now - 3_600_000,
        last_viewed_at: now - 6_000,
        updated_at: now - 8_000,
        unread_count: 2,
        active_run_count: 1,
        latest_event_summary: '等待后端 schema 决策',
      },
      {
        id: 'session-1',
        project_id: 'project-1',
        project_name: 'OpenClaw',
        project_path: '/workspace/openclaw',
        title: 'SessionOS 迁移',
        status: 'active',
        phase: 'implementing',
        provider: 'codex',
        model: 'gpt-5.5',
        pinned_at: null,
        created_at: now - 7_200_000,
        last_viewed_at: now - 120_000,
        updated_at: now,
        unread_count: 0,
        active_run_count: 0,
        latest_event_summary: 'Updated session UI',
      },
    ],
    historyRecords: [{
      id: 'history-1',
      project_id: 'project-1',
      session_id: 'old-session',
      title: '后端会话模型',
      summary: '完成 sessions/history_records schema 与 API',
      status: 'archived',
      mode: 'code',
      started_at: now - 86_400_000,
      ended_at: now - 3_600_000,
      key_decisions: [],
      changed_files: ['packages/backend/src/session.routes.ts'],
      verification_summary: 'backend build passed',
      commit_refs: ['abc123'],
      resume_brief: '目标：继续前端接入\n未完成：SessionOS UI',
      compact_count: 1,
      fork_count: 0,
      created_at: now - 3_600_000,
      updated_at: now - 3_600_000,
    }],
    status: {
      goal: '把旧协作工作流切换为活跃会话模型',
      mode: 'code',
      phase: 'implementing',
      status: 'active',
      context: {
        totalTokenEstimate: 3200,
        latestCompactionId: null,
        retainedRecentMessages: 20,
        pressure: 'low',
      },
      git: {
        branchName: 'feat/session-os',
        changedFileCount: 3,
        hasUncommittedDiff: true,
        conflictRisk: 'low',
      },
      verification: {
        lastCommand: 'npm run build',
        status: 'passed',
        completedAt: now - 20_000,
      },
      blocker: null,
      nextAction: {
        label: '继续会话',
        command: null,
        reason: '没有终态阻塞',
      },
      provider: {
        backend: 'codex',
        model: 'gpt-5.5',
        permissionMode: 'workspace-write',
      },
    },
    context: {
      id: 'context-1',
      session_id: 'session-1',
      run_id: null,
      total_token_estimate: 3200,
      prompt_hash: null,
      created_at: now,
      sources: [{
        id: 'source-1',
        manifest_id: 'context-1',
        session_id: 'session-1',
        source_type: 'agents',
        source_ref: 'AGENTS.md',
        title: 'AGENTS.md',
        included: 1,
        priority: 1,
        token_estimate: 1200,
        reason: '项目规则',
        content_hash: 'hash',
        excerpt: '默认使用 Superpowers',
        metadata: null,
        created_at: now,
      }],
    },
    evidence: [{
      id: 'evidence-1',
      session_id: 'session-1',
      seq: 1,
      event_type: 'file_diff',
      severity: 'info',
      source_run_id: 'run-1',
      source_message_id: null,
      title: 'File diff',
      summary: 'Updated session UI',
      payload: { path: 'packages/frontend/src/session-ui/SessionShell.tsx' },
      created_at: now - 30_000,
    }],
    projectSwitcher: {
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'OpenClaw',
        path: '/workspace/openclaw',
        active: true,
        created_at: now - 86_400_000,
        updated_at: now - 2_000,
        pinned_at: null,
        sort_order: null,
        recentSessions: [{
          id: 'session-1',
          title: 'SessionOS 迁移',
          status: 'active',
          updated_at: now,
          href: '/projects/project-1/sessions/session-1',
          source: 'session',
        }],
      }],
    },
    bottomStatus: {
      health: 'ok',
      healthLabel: '良好',
      indexStatus: 'unknown',
      indexLabel: '未接入索引',
      lastResponseMs: 1000,
      errorRate: 0,
      networkLatencyMs: null,
      tokenUsage: null,
    },
    contract: {
      sessionId: 'session-1',
      objective: '把旧协作工作流切换为活跃会话模型',
      reason: '用户描述了 active runs 删除失败，需要自动停止任务后删除项目',
      scope: '仅补齐 Session OS 后端接入',
      risks: ['retry 可能重复执行 prompt'],
      acceptanceCriteria: ['页面不显示静态 mock 数据'],
      updated_at: now,
    },
    toolRows: [{
      id: 'tool-1',
      action: 'edit',
      label: '文件变更',
      target: 'packages/frontend/src/session-ui/SessionShell.tsx',
      status: 'completed',
      durationMs: null,
      severity: 'info',
      eventId: 'evidence-1',
      created_at: now,
    }],
    diffRows: [{
      path: 'packages/frontend/src/session-ui/SessionShell.tsx',
      status: 'modified',
      additions: 12,
      deletions: 3,
      summary: 'M',
    }],
    historyFilters: { q: '', status: 'all', mode: 'all' },
  };
}

function createProjectUsedAgentsPayload(agent: { agent_id: string; name: string }): ProjectUsedAgentsPayload {
  return {
    planner: {
      kind: 'session_planner',
      agent_id: 'planner',
      name: 'Planner',
      effective_acp_backend: 'codex',
      project_override_acp_backend: null,
      backend_source: 'builtin',
      runtime_profile: {
        permission_mode: 'workspace-write',
        runtime_backend: 'acp',
        tool_policy: { allowed: [] },
        workspace_policy: { read: ['.'], write: ['.'] },
        memory_scope: 'project',
      },
    },
    agents: [{
      kind: 'room_agent',
      global_agent_id: null,
      agent_id: agent.agent_id,
      name: agent.name,
      acp_enabled: true,
      acp_backend: 'codex',
      room_bindings: [{
        room_id: 'room-1',
        room_name: 'Room One',
        room_agent_id: 'room-agent-1',
        acp_backend: 'codex',
        workflow_role: 'executor',
      }],
    }],
  };
}

function createActiveSummary(
  overrides: Partial<ActiveSessionSummary> & Pick<ActiveSessionSummary, 'id' | 'project_id' | 'title'>,
): ActiveSessionSummary {
  const now = Date.now();
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    project_name: overrides.project_name ?? `Project ${overrides.project_id}`,
    project_path: overrides.project_path ?? `/workspace/${overrides.project_id}`,
    title: overrides.title,
    status: overrides.status ?? 'active',
    phase: overrides.phase ?? 'implementing',
    provider: overrides.provider ?? 'codex',
    model: overrides.model ?? 'gpt-5.5',
    pinned_at: overrides.pinned_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_viewed_at: overrides.last_viewed_at ?? null,
    unread_count: overrides.unread_count ?? 0,
    active_run_count: overrides.active_run_count ?? 0,
    latest_event_summary: overrides.latest_event_summary ?? null,
  };
}

function renderSessionShell(
  payload: SessionWorkspacePayload,
  options: {
    projectAgents?: ProjectUsedAgentsPayload;
    onSaveKnowledge?: (input: SessionKnowledgeSaveInput) => void;
    onRetryRun?: (runId: string) => void;
    onApproveWorkflowArtifact?: (artifactVersionId: string) => void;
    savingKnowledgeKey?: SessionKnowledgeActionKey | null;
  } = {},
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.projectAgents) {
    queryClient.setQueryData(['project-used-agents', payload.project.id], options.projectAgents);
  }
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SessionShellView
          payload={payload}
          onSendMessage={() => undefined}
          onCommand={() => undefined}
          onRetryRun={options.onRetryRun}
          onSaveKnowledge={options.onSaveKnowledge}
          onApproveWorkflowArtifact={options.onApproveWorkflowArtifact}
          savingKnowledgeKey={options.savingKnowledgeKey}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
