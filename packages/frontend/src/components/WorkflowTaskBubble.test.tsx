import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import type { RoomAgent, TaskArtifact, WorkflowDetail, WorkflowPlanJson, WorkflowRun } from '../lib/types';
import { WorkflowTaskBubble } from './WorkflowTaskBubble';

setupBrowserStubs();

test('renders task table from graph_state workflowPlan', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
  });

  const html = renderBubble(detail, [createAgent()]);

  assert.match(html, /工作流子任务表格/);
  assert.match(html, /实现聊天气泡/);
  assert.match(html, /前端执行者/);
});

test('renders task table from artifact metadata workflow_plan_json', () => {
  const detail = createWorkflowDetail({
    artifacts: [
      createArtifact({
        metadata: JSON.stringify({ workflow_plan_json: createWorkflowPlan({ workflowName: 'Artifact Plan' }) }),
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()]);

  assert.match(html, /工作流子任务表格/);
  assert.match(html, /Artifact Plan/);
  assert.match(html, /实现聊天气泡/);
});

test('compact mode omits agent result tabs for chat embedding', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /工作流子任务表格/);
  assert.doesNotMatch(html, /按智能体查看执行结果/);
});

test('returns null when workflow plan is unavailable', () => {
  const detail = createWorkflowDetail();

  const html = renderBubble(detail, []);

  assert.equal(html, '');
});

function createWorkflowPlan(input: { workflowName?: string } = {}): WorkflowPlanJson {
  return {
    workflow_name: input.workflowName ?? 'Workflow Plan',
    source_message_id: 'message-1',
    goal: '在聊天消息内展示 workflow 子任务',
    summary: '最小接入 workflow task bubble',
    tasks: [
      {
        id: 'task-1',
        title: '实现聊天气泡',
        description: '在消息气泡里复用子任务表格',
        role: 'executor',
        agent_id: 'agent-1',
        mode: 'parallel',
        depends_on: [],
        status: 'running',
        progress: 40,
        result_refs: [],
      },
    ],
  };
}

function renderBubble(
  detail: WorkflowDetail,
  agents: RoomAgent[],
  options: { compact?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <WorkflowTaskBubble detail={detail} agents={agents} compact={options.compact} />
    </I18nProvider>,
  );
}

function setupBrowserStubs(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
}

function createWorkflowDetail(input: { graphState?: string | null; artifacts?: TaskArtifact[] } = {}): WorkflowDetail {
  return {
    run: createWorkflowRun({ graphState: input.graphState ?? null }),
    steps: [],
    artifacts: input.artifacts ?? [],
  };
}

function createWorkflowRun(input: { graphState: string | null }): WorkflowRun {
  return {
    id: 'workflow-1',
    room_id: 'room-1',
    project_id: 'project-1',
    task_id: 'task-root',
    status: 'running',
    current_stage: 'implementation',
    approval_required: 0,
    approved_at: null,
    approved_by: null,
    openclaw_flow_id: null,
    graph_version: 'graph-v1',
    graph_state: input.graphState,
    workflow_definition_id: null,
    workflow_definition_version: null,
    workflow_definition_snapshot: null,
    created_at: 1,
    updated_at: 2,
    completed_at: null,
    error: null,
  };
}

function createArtifact(input: { metadata: string | null }): TaskArtifact {
  return {
    id: 'artifact-1',
    task_id: 'task-root',
    workflow_run_id: 'workflow-1',
    workflow_step_id: null,
    artifact_type: 'plan',
    title: 'Plan',
    content: 'Plan content',
    metadata: input.metadata,
    created_at: 1,
  };
}

function createAgent(): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'frontend-executor',
    agent_name: '前端执行者',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: null,
    workspace_policy: null,
    memory_scope: null,
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  };
}
