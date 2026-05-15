import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptanceVerdict, parseDecisionRequest, parsePlanArtifact, parseReviewVerdict } from './plan-parser.js';

test('parsePlanArtifact parses fenced JSON plan', () => {
  const plan = parsePlanArtifact(`
计划如下：
\`\`\`json
{
  "summary": "实现登录修复",
  "tasks": [
    {
      "title": "修复登录校验",
      "description": "调整后端登录参数校验并补充错误路径",
      "suggestedRole": "executor",
      "priority": "high",
      "acceptance": ["无效密码返回 401"]
    }
  ],
  "reviewFocus": ["认证边界"],
  "verification": ["npm run build"],
  "risks": ["影响现有登录流程"]
}
\`\`\`
`);

  const firstTask = plan.tasks[0];
  assert.ok(firstTask);
  assert.equal(plan.goal, null);
  assert.equal(plan.summary, '实现登录修复');
  assert.deepEqual(plan.assumptions, []);
  assert.equal(plan.tasks.length, 1);
  assert.equal(firstTask.suggestedRole, 'executor');
  assert.equal(firstTask.priority, 'high');
  assert.deepEqual(firstTask.scopeRead, []);
  assert.deepEqual(firstTask.scopeWrite, []);
  assert.deepEqual(firstTask.dependsOn, []);
  assert.equal(plan.needsApproval, true);
});

test('parsePlanArtifact prefers JSON fenced plan after non-JSON fenced block', () => {
  const plan = parsePlanArtifact(`
先说明一个 TypeScript 示例：
\`\`\`ts
const task = { title: 'not a plan' };
\`\`\`

计划如下：
\`\`\`json
{
  "summary": "修复计划解析",
  "tasks": [
    {
      "title": "优先解析 JSON 代码块",
      "description": "当输出中先出现非 JSON 代码块时，仍解析后续 JSON 计划",
      "suggestedRole": "executor",
      "priority": "normal",
      "acceptance": ["正确解析 JSON fenced block"]
    }
  ],
  "reviewFocus": ["解析顺序"],
  "verification": ["npm run test -w @openclaw-room/backend"],
  "risks": []
}
\`\`\`
`);

  const firstTask = plan.tasks[0];
  assert.ok(firstTask);
  assert.equal(plan.summary, '修复计划解析');
  assert.equal(firstTask.title, '优先解析 JSON 代码块');
});

test('parsePlanArtifact parses modern LangChain planner shape', () => {
  const plan = parsePlanArtifact(`
\`\`\`json
{
  "goal": "交付 LangChain 结构化计划解析",
  "summary": "定义现代计划结构并兼容旧格式",
  "assumptions": ["现有 legacy plan 仍需支持"],
  "steps": [
    {
      "title": "实现现代计划解析",
      "intent": "解析 LangChain planner 输出并映射到任务模型",
      "assigneeRole": "executor",
      "preferredBackend": "codex",
      "scopeRead": ["packages/backend/src/workflows/plan-parser.ts"],
      "scopeWrite": ["packages/backend/src/workflows/plan-parser.ts"],
      "acceptance": ["现代 steps 被归一化为 tasks"],
      "dependsOn": []
    }
  ],
  "risks": ["schema 变更影响旧计划解析"],
  "verification": [
    {"command": "node --import tsx --test src/workflows/plan-parser.test.ts", "reason": "覆盖解析器行为"}
  ],
  "needsApproval": false
}
\`\`\`
`);

  const firstTask = plan.tasks[0];
  assert.ok(firstTask);
  assert.equal(plan.goal, '交付 LangChain 结构化计划解析');
  assert.equal(plan.summary, '定义现代计划结构并兼容旧格式');
  assert.deepEqual(plan.assumptions, ['现有 legacy plan 仍需支持']);
  assert.equal(plan.tasks.length, 1);
  assert.equal(firstTask.title, '实现现代计划解析');
  assert.equal(firstTask.description, '解析 LangChain planner 输出并映射到任务模型');
  assert.equal(firstTask.suggestedRole, 'executor');
  assert.equal(firstTask.priority, 'normal');
  assert.equal(firstTask.preferredBackend, 'codex');
  assert.deepEqual(firstTask.scopeWrite, ['packages/backend/src/workflows/plan-parser.ts']);
  assert.deepEqual(firstTask.dependsOn, []);
  assert.deepEqual(plan.verification, ['node --import tsx --test src/workflows/plan-parser.test.ts']);
  assert.equal(plan.needsApproval, false);
});

test('parsePlanArtifact rejects modern steps missing acceptance', () => {
  assert.throws(
    () =>
      parsePlanArtifact(`
{
  "goal": "交付 LangChain 结构化计划解析",
  "summary": "定义现代计划结构并兼容旧格式",
  "assumptions": [],
  "steps": [
    {
      "title": "实现现代计划解析",
      "intent": "解析 LangChain planner 输出并映射到任务模型",
      "assigneeRole": "executor"
    }
  ],
  "risks": [],
  "verification": [],
  "needsApproval": false
}
`),
    /acceptance/i,
  );
});

test('parsePlanArtifact rejects modern steps missing required scope fields', () => {
  assert.throws(
    () =>
      parsePlanArtifact(`
{
  "goal": "交付 LangChain 结构化计划解析",
  "summary": "定义现代计划结构并兼容旧格式",
  "assumptions": [],
  "steps": [
    {
      "title": "实现现代计划解析",
      "intent": "解析 LangChain planner 输出并映射到任务模型",
      "assigneeRole": "executor",
      "scopeRead": ["packages/backend/src/workflows/plan-parser.ts"],
      "acceptance": ["现代 steps 被归一化为 tasks"],
      "dependsOn": []
    }
  ],
  "risks": [],
  "verification": [],
  "needsApproval": false
}
`),
    /scopeWrite/i,
  );
});

test('parsePlanArtifact rejects modern plan missing required root fields', () => {
  assert.throws(
    () =>
      parsePlanArtifact(`
{
  "goal": "交付 LangChain 结构化计划解析",
  "summary": "定义现代计划结构并兼容旧格式",
  "steps": [
    {
      "title": "实现现代计划解析",
      "intent": "解析 LangChain planner 输出并映射到任务模型",
      "assigneeRole": "executor",
      "scopeRead": ["packages/backend/src/workflows/plan-parser.ts"],
      "scopeWrite": ["packages/backend/src/workflows/plan-parser.ts"],
      "acceptance": ["现代 steps 被归一化为 tasks"],
      "dependsOn": []
    }
  ],
  "risks": [],
  "verification": []
}
`),
    /assumptions/i,
  );
});

test('parsePlanArtifact rejects invalid modern steps even when legacy tasks are valid', () => {
  assert.throws(
    () =>
      parsePlanArtifact(`
{
  "goal": "交付 LangChain 结构化计划解析",
  "summary": "定义现代计划结构并兼容旧格式",
  "assumptions": [],
  "steps": [
    {
      "title": "实现现代计划解析",
      "intent": "解析 LangChain planner 输出并映射到任务模型",
      "assigneeRole": "executor"
    }
  ],
  "tasks": [
    {
      "title": "legacy fallback should not win",
      "description": "这个 legacy task 有效，但不能接住 invalid modern shape",
      "suggestedRole": "executor",
      "priority": "normal",
      "acceptance": ["legacy task is valid"]
    }
  ],
  "reviewFocus": [],
  "risks": [],
  "verification": [],
  "needsApproval": false
}
`),
    /acceptance/i,
  );
});

test('parsePlanArtifact rejects output without JSON', () => {
  assert.throws(() => parsePlanArtifact('这里只是一段普通文本'), /JSON object/);
});

test('parseDecisionRequest parses blocking decisions', () => {
  const request = parseDecisionRequest(`
需要确认的问题如下。
\`\`\`json
{
  "decisions": [
    {
      "id": "file-scope",
      "question": "文件支持范围是否只做图片，还是所有文件？",
      "reason": "影响上传、校验和 Agent 上下文。",
      "blocking": true,
      "recommendedOptionId": "images-only",
      "options": [
        {"id":"images-only","label":"仅支持图片","description":"先控制范围。"},
        {"id":"all-files","label":"支持所有文件","description":"覆盖更多场景。"}
      ]
    }
  ]
}
\`\`\`
`);

  assert.equal(request.decisions.length, 1);
  assert.equal(request.decisions[0]?.recommendedOptionId, 'images-only');
});

test('parseDecisionRequest returns empty decisions when no decision block exists', () => {
  const request = parseDecisionRequest('没有需要确认的问题。');

  assert.deepEqual(request.decisions, []);
});

test('parseDecisionRequest ignores invalid decision blocks', () => {
  const request = parseDecisionRequest('```json\n{"decisions":[{"id":"x"}]}\n```');

  assert.deepEqual(request.decisions, []);
});

test('parseReviewVerdict parses pass verdict', () => {
  const verdict = parseReviewVerdict(`
\`\`\`json
{"verdict":"pass","findings":[],"requiredFixes":[],"riskLevel":"low"}
\`\`\`
`);

  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.riskLevel, 'low');
});

test('parseReviewVerdict rejects malformed verdict', () => {
  assert.throws(() => parseReviewVerdict('{"verdict":"looks_good"}'), /Invalid enum value|invalid_enum_value/);
});

test('parseAcceptanceVerdict parses failed verdict', () => {
  const verdict = parseAcceptanceVerdict(`
\`\`\`json
{"verdict":"failed","acceptedCriteria":[],"failedCriteria":["缺少验证"],"notes":"需要补充验证"}
\`\`\`
`);

  assert.equal(verdict.verdict, 'failed');
  assert.deepEqual(verdict.failedCriteria, ['缺少验证']);
});
