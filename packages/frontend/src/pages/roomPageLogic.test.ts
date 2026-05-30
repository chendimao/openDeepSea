import assert from 'node:assert/strict';
import test from 'node:test';
import { getRoutableActiveTaskId } from './roomPageLogic';

test('getRoutableActiveTaskId only returns active tasks that can receive new messages', () => {
  assert.equal(getRoutableActiveTaskId({ id: 'todo-task', status: 'todo' }), 'todo-task');
  assert.equal(getRoutableActiveTaskId({ id: 'running-task', status: 'in_progress' }), 'running-task');
  assert.equal(getRoutableActiveTaskId({ id: 'review-task', status: 'review' }), 'review-task');
  assert.equal(getRoutableActiveTaskId({ id: 'done-task', status: 'done' }), null);
  assert.equal(getRoutableActiveTaskId({ id: 'failed-task', status: 'failed' }), null);
  assert.equal(getRoutableActiveTaskId(null), null);
});
