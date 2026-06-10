import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskRisk, buildApprovalCard } from './task-risk.js';

test('classifies small README-only edits as low-risk documentation work', () => {
  const assessment = assessTaskRisk({
    title: 'Update README',
    description: 'Small documentation-only README change for setup instructions.',
    scopeRead: ['README.md'],
    scopeWrite: ['README.md'],
    acceptance: ['README explains local setup clearly'],
  });

  assert.equal(assessment.taskKind, 'docs_only');
  assert.equal(assessment.riskLevel, 'low');
  assert.equal(assessment.requiresApproval, false);
  assert.ok(assessment.reasons.some((reason) => /small|documentation-only/i.test(reason)));
});

test('requires approval for combined frontend and backend workflow changes', () => {
  const assessment = assessTaskRisk({
    title: 'Update workflow approval UI and API',
    description: 'Change React workflow approval controls and backend workflow route behavior.',
    scopeRead: [
      'packages/frontend/src/pages/WorkflowPage.tsx',
      'packages/backend/src/workflows/routes.ts',
    ],
    scopeWrite: [
      'packages/frontend/src/pages/WorkflowPage.tsx',
      'packages/backend/src/workflows/routes.ts',
    ],
    acceptance: ['Workflow approval works from UI through backend API'],
  });

  assert.equal(assessment.taskKind, 'fullstack_change');
  assert.equal(assessment.riskLevel, 'medium');
  assert.equal(assessment.requiresApproval, true);
  assert.match(assessment.approvalReason ?? '', /front\/back|前后端/i);
});

test('marks dependencies root config and database migrations as high risk', () => {
  const assessment = assessTaskRisk({
    title: 'Add dependency and migration',
    description: 'Update package dependencies and add a SQLite database migration.',
    scopeRead: ['package.json', 'packages/backend/src/db.ts'],
    scopeWrite: [
      'package.json',
      'package-lock.json',
      'packages/backend/src/migrations/20260610_add_tasks.sql',
    ],
    acceptance: ['Migration runs after dependency installation'],
  });

  assert.equal(assessment.riskLevel, 'high');
  assert.equal(assessment.requiresApproval, true);
  assert.match(assessment.approvalReason ?? '', /dependency|database|root config/i);
});

test('buildApprovalCard copies assessment fields with agents execution mode and verification', () => {
  const card = buildApprovalCard({
    title: 'Backend risk module',
    description: 'Implement backend workflow risk assessment.',
    scopeRead: ['packages/backend/src/workflows/task-profile.ts'],
    scopeWrite: ['packages/backend/src/workflows/task-risk.ts'],
    agents: ['backend-executor', 'reviewer'],
    executionMode: 'serial',
    verification: ['npm run test -w @openclaw-room/backend -- src/workflows/task-risk.test.ts'],
  });
  const assessment = assessTaskRisk({
    title: 'Backend risk module',
    description: 'Implement backend workflow risk assessment.',
    scopeRead: ['packages/backend/src/workflows/task-profile.ts'],
    scopeWrite: ['packages/backend/src/workflows/task-risk.ts'],
  });

  assert.equal(card.taskKind, assessment.taskKind);
  assert.equal(card.riskLevel, assessment.riskLevel);
  assert.equal(card.requiresApproval, assessment.requiresApproval);
  assert.deepEqual(card.reasons, assessment.reasons);
  assert.deepEqual(card.agents, ['backend-executor', 'reviewer']);
  assert.equal(card.executionMode, 'serial');
  assert.deepEqual(card.verification, [
    'npm run test -w @openclaw-room/backend -- src/workflows/task-risk.test.ts',
  ]);
});
