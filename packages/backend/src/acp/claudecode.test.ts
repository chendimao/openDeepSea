import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeCodeArgs, buildClaudeCodePrompt, createStdoutNormalizer, normalizeStdoutChunk } from './claudecode.js';

test('buildClaudeCodeArgs maps bypass to bypassPermissions', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: null,
      prompt: 'hello',
      imagePaths: [],
      permissionMode: 'bypass',
      writableDirs: ['/tmp/ignored'],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', 'hello'],
  );
});

test('buildClaudeCodeArgs maps workspace-write to acceptEdits with the current project directory', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: 'session-1',
      prompt: 'continue',
      imagePaths: [],
      permissionMode: 'workspace-write',
      writableDirs: ['/Users/chendimao/WWW/openclaw-room'],
    }),
    [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      '/Users/chendimao/WWW/openclaw-room',
      '--resume',
      'session-1',
      'continue',
    ],
  );
});

test('buildClaudeCodeArgs maps read-only to plan mode', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: null,
      prompt: 'inspect',
      imagePaths: [],
      permissionMode: 'read-only',
      writableDirs: [],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', 'inspect'],
  );
});

test('buildClaudeCodePrompt appends local image paths for Claude Code', () => {
  const prompt = buildClaudeCodePrompt('能识别图片吗', [
    '/tmp/screen.png',
    '/tmp/screen.png',
    ' ',
    '/tmp/diagram.webp',
  ]);

  assert.match(prompt, /能识别图片吗/);
  assert.match(prompt, /Claude Code 图片附件：/);
  assert.match(prompt, /1\. \/tmp\/screen\.png/);
  assert.match(prompt, /2\. \/tmp\/diagram\.webp/);
});

test('normalizeStdoutChunk reads OpenCode text events from current and legacy shapes', () => {
  const current = JSON.stringify({
    type: 'text',
    text: 'current final answer',
    metadata: { openai: { phase: 'final_answer' } },
  });
  const legacy = JSON.stringify({
    type: 'message.part.updated',
    data: {
      part: {
        type: 'text',
        text: 'legacy final answer',
        metadata: { openai: { phase: 'final_answer' } },
      },
    },
  });

  assert.deepEqual(normalizeStdoutChunk(`${current}\n${legacy}\n`), [
    {
      channel: 'answer',
      text: 'current final answer',
      rawType: 'text',
    },
    {
      channel: 'answer',
      text: 'legacy final answer',
      rawType: 'message.part.updated',
    },
  ]);
});

test('normalizeStdoutChunk reads OpenCode plain text events without OpenAI metadata', () => {
  const current = JSON.stringify({
    type: 'text',
    text: 'plain final answer',
    time: { start: 1, end: 2 },
  });
  const legacy = JSON.stringify({
    type: 'message.part.updated',
    data: {
      part: {
        type: 'text',
        text: 'plain legacy answer',
        time: { start: 3, end: 4 },
      },
    },
  });

  assert.deepEqual(normalizeStdoutChunk(`${current}\n${legacy}\n`), [
    {
      channel: 'answer',
      text: 'plain final answer',
      rawType: 'text',
    },
    {
      channel: 'answer',
      text: 'plain legacy answer',
      rawType: 'message.part.updated',
    },
  ]);
});

test('normalizeStdoutChunk ignores OpenCode user echo text events without assistant signals', () => {
  const userEcho = JSON.stringify({
    type: 'text',
    text: '"@数据处理工程师 hi"',
  });

  assert.deepEqual(normalizeStdoutChunk(`${userEcho}\n`), []);
});

test('OpenCode updated text snapshots stream only appended delta', () => {
  const normalize = createStdoutNormalizer();
  const first = JSON.stringify({
    type: 'message.part.updated',
    data: {
      part: {
        id: 'part-1',
        type: 'text',
        text: '第一行\n',
      },
    },
  });
  const second = JSON.stringify({
    type: 'message.part.updated',
    data: {
      part: {
        id: 'part-1',
        type: 'text',
        text: '第一行\n第二行',
      },
    },
  });

  assert.deepEqual(normalize(`${first}\n`), [
    {
      channel: 'answer',
      text: '第一行\n',
      rawType: 'message.part.updated',
    },
  ]);
  assert.deepEqual(normalize(`${second}\n`), [
    {
      channel: 'answer',
      text: '第二行',
      rawType: 'message.part.updated',
    },
  ]);
});

test('structured answer snapshots do not duplicate final replies', () => {
  const normalize = createStdoutNormalizer();
  const assistant = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '第一段回复' }],
    },
  });
  const duplicateResult = JSON.stringify({
    type: 'result',
    result: '第一段回复',
  });
  const extendedResult = JSON.stringify({
    type: 'result',
    result: '第一段回复\n第二段回复',
  });

  assert.deepEqual(normalize(`${assistant}\n`), [
    {
      channel: 'answer',
      text: '第一段回复',
      rawType: 'assistant',
    },
  ]);
  assert.deepEqual(normalize(`${duplicateResult}\n`), []);
  assert.deepEqual(normalize(`${extendedResult}\n`), [
    {
      channel: 'answer',
      text: '\n第二段回复',
      rawType: 'result',
    },
  ]);
});

test('Codex agent message snapshots are treated as full-answer snapshots', () => {
  const normalize = createStdoutNormalizer();
  const first = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Codex 最终回复',
    },
  });
  const duplicate = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Codex 最终回复',
    },
  });

  assert.deepEqual(normalize(`${first}\n`), [
    {
      channel: 'answer',
      text: 'Codex 最终回复',
      rawType: 'item.completed',
    },
  ]);
  assert.deepEqual(normalize(`${duplicate}\n`), []);
});

test('plain text chunks that repeat the streamed prefix only append the new suffix', () => {
  const normalize = createStdoutNormalizer();

  assert.deepEqual(normalize('当前证据显示消息附件主要走 metadata.attachments\n'), [
    {
      channel: 'answer',
      text: '当前证据显示消息附件主要走 metadata.attachments',
    },
  ]);
  assert.deepEqual(normalize('当前证据显示消息附件主要走 metadata.attachments，并会进一步映射成本地 imagePaths\n'), [
    {
      channel: 'answer',
      text: '，并会进一步映射成本地 imagePaths',
    },
  ]);
});

test('plain text delta chunks keep accumulated state for later snapshot dedupe', () => {
  const normalize = createStdoutNormalizer();

  assert.deepEqual(normalize('第一段'), [
    {
      channel: 'answer',
      text: '第一段',
    },
  ]);
  assert.deepEqual(normalize('第二段'), [
    {
      channel: 'answer',
      text: '第二段',
    },
  ]);
  assert.deepEqual(normalize('第一段第二段第三段'), [
    {
      channel: 'answer',
      text: '第三段',
    },
  ]);
});

test('plain text chunks that look like non-prefix snapshots do not corrupt accumulated state', () => {
  const normalize = createStdoutNormalizer();

  assert.deepEqual(normalize('第一段'), [
    {
      channel: 'answer',
      text: '第一段',
    },
  ]);
  assert.deepEqual(normalize('修订后的第一段'), [
    {
      channel: 'answer',
      text: '修订后的第一段',
    },
  ]);
  assert.deepEqual(normalize('修订后的第一段第二段'), [
    {
      channel: 'answer',
      text: '第二段',
    },
  ]);
});

test('plain text lines keep newline state for later structured snapshot dedupe', () => {
  const normalize = createStdoutNormalizer();

  assert.deepEqual(normalize('第一段\n第二段\n'), [
    {
      channel: 'answer',
      text: '第一段',
    },
    {
      channel: 'answer',
      text: '第二段',
    },
  ]);

  const finalSnapshot = JSON.stringify({
    type: 'result',
    result: '第一段\n第二段\n第三段',
  });
  assert.deepEqual(normalize(`${finalSnapshot}\n`), [
    {
      channel: 'answer',
      text: '第三段',
      rawType: 'result',
    },
  ]);
});
