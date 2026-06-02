import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcpIntentStreamFilter,
  parseAcpIntentControlBlock,
} from './acp-intent-stream.js';

test('createAcpIntentStreamFilter passes visible answer text and hides intent control block', () => {
  const filter = createAcpIntentStreamFilter();

  assert.equal(filter.push('你好，'), '你好，');
  assert.equal(filter.push('我在。<openclaw_intent_json>\n'), '我在。');
  assert.equal(filter.push('{"intent":"chat","suggestedAction":"reply_in_chat","reason":"普通问候","signals":["hi"]}'), '');
  assert.equal(filter.push('\n</openclaw_intent_json>'), '');

  assert.equal(filter.finish(), '');
  assert.deepEqual(filter.intentResult(), {
    intent: 'chat',
    confidence: 1,
    source: 'classifier',
    suggestedAction: 'reply_in_chat',
    reason: '普通问候',
    signals: ['hi'],
  });
});

test('createAcpIntentStreamFilter handles tag split across chunks without leaking partial tag text', () => {
  const filter = createAcpIntentStreamFilter();

  assert.equal(filter.push('正文<open'), '正文');
  assert.equal(filter.push('claw_intent_json>{"intent":"workflow","suggestedAction":"start_workflow","reason":"需要完整闭环","signals":["实现"]}</openclaw_intent_json>'), '');

  assert.equal(filter.finish(), '');
  assert.equal(filter.intentResult()?.intent, 'workflow');
});

test('createAcpIntentStreamFilter flushes unmatched tag prefix as visible text on finish', () => {
  const filter = createAcpIntentStreamFilter();

  assert.equal(filter.push('正文<open'), '正文');
  assert.equal(filter.finish(), '<open');
  assert.equal(filter.intentResult(), null);
});

test('parseAcpIntentControlBlock returns null for malformed or missing intent JSON', () => {
  assert.equal(parseAcpIntentControlBlock('not json'), null);
  assert.equal(parseAcpIntentControlBlock('{"intent":"unknown","suggestedAction":"reply_in_chat"}'), null);
});
