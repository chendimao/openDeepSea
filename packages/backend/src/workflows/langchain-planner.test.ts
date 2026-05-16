import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LangChainPlannerError,
  buildChatOpenAIFields,
  extractPlannerText,
  generateLangChainPlan,
  getLangChainPlannerConfig,
  buildPlannerMessages,
  normalizeOpenAIBaseURL,
} from './langchain-planner.js';
import type { Room, RoomAgent, Task } from '../types.js';

test('getLangChainPlannerConfig returns disabled config when no model is configured', () => {
  const config = getLangChainPlannerConfig({
    LANGCHAIN_PLANNER_MODEL: '',
    OPENAI_API_KEY: '',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.model, null);
  assert.equal(config.apiKey, null);
  assert.equal(config.baseURL, null);
});

test('getLangChainPlannerConfig falls back to database settings and lets env override them', () => {
  const dbSettings = {
    langchain_planner_model: ' db-model ',
    openai_api_key: ' db-key ',
    openai_base_url: ' https://db.example ',
  };

  const fallback = getLangChainPlannerConfig({}, dbSettings);
  assert.equal(fallback.enabled, true);
  assert.equal(fallback.model, 'db-model');
  assert.equal(fallback.apiKey, 'db-key');
  assert.equal(fallback.baseURL, 'https://db.example/v1');

  const overridden = getLangChainPlannerConfig(
    {
      LANGCHAIN_PLANNER_MODEL: ' env-model ',
      OPENAI_API_KEY: ' env-key ',
      OPENAI_BASE_URL: ' https://env.example/v1 ',
    },
    dbSettings,
  );
  assert.equal(overridden.enabled, true);
  assert.equal(overridden.model, 'env-model');
  assert.equal(overridden.apiKey, 'env-key');
  assert.equal(overridden.baseURL, 'https://env.example/v1');
});

test('buildChatOpenAIFields passes api key and baseURL to ChatOpenAI configuration', () => {
  assert.deepEqual(
    buildChatOpenAIFields({
      enabled: true,
      model: 'gpt-4.1',
      apiKey: 'sk-test',
      baseURL: 'https://openai.example/v1',
    }),
    {
      model: 'gpt-4.1',
      temperature: 0,
      apiKey: 'sk-test',
      configuration: {
        baseURL: 'https://openai.example/v1',
      },
    },
  );
});

test('normalizeOpenAIBaseURL appends /v1 for root OpenAI-compatible hosts', () => {
  assert.equal(normalizeOpenAIBaseURL('https://yuzapi.fun'), 'https://yuzapi.fun/v1');
  assert.equal(normalizeOpenAIBaseURL('https://yuzapi.fun/'), 'https://yuzapi.fun/v1');
  assert.equal(normalizeOpenAIBaseURL('https://yuzapi.fun/v1'), 'https://yuzapi.fun/v1');
  assert.equal(normalizeOpenAIBaseURL('https://proxy.example/openai'), 'https://proxy.example/openai');
});

test('buildPlannerMessages uses current product name in system prompt', () => {
  const [systemMessage] = buildPlannerMessages({
    projectName: 'OpenDeepSea',
    projectPath: '/repo/openDeepSea',
    room: fakeRoom(),
    task: fakeTask(),
    agents: [],
    memories: [],
    recentMessages: [],
  });

  assert.ok(systemMessage);
  const systemContent = String(systemMessage.content);
  assert.match(systemContent, /OpenDeepSea/);
  assert.equal(systemContent.includes(`Open${'Claw'} Room`), false);
});

test('generateLangChainPlan validates model output into ParsedPlan', async () => {
  const plan = await generateLangChainPlan(
    {
      projectName: 'OpenDeepSea',
      projectPath: '/repo/openDeepSea',
      room: fakeRoom(),
      task: fakeTask(),
      agents: [
        fakeAgent({
          acp_session_id: 'session-1',
          acp_session_label: 'Planner session',
          acp_writable_dirs: ['/repo/openDeepSea/secret-write-dir'],
        }),
      ],
      memories: ['Prefer minimal scoped changes.'],
      recentMessages: ['User asked for Task 3 implementation.'],
    },
    {
      async invoke(messages) {
        assert.equal(messages.length, 2);

        const systemContent = String(messages[0]?.content);
        assert.match(systemContent, /goal/);
        assert.match(systemContent, /summary/);
        assert.match(systemContent, /assumptions/);
        assert.match(systemContent, /steps/);
        assert.match(systemContent, /risks/);
        assert.match(systemContent, /verification/);
        assert.match(systemContent, /needsApproval/);
        assert.match(systemContent, /analyst, planner, coordinator, executor, reviewer, acceptor/);
        assert.match(systemContent, /claudecode, opencode, codex/);

        const humanContent = String(messages[1]?.content);
        assert.match(humanContent, /OpenDeepSea/);
        assert.match(humanContent, /Task 3/);
        assert.match(humanContent, /Codex/);
        assert.match(humanContent, /Prefer minimal scoped changes/);
        assert.match(humanContent, /User asked for Task 3 implementation/);
        assert.doesNotMatch(humanContent, /session-1/);
        assert.doesNotMatch(humanContent, /\/repo\/openDeepSea\/secret-write-dir/);

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

test('generateLangChainPlan retries once after invalid model output', async () => {
  let attempts = 0;
  const plan = await generateLangChainPlan(
    basePlannerInput(),
    {
      async invoke() {
        attempts += 1;
        if (attempts === 1) return '{"goal":"missing required modern fields","steps":[]}';
        return validPlannerOutput();
      },
    },
    { maxAttempts: 2 },
  );

  assert.equal(attempts, 2);
  assert.equal(plan.tasks.length, 1);
});

test('generateLangChainPlan reports final raw output when retries fail', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      generateLangChainPlan(
        basePlannerInput(),
        {
          async invoke() {
            attempts += 1;
            return attempts === 1 ? '{"goal":"first invalid","steps":[]}' : '{"goal":"second invalid","steps":[]}';
          },
        },
        { maxAttempts: 2 },
      ),
    (err) => {
      assert.ok(err instanceof LangChainPlannerError);
      assert.equal(err.rawOutput, '{"goal":"second invalid","steps":[]}');
      assert.match(err.message, /failed after 2 attempts/i);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test('generateLangChainPlan retries after invoker errors', async () => {
  let attempts = 0;
  const plan = await generateLangChainPlan(
    basePlannerInput(),
    {
      async invoke() {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary planner transport error');
        return validPlannerOutput();
      },
    },
    { maxAttempts: 2 },
  );

  assert.equal(attempts, 2);
  assert.equal(plan.tasks.length, 1);
});

test('extractPlannerText concatenates text content blocks', () => {
  const text = extractPlannerText([
    { type: 'text', text: '```json\n' },
    { type: 'text', text: '{"goal":"Ship"}' },
    { type: 'unknown', value: 'fallback' },
  ]);

  assert.equal(text, '```json\n{"goal":"Ship"}{"type":"unknown","value":"fallback"}');
});

function basePlannerInput() {
  return {
    projectName: 'OpenDeepSea',
    projectPath: '/repo/openDeepSea',
    room: fakeRoom(),
    task: fakeTask(),
    agents: [fakeAgent()],
    memories: [],
    recentMessages: [],
  };
}

function validPlannerOutput(): string {
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
}

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
    global_agent_id: null,
    agent_id: 'agent-1',
    agent_name: 'Codex',
    agent_role: 'Implementation agent',
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    joined_at: 1,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: ['/repo/openDeepSea'],
    capabilities: [],
    default_runtime: 'acp',
    memory_max_context_chars: null,
    ...overrides,
  };
}
