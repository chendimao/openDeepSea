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
  assert.equal(plan.summary, '实现登录修复');
  assert.equal(plan.tasks.length, 1);
  assert.equal(firstTask.suggestedRole, 'executor');
  assert.equal(firstTask.priority, 'high');
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
