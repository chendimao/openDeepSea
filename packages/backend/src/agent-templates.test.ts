import test from 'node:test';
import assert from 'node:assert/strict';
import { listBuiltInAgentTemplates } from './agent-templates.js';
import type { WorkflowRole } from './types.js';

test('built-in agent templates include required ACP-only workflow roles', () => {
  const templates = listBuiltInAgentTemplates();
  const roles = new Set(templates.map((template) => template.workflow_role));

  for (const role of ['planner', 'executor', 'reviewer', 'acceptor'] satisfies WorkflowRole[]) {
    assert.equal(roles.has(role), true);
  }

  for (const template of templates) {
    assert.equal(template.acp_enabled, true);
    assert.equal(template.acp_backend, 'codex');
  }
});
