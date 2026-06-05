import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextPressureLabel,
  evidenceTypeLabel,
  formatSessionAge,
  pressureTone,
  sessionStatusTone,
} from './session-ui-model';

test('formatSessionAge formats recent and older timestamps', () => {
  const now = 1_000_000;
  assert.equal(formatSessionAge(now, now - 20_000), '刚刚');
  assert.equal(formatSessionAge(now, now - 120_000), '2 分钟前');
  assert.equal(formatSessionAge(now, now - 7_200_000), '2 小时前');
  assert.equal(formatSessionAge(now, now - 172_800_000), '2 天前');
});

test('contextPressureLabel and pressureTone map inspector pressure states', () => {
  assert.equal(contextPressureLabel('low'), '上下文压力低');
  assert.equal(contextPressureLabel('medium'), '上下文压力中');
  assert.equal(contextPressureLabel('high'), '上下文压力高');
  assert.equal(pressureTone('low'), 'ok');
  assert.equal(pressureTone('medium'), 'warn');
  assert.equal(pressureTone('high'), 'danger');
});

test('evidenceTypeLabel keeps known timeline labels readable', () => {
  assert.equal(evidenceTypeLabel('tool_call'), '工具调用');
  assert.equal(evidenceTypeLabel('browser_check'), '浏览器验证');
  assert.equal(evidenceTypeLabel('custom_event'), 'custom_event');
});

test('sessionStatusTone maps operational status to semantic tones', () => {
  assert.equal(sessionStatusTone('active'), 'ok');
  assert.equal(sessionStatusTone('blocked'), 'warn');
  assert.equal(sessionStatusTone('failed'), 'danger');
  assert.equal(sessionStatusTone('archived'), undefined);
});
