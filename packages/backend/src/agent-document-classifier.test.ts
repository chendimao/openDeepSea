import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAgentDocument,
  type AgentDocumentClassificationInput,
} from './agent-document-classifier.js';

const baseInput: Omit<AgentDocumentClassificationInput, 'content'> = {
  senderType: 'agent',
  messageComplete: true,
  projectId: 'project-1',
  roomId: 'room-1',
  messageId: 'message-1',
  agentId: 'planner',
  agentName: '产品经理',
};

test('classifyAgentDocument auto archives document assets with reasons', () => {
  const cases = [
    {
      name: '方案文档',
      userRequest: '请写方案并归档',
      content: documentContent('图片冒烟验证方案文档', ['目标', '边界', '验收标准'], '方案'),
    },
    {
      name: '需求文档',
      userRequest: '整理成需求文档',
      content: documentContent('资源自动归档需求文档', ['背景', '用户故事', '验收点'], '需求'),
    },
    {
      name: '总结报告',
      userRequest: '形成总结报告',
      content: documentContent('自动归档规则总结报告', ['结论', '证据', '后续动作'], '总结报告'),
    },
    {
      name: '实施计划',
      userRequest: '输出实施计划',
      content: documentContent('agent_document 实施计划', ['任务拆分', '验证方式', '风险'], '实施计划'),
    },
  ];

  for (const item of cases) {
    const result = classifyAgentDocument({
      ...baseInput,
      content: item.content,
      userRequest: item.userRequest,
    });

    assert.equal(result.decision, 'auto_archive', item.name);
    assert.ok(result.score >= 5, item.name);
    assert.ok(result.title, item.name);
    assert.ok(result.reasons.length >= 3, item.name);
    assert.ok(result.reasons.some((reason) => reason.includes('文档关键词')), item.name);
  }
});

test('classifyAgentDocument excludes short replies logs stacks code blocks and ordinary Q&A with reasons', () => {
  const cases = [
    {
      name: '短回复',
      content: '已完成，我会继续处理。',
      expectedReason: '内容长度小于 500 字符',
    },
    {
      name: '日志输出',
      content: longText([
        '2026-05-19T10:00:00.000Z INFO start backend smoke command',
        'stdout: npm run build',
        'npm ERR! lifecycle failed',
      ]),
      expectedReason: '日志、终端输出或错误堆栈',
    },
    {
      name: '错误堆栈',
      content: longText([
        'Traceback (most recent call last):',
        '  File "main.py", line 12, in <module>',
        'Exception: invalid smoke image payload',
      ]),
      expectedReason: '日志、终端输出或错误堆栈',
    },
    {
      name: '纯代码块',
      content: [
        '```ts',
        ...Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`),
        '```',
        '',
        '这只是代码输出。',
      ].join('\n'),
      expectedReason: '代码块内容占比超过 70%',
    },
    {
      name: '普通问答',
      content: longPlainAnswer(),
      expectedReason: '没有 Markdown 结构且没有文档关键词',
    },
  ];

  for (const item of cases) {
    const result = classifyAgentDocument({
      ...baseInput,
      content: item.content,
      userRequest: '解释一下这是什么意思',
    });

    assert.equal(result.decision, 'do_not_archive', item.name);
    assert.equal(result.score, 0, item.name);
    assert.ok(result.reasons[0]?.includes(item.expectedReason), item.name);
  }
});

test('classifyAgentDocument keeps score 3-4 weak structure cases as manual save suggestions', () => {
  const cases = [
    {
      name: '只有标题和列表的边界纪要',
      content: [
        '# 冒烟验证边界纪要',
        '',
        '- 覆盖截图存在但尺寸过小的情况。',
        '- 覆盖图片路径存在但不可读取的情况。',
        '- 覆盖结果需要人工复核的情况。',
        '',
        filler('这份纪要有一些结构，但仍像临时记录，缺少明确交付物意图。', 18),
      ].join('\n'),
      expectedScore: 3,
    },
    {
      name: '有文档关键词但结构较弱',
      content: [
        '这里整理本轮规则范围：自动归档只处理智能体完成后的 Markdown 内容，范围包含部分可复用材料。',
        filler('内容有规则和范围信号，但没有标题、章节、列表或明确用户文档化请求。', 24),
      ].join('\n\n'),
      expectedScore: 4,
    },
  ];

  for (const item of cases) {
    const result = classifyAgentDocument({
      ...baseInput,
      agentName: '后端开发工程师',
      content: item.content,
      userRequest: '帮我看一下',
    });

    assert.equal(result.decision, 'suggest_manual_save', item.name);
    assert.equal(result.score, item.expectedScore, item.name);
    assert.ok(result.reasons.some((reason) => reason.includes('score 3-4')), item.name);
  }
});

test('classifyAgentDocument enforces trigger and duplicate boundaries before scoring', () => {
  const validDocument = documentContent('重复归档方案文档', ['目标', '规则', '验收'], '方案');
  const cases: Array<{
    name: string;
    patch: Partial<AgentDocumentClassificationInput>;
    expectedReason: string;
  }> = [
    {
      name: '用户消息',
      patch: { senderType: 'user' },
      expectedReason: '来源不是智能体消息',
    },
    {
      name: '流式未完成',
      patch: { messageComplete: false },
      expectedReason: '消息尚未完整结束',
    },
    {
      name: '上下文缺失',
      patch: { messageId: null },
      expectedReason: '缺少 project_id、room_id、message_id 或 agent_id',
    },
    {
      name: '同源已归档',
      patch: { alreadyArchived: true },
      expectedReason: '同源消息已存在 agent_document',
    },
  ];

  for (const item of cases) {
    const result = classifyAgentDocument({
      ...baseInput,
      content: validDocument,
      userRequest: '写方案',
      ...item.patch,
    });

    assert.equal(result.decision, 'do_not_archive', item.name);
    assert.equal(result.score, 0, item.name);
    assert.ok(result.reasons[0]?.includes(item.expectedReason), item.name);
  }
});

function documentContent(title: string, sections: string[], keyword: string): string {
  return [
    `# ${title}`,
    '',
    `这是一份用于验证自动归档规则的${keyword}，需要能独立阅读、追溯原因，并作为后续实现验收依据。`,
    '',
    ...sections.flatMap((section) => [
      `## ${section}`,
      '',
      `- ${section}必须给出清晰边界。`,
      `- ${section}必须说明判定原因。`,
      `- ${section}必须覆盖回归风险。`,
      '',
    ]),
    '| 案例 | 判定 | 原因 |',
    '| --- | --- | --- |',
    `| ${keyword}正例 | 自动归档 | 结构、关键词和用户意图同时成立 |`,
    '',
    filler('补充说明用于保证内容具备独立上下文，而不是短回复或临时进度播报。', 14),
  ].join('\n');
}

function longText(lines: string[]): string {
  return [
    ...lines,
    filler('repeated diagnostic output keeps this sample above the minimum length threshold', 20),
  ].join('\n');
}

function longPlainAnswer(): string {
  return filler(
    '这个概念可以理解为一次普通问答解释，重点是帮助当前对话理解背景，只服务于当下交流，不具备长期复用价值。',
    24,
  );
}

function filler(sentence: string, count: number): string {
  return Array.from({ length: count }, () => sentence).join('');
}
