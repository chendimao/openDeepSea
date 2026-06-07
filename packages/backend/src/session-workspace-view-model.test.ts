import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionAgentEvent } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-view-model-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { db } = await import('./db.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const {
  buildSessionBottomStatus,
  buildSessionDiffRows,
  buildSessionDiffRowsFromAcp,
  buildSessionInspectorSnapshot,
  buildSessionPlanItemsFromAcp,
  buildSessionProjectSwitcher,
  buildSessionToolRows,
} = await import('./session-workspace-view-model.js');

test('buildSessionProjectSwitcher uses real projects and recent session/history data', () => {
  const project = projectRepo.create({
    name: '真实项目',
    path: mkdtempSync(join(tmpdir(), 'session-switcher-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: '真实会话', workspace_path: project.path });
  historyRecordRepo.create({
    project_id: project.id,
    session_id: session.id,
    title: '历史记录',
    summary: '历史摘要',
    status: 'archived',
    mode: 'code',
    started_at: Date.now() - 1000,
    ended_at: Date.now(),
    key_decisions: [],
    changed_files: [],
    verification_summary: null,
    commit_refs: [],
    resume_brief: '目标：历史记录',
    compact_count: 0,
  });

  const switcher = buildSessionProjectSwitcher(project.id);

  assert.equal(switcher.activeProjectId, project.id);
  assert.equal(switcher.projects.some((item) => item.name === '真实项目'), true);
  assert.equal(switcher.projects.find((item) => item.id === project.id)?.recentSessions[0]?.title, '真实会话');
});

test('buildSessionToolRows maps evidence to stable display rows without fallback data', () => {
  const project = projectRepo.create({
    name: 'tool project',
    path: mkdtempSync(join(tmpdir(), 'session-tool-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Tool Session' });
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    mode: 'code',
    prompt: 'read file',
  });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_read',
    source_run_id: run.id,
    title: 'Read file',
    summary: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    payload: { path: 'packages/frontend/src/session-ui/SessionShellView.tsx' },
  });

  const rows = buildSessionToolRows([event]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.action, 'read');
  assert.equal(rows[0]?.target, 'packages/frontend/src/session-ui/SessionShellView.tsx');
  assert.equal(rows[0]?.eventId, event.id);
});

test('buildSessionPlanItemsFromAcp derives plan items from ACP plan_update evidence', () => {
  const project = projectRepo.create({
    name: 'plan project',
    path: mkdtempSync(join(tmpdir(), 'session-plan-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Plan Session' });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: '计划更新',
    payload: {
      event: {
        type: 'plan_update',
        payload: {
          entries: [
            { id: 'read-context', title: '读取上下文', status: 'completed' },
            { id: 'wire-data', title: '接入真实数据', status: 'in_progress' },
          ],
        },
      },
    },
  });

  const items = buildSessionPlanItemsFromAcp(session.id, [event], []);

  assert.deepEqual(items.map((item) => ({
    title: item.title,
    status: item.status,
    source: item.source,
    evidence_event_id: item.evidence_event_id,
    priority: item.priority,
  })), [
    {
      title: '读取上下文',
      status: 'completed',
      source: 'acp_plan_update',
      evidence_event_id: event.id,
      priority: 0,
    },
    {
      title: '接入真实数据',
      status: 'in_progress',
      source: 'acp_plan_update',
      evidence_event_id: event.id,
      priority: 1,
    },
  ]);
});

test('buildSessionPlanItemsFromAcp selects the newest ACP plan batch across evidence and agent events', () => {
  const project = projectRepo.create({
    name: 'plan order project',
    path: mkdtempSync(join(tmpdir(), 'session-plan-order-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Plan Order Session' });
  const newerEvidence = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: '新计划',
    payload: {
      event: {
        type: 'plan_update',
        payload: {
          entries: [{ id: 'new-plan', title: '新计划项', status: 'in_progress' }],
        },
      },
    },
  });
  const olderAgentEvent = createAgentEvent({
    sessionId: session.id,
    id: 'older-agent-plan',
    createdAt: newerEvidence.created_at - 10_000,
    payload: {
      event: {
        type: 'plan_update',
        payload: {
          entries: [{ id: 'old-plan', title: '旧计划项', status: 'completed' }],
        },
      },
    },
  });

  const items = buildSessionPlanItemsFromAcp(session.id, [newerEvidence], [olderAgentEvent]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'new-plan');
  assert.equal(items[0]?.title, '新计划项');
});

test('buildSessionToolRows prefers ACP tool names and targets', () => {
  const project = projectRepo.create({
    name: 'tool acp project',
    path: mkdtempSync(join(tmpdir(), 'session-tool-acp-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Tool ACP Session' });
  const patchEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: '调用工具 apply_patch',
    payload: {
      event: {
        type: 'tool_call',
        status: 'started',
        payload: {
          name: 'apply_patch',
          input: '*** Update File: packages/frontend/src/session-ui/SessionShellView.tsx',
        },
      },
    },
  });
  const commandEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: 'Command: npm run build',
    payload: {
      trace: {
        kind: 'command',
        command: 'npm run build',
      },
    },
  });

  const rows = buildSessionToolRows([patchEvent, commandEvent]);

  assert.equal(rows[0]?.action, 'edit');
  assert.equal(rows[0]?.label, 'apply_patch');
  assert.equal(rows[0]?.target, 'packages/frontend/src/session-ui/SessionShellView.tsx');
  assert.equal(rows[0]?.status, 'running');
  assert.equal(rows[1]?.action, 'exec');
  assert.equal(rows[1]?.target, 'npm run build');
});

test('buildSessionToolRows includes legacy status evidence with raw ACP tool type', () => {
  const project = projectRepo.create({
    name: 'legacy raw tool project',
    path: mkdtempSync(join(tmpdir(), 'session-legacy-raw-tool-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Legacy Raw Tool Session' });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: 'tool_call',
    payload: {
      rawType: 'tool_call',
      rawEvent: {
        method: 'session/update',
        params: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            kind: 'execute',
            rawInput: {
              command: ['/bin/zsh', '-lc', 'echo hi'],
              cwd: '/workspace',
            },
            status: 'in_progress',
            title: 'echo hi',
          },
        },
      },
    },
  });

  const rows = buildSessionToolRows([event]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.action, 'exec');
  assert.equal(rows[0]?.target, 'echo hi');
  assert.equal(rows[0]?.status, 'running');
});

test('buildSessionToolRows merges ACP tool updates with execution detail and duration', () => {
  const project = projectRepo.create({
    name: 'raw output tool project',
    path: mkdtempSync(join(tmpdir(), 'session-raw-output-tool-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Raw Output Tool Session' });
  const startedAt = 1_780_000_001_000;
  const completedAt = 1_780_000_004_250;
  const startEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: 'tool_call',
    payload: {
      rawType: 'tool_call',
      rawEvent: {
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-shell-1',
            kind: 'execute',
            status: 'in_progress',
            title: 'echo hi',
            rawInput: {
              call_id: 'call-shell-1',
              started_at_ms: startedAt,
              command: ['/bin/zsh', '-lc', 'echo hi'],
              cwd: '/workspace',
            },
          },
        },
      },
    },
  });
  const updateEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: 'tool_call_update',
    payload: {
      rawType: 'tool_call_update',
      rawEvent: {
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-shell-1',
            status: 'completed',
            rawOutput: {
              call_id: 'call-shell-1',
              started_at_ms: startedAt,
              completed_at_ms: completedAt,
              command: ['/bin/zsh', '-lc', 'echo hi'],
              cwd: '/workspace',
              stdout: 'hi\n',
              stderr: '',
              exit_code: 0,
            },
          },
        },
      },
    },
  });

  const rows = buildSessionToolRows([startEvent, updateEvent]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.target, 'echo hi');
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(rows[0]?.durationMs, 3250);
  assert.equal(rows[0]?.command, 'echo hi');
  assert.equal(rows[0]?.output, 'hi');
  assert.match(rows[0]?.detail ?? '', /\$ echo hi/);
  assert.match(rows[0]?.detail ?? '', /hi/);
  assert.equal(rows[0]?.startedAt, startedAt);
  assert.equal(rows[0]?.completedAt, completedAt);
});

test('buildSessionToolRows includes the parent run duration for tool display', () => {
  const project = projectRepo.create({
    name: 'tool run duration project',
    path: mkdtempSync(join(tmpdir(), 'session-tool-run-duration-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Tool Run Duration Session' });
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    mode: 'code',
    prompt: 'read local file',
  });
  db.prepare('UPDATE session_runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run('completed', run.started_at + 21_423, run.started_at + 21_423, run.id);
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    source_run_id: run.id,
    title: 'tool_call_update',
    payload: {
      rawType: 'tool_call_update',
      rawEvent: {
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-shell-run-duration',
            status: 'completed',
            rawOutput: {
              call_id: 'call-shell-run-duration',
              started_at_ms: 1_780_000_001_532,
              completed_at_ms: 1_780_000_001_875,
              command: ['/bin/zsh', '-lc', 'sed -n "1,160p" SKILL.md'],
              stdout: 'content\n',
              exit_code: 0,
            },
          },
        },
      },
    },
  });

  const rows = buildSessionToolRows([event], [sessionRunRepo.get(run.id)!]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.durationMs, 343);
  assert.equal(rows[0]?.runDurationMs, 21_423);
});

test('buildSessionDiffRowsFromAcp includes only ACP file changes and aggregates duplicate files', () => {
  const project = projectRepo.create({
    name: 'diff acp project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-acp-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff ACP Session' });
  const diffEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_diff',
    title: '修改文件 packages/frontend/src/session-ui/SessionShellView.tsx',
    payload: {
      event: {
        type: 'file_diff',
        payload: {
          path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
          additions: 12,
          deletions: 3,
        },
      },
    },
  });
  const patchEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: '调用工具 apply_patch',
    payload: {
      event: {
        type: 'tool_call',
        payload: {
          name: 'apply_patch',
          input: '*** Update File: packages/frontend/src/session-ui/SessionShellView.tsx',
        },
      },
    },
  });

  const rows = buildSessionDiffRowsFromAcp([diffEvent, patchEvent], []);

  assert.deepEqual(rows, [{
    path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    status: 'modified',
    additions: 12,
    deletions: 3,
    summary: 'apply_patch',
  }]);
});

test('buildSessionDiffRowsFromAcp does not double count the same ACP file diff from evidence and agent event', () => {
  const project = projectRepo.create({
    name: 'diff dedupe project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-dedupe-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff Dedupe Session' });
  const payload = {
    event: {
      type: 'file_diff',
      payload: {
        tool_call_id: 'tool-diff-1',
        path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
        additions: 12,
        deletions: 3,
      },
    },
  };
  const evidence = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_diff',
    title: '文件变更',
    payload,
  });
  const agentEvent = createAgentEvent({
    sessionId: session.id,
    id: 'agent-diff-1',
    createdAt: evidence.created_at,
    payload: {
      type: 'file_diff',
      tool_call_id: 'tool-diff-1',
      path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
      additions: 12,
      deletions: 3,
    },
  });

  const rows = buildSessionDiffRowsFromAcp([evidence], [agentEvent]);

  assert.deepEqual(rows, [{
    path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    status: 'modified',
    additions: 12,
    deletions: 3,
    summary: '文件变更',
  }]);
});

test('buildSessionDiffRowsFromAcp keeps diff stats when a patch tool call and file diff share a tool id', () => {
  const project = projectRepo.create({
    name: 'diff tool id project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-tool-id-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff Tool Id Session' });
  const patchEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: '调用工具 apply_patch',
    payload: {
      event: {
        id: 'timeline-tool-1',
        type: 'tool_call',
        payload: {
          id: 'tool-shared-1',
          name: 'apply_patch',
          input: '*** Update File: packages/frontend/src/session-ui/SessionShellView.tsx',
        },
      },
    },
  });
  const diffEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_diff',
    title: '文件变更',
    payload: {
      event: {
        id: 'timeline-diff-1',
        type: 'file_diff',
        payload: {
          tool_call_id: 'tool-shared-1',
          path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
          additions: 12,
          deletions: 3,
        },
      },
    },
  });

  const rows = buildSessionDiffRowsFromAcp([patchEvent, diffEvent], []);

  assert.deepEqual(rows, [{
    path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    status: 'modified',
    additions: 12,
    deletions: 3,
    summary: '文件变更',
  }]);
});

test('buildSessionDiffRowsFromAcp preserves specific patch status when merging later diff stats', () => {
  const project = projectRepo.create({
    name: 'diff patch status project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-patch-status-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff Patch Status Session' });
  const patchEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: '调用工具 apply_patch',
    payload: {
      event: {
        type: 'tool_call',
        payload: {
          id: 'tool-add-1',
          name: 'apply_patch',
          input: '*** Add File: packages/frontend/src/session-ui/new-panel.tsx',
        },
      },
    },
  });
  const diffEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_diff',
    title: '文件变更',
    payload: {
      event: {
        type: 'file_diff',
        payload: {
          tool_call_id: 'tool-add-1',
          path: 'packages/frontend/src/session-ui/new-panel.tsx',
          additions: 5,
          deletions: 0,
        },
      },
    },
  });

  const rows = buildSessionDiffRowsFromAcp([patchEvent, diffEvent], []);

  assert.deepEqual(rows, [{
    path: 'packages/frontend/src/session-ui/new-panel.tsx',
    status: 'added',
    additions: 5,
    deletions: 0,
    summary: '文件变更',
  }]);
});

test('buildSessionDiffRowsFromAcp extracts nested file diff payloads from ACP agent events', () => {
  const project = projectRepo.create({
    name: 'diff nested agent project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-nested-agent-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff Nested Agent Session' });
  const agentEvent = createAgentEvent({
    sessionId: session.id,
    id: 'agent-nested-diff-1',
    createdAt: Date.now(),
    payload: {
      event: {
        id: 'timeline-diff-1',
        type: 'file_diff',
        payload: {
          tool_call_id: 'tool-nested-1',
          path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
          additions: 4,
          deletions: 1,
        },
      },
    },
  });

  const rows = buildSessionDiffRowsFromAcp([], [agentEvent]);

  assert.deepEqual(rows, [{
    path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    status: 'modified',
    additions: 4,
    deletions: 1,
    summary: 'status',
  }]);
});

test('buildSessionDiffRowsFromAcp extracts every file from a multi-file apply_patch call', () => {
  const project = projectRepo.create({
    name: 'diff multi patch project',
    path: mkdtempSync(join(tmpdir(), 'session-diff-multi-patch-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Diff Multi Patch Session' });
  const patchEvent = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'tool_call',
    title: '调用工具 apply_patch',
    payload: {
      event: {
        type: 'tool_call',
        payload: {
          name: 'apply_patch',
          input: [
            '*** Begin Patch',
            '*** Update File: packages/frontend/src/session-ui/SessionShellView.tsx',
            '@@',
            '-old',
            '+new',
            '*** Add File: packages/frontend/src/session-ui/new-panel.tsx',
            '+export const value = 1;',
            '*** Delete File: packages/frontend/src/session-ui/old-panel.tsx',
            '*** End Patch',
          ].join('\n'),
        },
      },
    },
  });

  const rows = buildSessionDiffRowsFromAcp([patchEvent], []);

  assert.deepEqual(rows.map((row) => ({ path: row.path, status: row.status })), [
    { path: 'packages/frontend/src/session-ui/SessionShellView.tsx', status: 'modified' },
    { path: 'packages/frontend/src/session-ui/new-panel.tsx', status: 'added' },
    { path: 'packages/frontend/src/session-ui/old-panel.tsx', status: 'deleted' },
  ]);
});

test('buildSessionInspectorSnapshot combines plan, tool and session change rows', () => {
  const project = projectRepo.create({
    name: 'inspector project',
    path: mkdtempSync(join(tmpdir(), 'session-inspector-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Inspector Session' });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: '计划更新',
    payload: {
      event: {
        type: 'plan_update',
        payload: { entries: [{ title: '实现派生层', status: 'pending' }] },
      },
    },
  });

  const snapshot = buildSessionInspectorSnapshot(session.id, [event], []);

  assert.equal(snapshot.planItems[0]?.title, '实现派生层');
  assert.deepEqual(snapshot.toolRows, []);
  assert.deepEqual(snapshot.diffRows, []);
});

test('buildSessionDiffRows reads real git status and numstat', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-diff-project-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');

  const rows = buildSessionDiffRows(root);

  assert.ok(rows.some((row) => row.path === 'tracked.txt' && row.status === 'modified'));
  assert.ok(rows.some((row) => row.path === 'new.txt' && row.status === 'untracked'));
});

test('buildSessionBottomStatus derives response and error metrics from runs', () => {
  const now = Date.now();
  const rows = buildSessionBottomStatus([
    { status: 'completed', started_at: now - 2000, completed_at: now - 1000, error: null } as never,
    { status: 'failed', started_at: now - 5000, completed_at: now - 4000, error: 'boom' } as never,
  ], []);

  assert.equal(rows.health, 'warning');
  assert.equal(rows.lastResponseMs, 1000);
  assert.equal(rows.errorRate, 0.5);
  assert.equal(rows.indexStatus, 'unknown');
});

test('buildSessionBottomStatus uses session token usage summary over legacy evidence usage', () => {
  const rows = buildSessionBottomStatus([], [{
    id: 'legacy-usage',
    session_id: 'session-1',
    seq: 1,
    event_type: 'status',
    severity: 'info',
    source_run_id: null,
    source_message_id: null,
    title: 'Legacy usage',
    summary: null,
    payload: { usage: { input_tokens: 1, output_tokens: 2 } },
    created_at: Date.now(),
  }], {
    input: 150,
    output: 30,
    total: 180,
  });

  assert.deepEqual(rows.tokenUsage, {
    input: 150,
    output: 30,
    total: 180,
  });
});

function createAgentEvent(input: {
  sessionId: string;
  id: string;
  createdAt: number;
  payload: Record<string, unknown>;
}): SessionAgentEvent {
  return {
    id: input.id,
    session_id: input.sessionId,
    agent_id: 'planner',
    run_id: 'run-1',
    seq: 1,
    channel: 'event',
    event_type: 'status',
    content: '',
    payload_json: JSON.stringify(input.payload),
    created_at: input.createdAt,
  };
}
