import test from 'node:test';
import assert from 'node:assert/strict';
import type { RoomAgent, WorkflowIncident } from '../types.js';
import {
  buildRecoverySupervisorMessages,
  decideRecovery,
  decideRecoveryByDefaultPolicy,
  parseWorkflowRecoveryDecision,
} from './recovery-supervisor.js';

test('parseWorkflowRecoveryDecision parses retry_same_agent fenced JSON', () => {
  const decision = parseWorkflowRecoveryDecision(`
\`\`\`json
{
  "action": "retry_same_agent",
  "reason": "后端重启导致子任务中断，原智能体上下文仍可继续。",
  "confidence": 0.82
}
\`\`\`
`);

  assert.equal(decision.action, 'retry_same_agent');
  assert.equal(decision.reason, '后端重启导致子任务中断，原智能体上下文仍可继续。');
  assert.equal(decision.confidence, 0.82);
});

test('parseWorkflowRecoveryDecision parses global agent retry and reassignment targets', () => {
  const globalRetry = parseWorkflowRecoveryDecision(JSON.stringify({
    action: 'retry_with_global_agent',
    reason: '聊天室没有可用 executor，需要拉入全局后端智能体。',
    confidence: 0.74,
    globalAgentTemplateId: 'global-backend',
  }));
  const reassignment = parseWorkflowRecoveryDecision(JSON.stringify({
    action: 'reassign_agent',
    reason: '当前智能体 workspace 不匹配，改派已有后端执行智能体。',
    confidence: 0.79,
    targetRoomAgentId: 'room-agent-backend',
  }));

  assert.equal(globalRetry.globalAgentTemplateId, 'global-backend');
  assert.equal(reassignment.targetRoomAgentId, 'room-agent-backend');
});

test('parseWorkflowRecoveryDecision parses split_task payload', () => {
  const decision = parseWorkflowRecoveryDecision(JSON.stringify({
    action: 'split_task',
    reason: '原子任务过大，拆成后端模型和 API 两个子任务。',
    confidence: 0.68,
    splitTasks: [
      {
        title: '实现模型',
        description: '补充数据库模型',
        scopeRead: ['packages/backend/src/db.ts'],
        scopeWrite: ['packages/backend/src/repos/assets.ts'],
      },
      {
        title: '实现接口',
        description: '补充路由',
        scopeRead: ['packages/backend/src/server.ts'],
        scopeWrite: ['packages/backend/src/assets.routes.ts'],
      },
    ],
  }));

  assert.equal(decision.action, 'split_task');
  assert.equal(decision.splitTasks?.length, 2);
  assert.equal(decision.splitTasks?.[0]?.title, '实现模型');
});

test('parseWorkflowRecoveryDecision rejects unknown actions and missing reason', () => {
  assert.throws(
    () => parseWorkflowRecoveryDecision('{"action":"blind_retry","reason":"bad","confidence":0.5}'),
    /Invalid enum value|invalid/i,
  );
  assert.throws(
    () => parseWorkflowRecoveryDecision('{"action":"retry_same_agent","confidence":0.5}'),
    /reason/,
  );
});

test('decideRecoveryByDefaultPolicy retries backend restart once and escalates repeated interruptions', () => {
  const first = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({ incident_type: 'backend_restart_interrupted', attempt_count: 0 }),
  }));
  const repeated = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({ incident_type: 'backend_restart_interrupted', attempt_count: 2 }),
  }));

  assert.equal(first.action, 'retry_same_agent');
  assert.equal(repeated.action, 'ask_user');
  assert.match(repeated.userQuestion ?? '', /连续中断/);
});

test('decideRecoveryByDefaultPolicy provisions global agent for executor_unavailable', () => {
  const decision = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({ incident_type: 'executor_unavailable' }),
  }));

  assert.equal(decision.action, 'retry_with_global_agent');
});

test('decideRecoveryByDefaultPolicy reassigns runtime mismatch to compatible room agent', () => {
  const decision = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({
      incident_type: 'runtime_boundary_mismatch',
      room_agent_id: 'frontend-agent',
      context_json: JSON.stringify({
        scopeWrite: ['packages/backend/src/repos/assets.ts'],
        requiredCapabilities: ['backend'],
      }),
    }),
    agents: [
      roomAgent({ id: 'frontend-agent', capabilities: ['frontend'] }),
      roomAgent({ id: 'backend-agent', capabilities: ['backend'], agent_name: 'Backend Agent' }),
    ],
  }));

  assert.equal(decision.action, 'reassign_agent');
  assert.equal(decision.targetRoomAgentId, 'backend-agent');
});

test('decideRecoveryByDefaultPolicy falls back to global agent when no compatible room agent exists', () => {
  const decision = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({
      incident_type: 'runtime_boundary_mismatch',
      context_json: JSON.stringify({ requiredCapabilities: ['backend'] }),
    }),
    agents: [roomAgent({ id: 'frontend-agent', capabilities: ['frontend'] })],
  }));

  assert.equal(decision.action, 'retry_with_global_agent');
});

test('decideRecoveryByDefaultPolicy blocks unknown incidents', () => {
  const decision = decideRecoveryByDefaultPolicy(baseRecoveryInput({
    incident: incident({ incident_type: 'unknown' }),
  }));

  assert.equal(decision.action, 'mark_blocked');
});

test('buildRecoverySupervisorMessages includes incident, task, logs, attempts, and previous decisions', () => {
  const messages = buildRecoverySupervisorMessages(baseRecoveryInput({
    incident: incident({
      error: 'Backend restarted before workflow step completed',
      attempt_count: 1,
      context_json: JSON.stringify({
        stdout: 'started implementation',
        stderr: 'stdin is closed',
        activityLog: 'agent started then backend restarted',
      }),
    }),
    previousDecisions: [{ action: 'retry_same_agent', reason: 'first retry', confidence: 0.7 }],
  }));

  const systemContent = String(messages[0]?.content);
  const humanContent = String(messages[1]?.content);
  assert.match(systemContent, /Return only a fenced JSON object/);
  assert.match(humanContent, /Backend restarted before workflow step completed/);
  assert.match(humanContent, /stdin is closed/);
  assert.match(humanContent, /attempt_count/);
  assert.match(humanContent, /retry_same_agent/);
});

test('decideRecovery falls back to default policy when model output is invalid', async () => {
  const decision = await decideRecovery(
    baseRecoveryInput({ incident: incident({ incident_type: 'executor_unavailable' }) }),
    {
      invoker: {
        async invoke() {
          return '{"action":"unknown","confidence":2}';
        },
      },
    },
  );

  assert.equal(decision.action, 'retry_with_global_agent');
});

function baseRecoveryInput(patch: Partial<Parameters<typeof decideRecoveryByDefaultPolicy>[0]> = {}) {
  return {
    project: {
      id: 'project',
      name: 'Project',
      path: '/tmp/project',
      description: null,
    },
    room: {
      id: 'room',
      name: 'Room',
      description: 'Workflow room',
    },
    task: {
      id: 'task',
      title: '实现资源资产后端模型与接口',
      description: '修改 packages/backend/src/db.ts 和 routes',
      status: 'in_progress',
    },
    childTask: {
      id: 'child-task',
      title: '实现资源资产后端模型与接口',
      description: 'packages/backend 后端接口',
      status: 'in_progress',
    },
    workflowStep: {
      id: 'step',
      stage: 'implementation',
      status: 'interrupted',
      error: 'Backend restarted before workflow step completed',
    },
    incident: incident(),
    agents: [roomAgent({ id: 'executor-agent', capabilities: ['backend'] })],
    previousDecisions: [],
    ...patch,
  };
}

function incident(patch: Partial<WorkflowIncident> = {}): WorkflowIncident {
  return {
    id: 'incident',
    room_id: 'room',
    project_id: 'project',
    workflow_run_id: 'workflow',
    workflow_step_id: 'step',
    task_id: 'task',
    child_task_id: 'child-task',
    agent_run_id: 'agent-run',
    room_agent_id: 'executor-agent',
    incident_type: 'backend_restart_interrupted',
    status: 'open',
    severity: 'warning',
    fingerprint: 'fingerprint',
    error: null,
    context_json: '{}',
    decision_json: null,
    action: null,
    action_status: null,
    attempt_count: 0,
    last_message_id: null,
    created_at: 1,
    updated_at: 1,
    resolved_at: null,
    ...patch,
  };
}

function roomAgent(patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 'agent',
    room_id: 'room',
    global_agent_id: null,
    agent_id: 'agent',
    agent_name: 'Agent',
    agent_role: 'Implementation',
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_session_handoff_pending: 0,
    acp_session_handoff_reason: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: null,
    tool_policy: {
      allowed: ['read_files', 'write_files', 'run_shell'],
    },
    workspace_policy: {
      read: ['/tmp/project'],
      write: ['/tmp/project'],
    },
    memory_scope: null,
    memory_max_context_chars: null,
    ...patch,
  };
}
