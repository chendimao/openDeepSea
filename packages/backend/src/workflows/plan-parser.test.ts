import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanArtifact } from './plan-parser.js';

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

test('parsePlanArtifact rejects output without JSON', () => {
  assert.throws(() => parsePlanArtifact('这里只是一段普通文本'), /JSON object/);
});
