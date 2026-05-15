import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLangChainPlan, getLangChainPlannerConfig } from './langchain-planner.js';
import type { Room, RoomAgent, Task } from '../types.js';

test('getLangChainPlannerConfig returns disabled config when no model is configured', () => {
  const config = getLangChainPlannerConfig({
    LANGCHAIN_PLANNER_MODEL: '',
    OPENAI_API_KEY: '',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.model, null);
});

test('generateLangChainPlan validates model output into ParsedPlan', async () => {
  const plan = await generateLangChainPlan(
    {
      projectName: 'OpenDeepSea',
      projectPath: '/repo/openDeepSea',
      room: fakeRoom(),
      task: fakeTask(),
      agents: [fakeAgent()],
      memories: ['Prefer minimal scoped changes.'],
      recentMessages: ['User asked for Task 3 implementation.'],
    },
    {
      async invoke() {
        return `\`\`\`json
{
  "goal": "Implement LangChain planner service",
  "summary": "Create a testable planner service.",
  "assumptions": ["Use fake invoker in tests."],
  "steps": [
    {
      "title": "Implement planner service",
      "intent": "Add service API that formats context and parses model output.",
      "assigneeRole": "executor",
      "preferredBackend": "codex",
      "scopeRead": ["packages/backend/src/workflows/langchain-planner.ts"],
      "scopeWrite": ["packages/backend/src/workflows/langchain-planner.ts"],
      "acceptance": ["Service returns ParsedPlan."],
      "dependsOn": []
    }
  ],
  "risks": [],
  "verification": [
    {
      "command": "node --import tsx --test src/workflows/langchain-planner.test.ts",
      "reason": "Verify planner service behavior.",
      "required": true
    }
  ],
  "needsApproval": false
}
\`\`\``;
      },
    },
  );

  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]?.suggestedRole, 'executor');
});

function fakeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    project_id: 'project-1',
    name: 'Engineering',
    description: 'Implementation room',
    created_at: 1,
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    room_id: 'room-1',
    project_id: 'project-1',
    parent_task_id: null,
    title: 'Task 3',
    description: 'Implement LangChain Planner Service with Test Double Support.',
    status: 'todo',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: null,
    source_message_id: null,
    created_from: 'manual',
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    ...overrides,
  };
}

function fakeAgent(overrides: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 'room-agent-1',
    room_id: 'room-1',
    agent_id: 'agent-1',
    agent_name: 'Codex',
    agent_role: 'Implementation agent',
    workflow_role: 'executor',
    joined_at: 1,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: ['/repo/openDeepSea'],
    memory_max_context_chars: null,
    ...overrides,
  };
}
