import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupervisorMessages, parseWorkflowSupervisorDecision } from './supervisor.js';

test('parseWorkflowSupervisorDecision parses fenced selection JSON', () => {
  const decision = parseWorkflowSupervisorDecision(`
\`\`\`json
{
  "mode": "select_existing_workflow",
  "workflowDefinitionId": "wf-1",
  "confidence": 0.86,
  "reason": "前后端协作更合适。",
  "assignments": [
    {
      "stage": "implementation",
      "role": "executor",
      "agentId": "frontend-executor",
      "reason": "scope includes packages/frontend"
    }
  ],
  "fallbackMode": "default_workflow"
}
\`\`\`
`);

  assert.equal(decision.mode, 'select_existing_workflow');
  assert.equal(decision.workflowDefinitionId, 'wf-1');
  assert.equal(decision.confidence, 0.86);
  assert.equal(decision.assignments[0]?.agentId, 'frontend-executor');
});

test('parseWorkflowSupervisorDecision rejects invalid confidence and unknown modes', () => {
  assert.throws(
    () => parseWorkflowSupervisorDecision('{"mode":"select_existing_workflow","workflowDefinitionId":"wf","confidence":2,"reason":"bad"}'),
    /confidence/,
  );
  assert.throws(
    () => parseWorkflowSupervisorDecision('{"mode":"invent","confidence":0.5,"reason":"bad"}'),
    /Invalid enum value|invalid/i,
  );
});

test('parseWorkflowSupervisorDecision accepts temporary workflow proposals as non-executable recommendations', () => {
  const decision = parseWorkflowSupervisorDecision(JSON.stringify({
    mode: 'propose_temporary_workflow',
    confidence: 0.91,
    reason: '没有合适的已发布 workflow。',
    fallbackMode: 'default_workflow',
    draft: {
      name: '临时安全审查流程',
    },
  }));

  assert.equal(decision.mode, 'propose_temporary_workflow');
  assert.equal(decision.workflowDefinitionId, null);
});

test('buildSupervisorMessages includes task, workflows, and executable agents', () => {
  const messages = buildSupervisorMessages({
    project: {
      id: 'project',
      name: 'Project',
      path: '/tmp/project',
      description: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: 1,
      updated_at: 1,
    },
    room: { id: 'room', project_id: 'project', name: 'Room', description: 'Feature room', created_at: 1 },
    task: {
      id: 'task',
      room_id: 'room',
      project_id: 'project',
      parent_task_id: null,
      title: '实现前端页面',
      description: '修改 packages/frontend/src/pages/RoomPage.tsx',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'auto_recommended',
      assigned_agent_id: null,
      source_message_id: null,
      created_from: 'manual',
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [
      {
        id: 'agent-1',
        room_id: 'room',
        global_agent_id: null,
        agent_id: 'frontend-executor',
        agent_name: 'Frontend Executor',
        agent_role: 'Frontend implementation',
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
        acp_permission_mode: 'bypass',
        acp_writable_dirs: [],
        capabilities: ['frontend'],
        default_runtime: 'acp',
        runtime_backend: null,
        tool_policy: null,
        workspace_policy: null,
        memory_scope: null,
        memory_max_context_chars: null,
      },
    ],
    workflowDefinitions: [
      {
        id: 'wf-1',
        name: '前端实现流程',
        description: 'Frontend workflow',
        scope: 'system',
        scope_id: 'default',
        version: 1,
        status: 'published',
        builtin_key: null,
        definition_json: '{"nodes":[],"edges":[]}',
        definition: { nodes: [], edges: [] },
        created_at: 1,
        updated_at: 1,
      },
    ],
  });

  const content = String(messages[1]?.content);
  assert.match(content, /实现前端页面/);
  assert.match(content, /frontend-executor/);
  assert.match(content, /前端实现流程/);
});
