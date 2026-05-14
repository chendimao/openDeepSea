import assert from 'node:assert/strict';
import test from 'node:test';
import { appendMemoryContext, formatMemoryContext } from './context.js';
import type { MemoryEntry } from '../types.js';

function memory(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem-1',
    project_id: 'project-1',
    room_id: null,
    room_agent_id: null,
    task_id: null,
    scope: 'project',
    memory_type: 'decision',
    title: 'Default title',
    content: 'Default content',
    source_type: 'manual',
    source_id: null,
    pinned: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

test('formatMemoryContext returns an empty string when no memories exist', () => {
  assert.equal(formatMemoryContext([]), '');
});

test('formatMemoryContext renders bounded labeled memory block', () => {
  const output = formatMemoryContext([
    memory({
      memory_type: 'decision',
      scope: 'project',
      pinned: 1,
      title: 'Use memory',
      content: 'Inject memory into prompts.',
    }),
    memory({
      id: 'mem-2',
      memory_type: 'lesson',
      scope: 'room',
      title: 'Room lesson',
      content: 'Keep entries short.',
    }),
  ]);

  assert.match(output, /项目\/聊天室记忆：/);
  assert.match(output, /1\. \[决策；project；置顶\] Use memory/);
  assert.match(output, /2\. \[经验；room\] Room lesson/);
});

test('appendMemoryContext keeps the original prompt when no memories exist', () => {
  assert.equal(appendMemoryContext('Hello', []), 'Hello');
});

test('appendMemoryContext prepends memory before current request', () => {
  const output = appendMemoryContext('用户问题', [
    memory({ title: 'Known fact', content: 'The project is local-first.' }),
  ]);

  assert.match(output, /^项目\/聊天室记忆：/);
  assert.match(output, /当前请求：\n用户问题$/);
});
