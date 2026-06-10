import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskRisk, buildApprovalCard } from './task-risk.js';
import type { ParsedVerificationCommand } from './plan-parser.js';

const verificationCommands: ParsedVerificationCommand[] = [
  {
    command: 'node --import tsx --test src/workflows/task-risk.test.ts',
    reason: 'covers task risk assessment behavior',
    required: true,
  },
];

test('classifies small README-only edits as low-risk documentation work', () => {
  const assessment = assessTaskRisk({
    title: 'Update README',
    description: 'Small documentation-only README change for setup instructions.',
    scopeRead: ['README.md'],
    scopeWrite: ['README.md'],
    acceptance: ['README explains local setup clearly'],
    verificationCommands,
  });

  assert.equal(assessment.taskKind, 'docs_only');
  assert.equal(assessment.riskLevel, 'low');
  assert.equal(assessment.requiresApproval, false);
  assert.equal(assessment.approvalReason, '');
  assert.equal(typeof assessment.confidence, 'number');
  assert.deepEqual(assessment.scopeRead, ['README.md']);
  assert.deepEqual(assessment.scopeWrite, ['README.md']);
  assert.deepEqual(assessment.verificationCommands, verificationCommands);
  assert.ok(assessment.reasons.some((reason) => /small|documentation-only/i.test(reason)));
  assert.equal('profile' in assessment, false);
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
  assert.match(assessment.approvalReason, /front\/back|前后端/i);
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
  assert.match(assessment.approvalReason, /dependency|database|root config/i);
});

test('marks CI and build pipeline files as high risk before workflow medium rules', () => {
  const ciConfigPaths = [
    '.github/workflows/ci.yml',
    '.gitlab-ci.yml',
    'circleci/config.yml',
    'azure-pipelines.yml',
  ];

  for (const path of ciConfigPaths) {
    const assessment = assessTaskRisk({
      title: 'Update CI pipeline',
      description: 'Change build pipeline checks.',
      scopeRead: [],
      scopeWrite: [path],
    });

    assert.equal(assessment.riskLevel, 'high', path);
    assert.equal(assessment.requiresApproval, true, path);
    assert.match(assessment.approvalReason, /ci|pipeline|build/i, path);
  }

  const textSignalAssessment = assessTaskRisk({
    title: 'Update release checks',
    description: 'Change 持续集成 build pipeline behavior.',
    scopeRead: [],
    scopeWrite: ['scripts/release-checks.sh'],
  });

  assert.equal(textSignalAssessment.riskLevel, 'high');
  assert.equal(textSignalAssessment.requiresApproval, true);
  assert.match(textSignalAssessment.approvalReason, /ci|pipeline|build/i);
});

test('returns verification commands and requires approval for low-confidence tasks', () => {
  const assessment = assessTaskRisk({
    title: 'Investigate unknown task',
    description: 'TBD',
    scopeRead: [],
    scopeWrite: [],
    verificationCommands,
  });

  assert.equal(assessment.riskLevel, 'medium');
  assert.equal(assessment.requiresApproval, true);
  assert.match(assessment.approvalReason, /low-confidence/i);
  assert.ok(assessment.confidence < 0.45);
  assert.deepEqual(assessment.verificationCommands, verificationCommands);
});

test('requires approval for a single workflow shared schema or types file', () => {
  const assessment = assessTaskRisk({
    title: 'Adjust risk state',
    description: 'Update one risk state file.',
    scopeRead: [],
    scopeWrite: ['packages/backend/src/workflows/graph/state.ts'],
  });

  assert.equal(assessment.riskLevel, 'medium');
  assert.equal(assessment.requiresApproval, true);
  assert.match(assessment.approvalReason, /workflow|shared|schema|types/i);
});

test('keeps a small single frontend file below approval until higher-level rules decide', () => {
  const assessment = assessTaskRisk({
    title: 'Update frontend copy',
    description: 'Adjust one React component label.',
    scopeRead: ['packages/frontend/src/components/Header.tsx'],
    scopeWrite: ['packages/frontend/src/components/Header.tsx'],
  });

  assert.equal(assessment.taskKind, 'frontend_change');
  assert.equal(assessment.riskLevel, 'low');
  assert.equal(assessment.requiresApproval, false);
});

test('buildApprovalCard copies assessment fields with agents execution mode and verification', () => {
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
    verificationCommands,
  });
  const card = buildApprovalCard({
    assessment,
    agents: ['backend-executor', 'reviewer'],
    executionMode: 'hybrid',
    risks: ['Frontend and backend behavior must stay consistent'],
    assumptions: ['Existing workflow route remains the integration boundary'],
  });

  assert.equal(card.taskKind, assessment.taskKind);
  assert.equal(card.riskLevel, assessment.riskLevel);
  assert.match(card.summary, /fullstack_change|front\/back|approval/i);
  assert.equal(card.approvalReason, assessment.approvalReason);
  assert.deepEqual(card.scopeRead, assessment.scopeRead);
  assert.deepEqual(card.scopeWrite, assessment.scopeWrite);
  assert.deepEqual(card.agents, ['backend-executor', 'reviewer']);
  assert.equal(card.executionMode, 'hybrid');
  assert.deepEqual(card.verification, verificationCommands);
  assert.deepEqual(card.risks, ['Frontend and backend behavior must stay consistent']);
  assert.deepEqual(card.assumptions, ['Existing workflow route remains the integration boundary']);
});

test('buildApprovalCard rejects low-risk assessments', () => {
  const assessment = assessTaskRisk({
    title: 'Update README',
    description: 'Small documentation-only README change.',
    scopeRead: ['README.md'],
    scopeWrite: ['README.md'],
  });

  assert.throws(
    () => buildApprovalCard({
      assessment,
      agents: [],
      executionMode: 'serial',
    }),
    /low-risk/i,
  );
});
