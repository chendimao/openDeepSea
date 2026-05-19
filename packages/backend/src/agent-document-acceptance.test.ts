import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_DOCUMENT_ACCEPTANCE_CRITERIA,
  type AgentDocumentAcceptanceCategory,
} from './agent-document-acceptance.js';

const REQUIRED_CATEGORIES: AgentDocumentAcceptanceCategory[] = [
  'trigger_timing',
  'message_source',
  'context_requirements',
  'hard_exclusions',
  'score_thresholds',
  'duplicate_archive',
  'manual_save',
  'cancel_archive',
  'asset_type_boundary',
  'implementation_scope',
];

test('agent document acceptance criteria cover every required rule area', () => {
  const categories = new Set(AGENT_DOCUMENT_ACCEPTANCE_CRITERIA.map((item) => item.category));

  for (const category of REQUIRED_CATEGORIES) {
    assert.equal(categories.has(category), true, category);
  }

  assert.equal(AGENT_DOCUMENT_ACCEPTANCE_CRITERIA.length, REQUIRED_CATEGORIES.length);
  assert.equal(new Set(AGENT_DOCUMENT_ACCEPTANCE_CRITERIA.map((item) => item.id)).size, AGENT_DOCUMENT_ACCEPTANCE_CRITERIA.length);
});

test('agent document acceptance criteria explicitly block streaming and user-message auto archive', () => {
  const trigger = criterion('trigger_timing');
  assertIncludes(trigger.standard, ['完整结束', '不得在流式输出']);
  assertIncludes(trigger.acceptanceChecks.join('\n'), ['messageComplete=false', '不归档']);

  const source = criterion('message_source');
  assertIncludes(source.standard, ['sender_type=agent', '不对用户消息']);
  assertIncludes(source.acceptanceChecks.join('\n'), ['sender_type=user', '必须是不归档']);
});

test('agent document acceptance criteria define context hard exclusions score and duplicate boundaries', () => {
  assertIncludes(criterion('context_requirements').standard, ['project_id', 'room_id', 'message_id', 'agent_id']);
  assertIncludes(criterion('hard_exclusions').standard, ['短回复', '日志输出', '错误堆栈', '纯代码块', '进度播报']);
  assertIncludes(criterion('score_thresholds').standard, ['score>=5', 'score 3-4', 'score<3']);
  assertIncludes(criterion('duplicate_archive').standard, ['source_message_id', '不得再次自动归档']);
});

test('agent document acceptance criteria cover manual save cancel archive and asset type separation', () => {
  assertIncludes(criterion('manual_save').standard, ['手动保存', 'agent_document', 'score 3-4']);
  assertIncludes(criterion('cancel_archive').standard, ['不删除原始聊天消息', '不影响用户上传文件']);

  const assetBoundary = criterion('asset_type_boundary');
  assertIncludes(assetBoundary.standard, ['uploaded_file', 'agent_document']);
  assertIncludes(assetBoundary.acceptanceChecks.join('\n'), [
    'uploaded_file/uploaded_files',
    'agent_document/agent_documents',
  ]);
});

test('agent document acceptance criteria make implementation scope explicit', () => {
  const scope = criterion('implementation_scope');
  assertIncludes(scope.standard, ['本轮只形成', '不要求完成']);
  assertIncludes(scope.acceptanceChecks.join('\n'), ['不得声称自动归档功能已完整实现']);
});

function criterion(category: AgentDocumentAcceptanceCategory) {
  const item = AGENT_DOCUMENT_ACCEPTANCE_CRITERIA.find((candidate) => candidate.category === category);
  assert.ok(item, category);
  assert.ok(item.standard.length > 20, category);
  assert.ok(item.acceptanceChecks.length >= 3, category);
  return item;
}

function assertIncludes(value: string, snippets: string[]): void {
  for (const snippet of snippets) {
    assert.ok(value.includes(snippet), snippet);
  }
}
