import assert from 'node:assert/strict';
import test from 'node:test';
import { getExplicitReplyToMessageId } from './RichMessageComposer.model';
import { FILE_TRIGGER, buildFileSuggestions, encodeFileChipValue, parseFileChipValue } from './RichMessageComposer.triggers';

test('file trigger helpers encode project and workspace references', () => {
  assert.equal(FILE_TRIGGER, '@');
  assert.equal(encodeFileChipValue('project', 'file-1'), 'project:file-1');
  assert.deepEqual(parseFileChipValue('workspace:src/App.tsx'), {
    kind: 'workspace',
    ref: 'src/App.tsx',
  });
  assert.equal(parseFileChipValue('agent:planner'), null);
});

test('buildFileSuggestions merges project and workspace references', () => {
  const suggestions = buildFileSuggestions(
    [{
      id: 'file-1',
      project_id: 'project-1',
      source_type: 'uploaded_file',
      original_name: 'report.md',
      stored_name: 'report.md',
      mime_type: 'text/markdown',
      size: 100,
      url: '/uploads/report.md',
      storage_path: 'report.md',
      uploaded_by_id: 'user',
      uploaded_by_name: 'You',
      source_message_id: null,
      source_room_id: null,
      source_agent_id: null,
      source_task_id: null,
      content: null,
      created_at: 1,
      deleted_at: null,
      reference_count: 0,
      last_referenced_at: null,
      last_referenced_message_id: null,
      last_referenced_room_id: null,
      last_referenced_room_name: null,
    }],
    [{ path: 'src/report.md', name: 'report.md', type: 'file' }],
    'report',
  );

  assert.equal(suggestions[0]?.value, 'project:file-1');
  assert.equal(suggestions.some((suggestion) => suggestion.value === 'workspace:src/report.md'), true);
});

test('getExplicitReplyToMessageId only returns explicit reply targets', () => {
  assert.equal(
    getExplicitReplyToMessageId({
      messageId: 'message-explicit',
      senderName: '产品经理',
      excerpt: '显式引用',
      explicit: true,
    }),
    'message-explicit',
  );
  assert.equal(
    getExplicitReplyToMessageId({
      messageId: 'message-default',
      senderName: '产品经理',
      excerpt: '默认回复',
      explicit: false,
    }),
    undefined,
  );
  assert.equal(getExplicitReplyToMessageId(null), undefined);
});
