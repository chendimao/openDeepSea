import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageMetadata } from './messageMetadata';

test('parseMessageMetadata keeps legacy message upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'message-attachment-1',
        name: 'legacy.png',
        mimeType: 'image/png',
        size: 1024,
        url: '/uploads/messages/stored.png',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'message-attachment-1',
      fileId: undefined,
      name: 'legacy.png',
      mimeType: 'image/png',
      size: 1024,
      url: '/uploads/messages/stored.png',
      isImage: true,
      deleted: undefined,
    },
  ]);
});

test('parseMessageMetadata accepts project file upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'file-1',
        fileId: 'file-1',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 2048,
        url: '/uploads/files/project-1/stored.png',
        isImage: true,
        deleted: false,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'file-1',
      fileId: 'file-1',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 2048,
      url: '/uploads/files/project-1/stored.png',
      isImage: true,
      deleted: false,
    },
  ]);
});

test('parseMessageMetadata rejects unsafe attachment URLs', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'external',
        name: 'external.png',
        mimeType: 'image/png',
        size: 1,
        url: 'https://example.com/uploads/files/project-1/stored.png',
        isImage: true,
      },
      {
        id: 'traversal',
        name: 'traversal.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/files/project-1/%2e%2e/secret.png',
        isImage: true,
      },
      {
        id: 'script',
        name: 'script.png',
        mimeType: 'image/png',
        size: 1,
        url: 'javascript:alert(1)',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, []);
});

test('parseMessageMetadata accepts collaboration decision metadata', () => {
  const metadata = JSON.stringify({
    event_type: 'collaboration_decision',
    source_message_id: 'message-1',
    fallback_agent_id: 'planner',
    collaboration_decision: {
      intent: 'implementation',
      recommendedMode: 'formal_workflow',
      problemArea: 'frontend',
      summary: '修复群聊协作调度',
      rationale: '涉及代码修改，应由用户选择正式 workflow 或轻量协作。',
      needsUserChoice: true,
      proposedAgents: {
        executors: ['frontend-dev'],
        reviewers: ['reviewer'],
        testers: [],
        acceptors: [],
      },
      stages: [
        {
          stage: 'execute',
          agentIds: ['frontend-dev'],
          parallel: false,
          goal: '实现修复',
        },
        {
          stage: 'review',
          agentIds: ['reviewer'],
          parallel: false,
          goal: '审查修复',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.source_message_id, 'message-1');
  assert.equal(parsed.fallback_agent_id, 'planner');
  assert.equal(parsed.collaboration_decision?.summary, '修复群聊协作调度');
  assert.equal(parsed.collaboration_decision?.stages[1]?.stage, 'review');
});

test('parseMessageMetadata ignores invalid collaboration decision metadata', () => {
  const metadata = JSON.stringify({
    event_type: 'collaboration_decision',
    source_message_id: 'message-1',
    collaboration_decision: {
      intent: 'implementation',
      recommendedMode: 'chat_collaboration',
      problemArea: 'mobile',
      summary: '',
      rationale: 'bad',
      needsUserChoice: true,
      proposedAgents: {
        executors: ['frontend-dev'],
        reviewers: ['reviewer'],
        testers: [],
        acceptors: [],
      },
      stages: [
        {
          stage: 'deploy',
          agentIds: ['frontend-dev'],
          parallel: false,
          goal: 'bad',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.source_message_id, undefined);
  assert.equal(parsed.collaboration_decision, undefined);
});
