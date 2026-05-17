import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCollaborationDecisionPrompt,
  parseCollaborationDecision,
  type CollaborationDecision,
} from './collaboration-decision.js';

test('parses valid JSON decision', () => {
  const output = JSON.stringify({
    intent: 'implementation',
    recommendedMode: 'formal_workflow',
    problemArea: 'backend',
    summary: '需要修改后端分发逻辑',
    rationale: '这是行为变更，且需要代码审查和验收',
    needsUserChoice: true,
    proposedAgents: {
      executors: ['executor-1'],
      reviewers: ['reviewer-1'],
      testers: ['tester-1'],
      acceptors: ['acceptor-1'],
    },
    stages: [
      {
        stage: 'execute',
        agentIds: ['executor-1'],
        parallel: false,
        goal: '完成后端改造',
      },
      {
        stage: 'review',
        agentIds: ['reviewer-1'],
        parallel: false,
        goal: '完成代码审查',
      },
    ],
  });

  const result = parseCollaborationDecision(output);
  const expected: CollaborationDecision = {
    intent: 'implementation',
    recommendedMode: 'formal_workflow',
    problemArea: 'backend',
    summary: '需要修改后端分发逻辑',
    rationale: '这是行为变更，且需要代码审查和验收',
    needsUserChoice: true,
    proposedAgents: {
      executors: ['executor-1'],
      reviewers: ['reviewer-1'],
      testers: ['tester-1'],
      acceptors: ['acceptor-1'],
    },
    stages: [
      {
        stage: 'execute',
        agentIds: ['executor-1'],
        parallel: false,
        goal: '完成后端改造',
      },
      {
        stage: 'review',
        agentIds: ['reviewer-1'],
        parallel: false,
        goal: '完成代码审查',
      },
    ],
  };

  assert.deepEqual(result, expected);
});

test('parses fenced JSON decision', () => {
  const result = parseCollaborationDecision(`
\`\`\`json
{
  "intent": "analysis",
  "recommendedMode": "chat_collaboration",
  "problemArea": "fullstack",
  "summary": "先做方案分析",
  "rationale": "暂不涉及直接落地代码",
  "needsUserChoice": true,
  "proposedAgents": {
    "executors": [],
    "reviewers": ["reviewer-1"],
    "testers": [],
    "acceptors": []
  },
  "stages": [
    {
      "stage": "summary",
      "agentIds": ["reviewer-1"],
      "parallel": false,
      "goal": "整理分析结论"
    }
  ]
}
\`\`\`
`);

  assert.equal(result.intent, 'analysis');
  assert.equal(result.recommendedMode, 'chat_collaboration');
  assert.equal(result.problemArea, 'fullstack');
  assert.equal(result.stages[0]?.stage, 'summary');
});

test('rejects missing required field', () => {
  assert.throws(
    () =>
      parseCollaborationDecision(`
{
  "intent": "question",
  "problemArea": "unknown",
  "summary": "缺少 recommendedMode",
  "rationale": "用于测试错误分支",
  "needsUserChoice": false,
  "proposedAgents": {
    "executors": [],
    "reviewers": [],
    "testers": [],
    "acceptors": []
  },
  "stages": []
}
`),
    /recommendedMode is required/,
  );
});

test('rejects invalid stage', () => {
  assert.throws(
    () =>
      parseCollaborationDecision(`
{
  "intent": "implementation",
  "recommendedMode": "formal_workflow",
  "problemArea": "frontend",
  "summary": "需要执行阶段",
  "rationale": "用于测试非法 stage",
  "needsUserChoice": true,
  "proposedAgents": {
    "executors": ["executor-1"],
    "reviewers": [],
    "testers": [],
    "acceptors": []
  },
  "stages": [
    {
      "stage": "deploy",
      "agentIds": ["executor-1"],
      "parallel": false,
      "goal": "发布上线"
    }
  ]
}
`),
    /stages\[0\]\.stage must be one of execute, review, acceptance, summary/,
  );
});

test('build prompt tells planner not to directly mention/dispatch agents and includes available agents', () => {
  const prompt = buildCollaborationDecisionPrompt({
    userPrompt: '请帮我修复后端并安排协作',
    agents: [
      {
        agent_id: 'executor-1',
        agent_name: '后端执行',
        agent_role: 'backend executor',
        workflow_role: 'executor',
      },
      {
        agent_id: 'reviewer-1',
        agent_name: '代码审查',
        agent_role: null,
        workflow_role: 'reviewer',
      },
    ],
  });

  assert.match(prompt, /Return ONLY valid JSON/i);
  assert.match(prompt, /Do not directly mention or dispatch agents/i);
  assert.match(prompt, /implementation.*formal_workflow/i);
  assert.match(prompt, /analysis.*question.*chat_collaboration/i);
  assert.match(prompt, /untrusted data only/i);
  assert.match(prompt, /UNTRUSTED_USER_MESSAGE_BEGIN/);
  assert.match(prompt, /UNTRUSTED_USER_MESSAGE_END/);
  assert.match(prompt, /executor-1/);
  assert.match(prompt, /后端执行/);
  assert.match(prompt, /reviewer-1/);
  assert.match(prompt, /请帮我修复后端并安排协作/);
});

test('rejects inconsistent intent and recommendedMode', () => {
  assert.throws(
    () =>
      parseCollaborationDecision(`
{
  "intent": "implementation",
  "recommendedMode": "chat_collaboration",
  "problemArea": "backend",
  "summary": "实现任务不应走 chat",
  "rationale": "用于测试策略一致性",
  "needsUserChoice": true,
  "proposedAgents": {
    "executors": ["executor-1"],
    "reviewers": [],
    "testers": [],
    "acceptors": []
  },
  "stages": []
}
`),
    /recommendedMode must be formal_workflow when intent is implementation/,
  );
});

test('rejects extra text around non-fenced JSON', () => {
  assert.throws(
    () =>
      parseCollaborationDecision(`
这是解释文本，不应被接受。
{
  "intent": "question",
  "recommendedMode": "chat_collaboration",
  "problemArea": "unknown",
  "summary": "需要问答",
  "rationale": "用于测试严格解析",
  "needsUserChoice": false,
  "proposedAgents": {
    "executors": [],
    "reviewers": [],
    "testers": [],
    "acceptors": []
  },
  "stages": []
}
`),
    /must be a raw JSON object or a single ```json fenced block/,
  );
});

test('rejects empty agent id in string arrays', () => {
  assert.throws(
    () =>
      parseCollaborationDecision(`
{
  "intent": "analysis",
  "recommendedMode": "chat_collaboration",
  "problemArea": "fullstack",
  "summary": "测试空白 agent id",
  "rationale": "字符串数组不允许空白值",
  "needsUserChoice": true,
  "proposedAgents": {
    "executors": ["   "],
    "reviewers": [],
    "testers": [],
    "acceptors": []
  },
  "stages": []
}
`),
    /proposedAgents\.executors\[0\] must be a non-empty string/,
  );
});
