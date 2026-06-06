import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionWorkspacePayload } from '../lib/types';
import { SessionShellView } from './SessionShellView';

test('SessionShell renders Deepsea command center modules', () => {
  const html = renderToStaticMarkup(
    <SessionShellView payload={createPayload()} onSendMessage={() => undefined} onCommand={() => undefined} />,
  );

  assert.match(html, /Session Operations Console/);
  assert.match(html, /深海指挥中心/);
  assert.match(html, /蟹老板 AI 指挥官 Logo/);
  assert.match(html, /deepsea-profile-avatar\.png/);
  assert.match(html, /项目首页菜单/);
  assert.match(html, /会话/);
  assert.match(html, /聊天/);
  assert.match(html, /智能体/);
  assert.match(html, /Project command bar/);
  assert.match(html, /workspace/);
  assert.match(html, /切换项目/);
  assert.match(html, /项目切换器/);
  assert.match(html, /选择一个工作区以继续您的任务/);
  assert.match(html, /OpenClaw/);
  assert.doesNotMatch(html, /deepsea-command-center/);
  assert.doesNotMatch(html, /quantum-core-engine/);
  assert.doesNotMatch(html, /nebula-ui-kit/);
  assert.doesNotMatch(html, /retry_handler\.py/);
  assert.doesNotMatch(html, /sync_service\.py/);
  assert.doesNotMatch(html, /1,242 tokens/);
  assert.doesNotMatch(html, /分析当前会话页面结构/);
  assert.doesNotMatch(html, /还原 Deepsea 三栏布局/);
  assert.doesNotMatch(html, /运行浏览器 smoke test/);
  assert.match(html, /当前激活/);
  assert.match(html, /新建项目/);
  assert.match(html, /管理所有工作区/);
  assert.match(html, /上下文压力/);
  assert.match(html, /Session status bar/);
  assert.match(html, /会话历史/);
  assert.match(html, /3. 对话记录/);
  assert.match(html, /目标契约/);
  assert.match(html, /会话计划/);
  assert.match(html, /代理运行/);
  assert.match(html, /工具调用/);
  assert.match(html, /待提交变更/);
  assert.match(html, /UNCOMMITTED/);
  assert.match(html, /存在未应用的 Compact 预览/);
  assert.match(html, /立即应用/);
  assert.match(html, /data-command="\/new"/);
  assert.match(html, /data-command="\/compact"/);
  assert.match(html, /\/fork history:history-1/);
  assert.match(html, /History Records/);
  assert.doesNotMatch(html, /task-workspace/);
  assert.doesNotMatch(html, /chat-panel/);
  assert.doesNotMatch(html, /Deepsea Command/);
  assert.doesNotMatch(html, /deepsea-model-status/);
  assert.doesNotMatch(html, /当前状态/);
});

test('SessionShell renders agent thought above run output without leaking runtime prompt', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.prompt = '本轮 prompt 来源由 SessionOS Context Inspector 记录。\n\n## Context Sources\n### AGENTS.md\n内部运行时提示不应显示';
  run.status = 'running';
  run.stdout = '';
  run.stderr = '';
  run.activity_log = '分析用户问题，检查会话上下文，并准备简短回复。';

  const html = renderToStaticMarkup(
    <SessionShellView payload={payload} onSendMessage={() => undefined} onCommand={() => undefined} />,
  );

  assert.doesNotMatch(html, /本轮 prompt 来源由 SessionOS Context Inspector 记录/);
  assert.match(html, /智能体思考过程/);
  assert.match(html, /分析用户问题，检查会话上下文，并准备简短回复。/);
  assert.match(html, /等待智能体输出/);
  assert.ok(html.indexOf('智能体思考过程') < html.indexOf('ASSISTANT'));
});

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
        current_goal: '把旧协作工作流切换为会话历史模型',
        mode: 'code',
        phase: 'implementing',
        status: 'active',
        provider: 'codex',
        model: 'gpt-test',
        workspace_path: '/workspace/openclaw',
        worktree_path: null,
        branch_name: 'feat/session-os',
        forked_from_session_id: null,
        forked_from_history_record_id: null,
        latest_compaction_id: null,
        latest_context_manifest_id: 'context-1',
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
        provider: 'codex',
        model: 'gpt-test',
        status: 'completed',
        mode: 'code',
        phase: 'implementing',
        prompt: '继续执行计划',
        stdout: 'done',
        stderr: '',
        activity_log: '',
        error: null,
        acp_session_id: 'acp-1',
        started_at: now - 50_000,
        updated_at: now - 40_000,
        completed_at: now - 40_000,
      }],
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
      goal: '把旧协作工作流切换为会话历史模型',
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
        model: 'gpt-test',
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
      objective: '把旧协作工作流切换为会话历史模型',
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
