import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { RoomAgent } from './types.js';
import { buildAgentRuntimeContextPrompt, resolveAgentRuntimeProfile } from './agent-runtime.js';

function roomAgent(overrides: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'backend-executor',
    agent_name: 'Backend Executor',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_session_handoff_pending: 0,
    acp_session_handoff_reason: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
    capabilities: ['backend'],
    default_runtime: 'acp',
    runtime_backend: null,
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
    memory_scope: 'agent',
    memory_max_context_chars: null,
    ...overrides,
  };
}

test('resolveAgentRuntimeProfile applies room override over agent defaults', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent(),
    projectPath: '/repo',
  });

  assert.equal(profile.runtimeBackend, 'acp');
  assert.equal(profile.acpBackend, 'codex');
  assert.deepEqual(profile.readableDirs, ['/repo']);
  assert.deepEqual(profile.writableDirs, ['/repo/packages/backend']);
  assert.equal(profile.acpPermissionMode, 'workspace-write');
  assert.deepEqual(profile.toolPolicy, { allowed: ['read_files', 'write_files'] });
  assert.equal(profile.memoryScope, 'agent');
  assert.equal(profile.contextBudget, null);
  assert.deepEqual(profile.warnings, []);
});

test('resolveAgentRuntimeProfile forces read-only when workspace has no writable dirs', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent({
      acp_permission_mode: 'workspace-write',
      workspace_policy: { read: ['.'], write: [] },
    }),
    projectPath: '/repo',
  });

  assert.equal(profile.acpPermissionMode, 'read-only');
  assert.deepEqual(profile.writableDirs, []);
});

test('resolveAgentRuntimeProfile treats openclaw default runtime as none', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent({
      default_runtime: 'openclaw',
      runtime_backend: null,
      acp_enabled: 0,
      acp_backend: null,
      workspace_policy: null,
      tool_policy: null,
      memory_scope: null,
    }),
    projectPath: '/repo',
  });

  assert.equal(profile.runtimeBackend, 'none');
  assert.equal(profile.acpBackend, null);
  assert.equal(profile.acpPermissionMode, 'read-only');
  assert.deepEqual(profile.toolPolicy, { allowed: [] });
  assert.equal(profile.memoryScope, 'agent');
});

test('resolveAgentRuntimeProfile forces read-only when ACP backend is unavailable', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent({
      acp_enabled: 0,
      acp_backend: null,
      default_runtime: 'acp',
      runtime_backend: 'acp',
      acp_permission_mode: 'workspace-write',
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    }),
    projectPath: '/repo',
  });

  assert.equal(profile.runtimeBackend, 'none');
  assert.equal(profile.acpBackend, null);
  assert.equal(profile.acpPermissionMode, 'read-only');
  assert.deepEqual(profile.writableDirs, ['/repo/packages/backend']);
});

test('resolveAgentRuntimeProfile rejects workspace paths that escape project root', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent({
      workspace_policy: {
        read: ['.', '../outside', '/tmp/outside'],
        write: ['packages/backend', 'packages/backend/../frontend', 'foo/..', '../outside', '/tmp/outside'],
      },
    }),
    projectPath: '/repo',
  });

  assert.deepEqual(profile.readableDirs, ['/repo']);
  assert.deepEqual(profile.writableDirs, ['/repo/packages/backend']);
  assert.equal(profile.warnings.length, 6);
});

test('resolveAgentRuntimeProfile adds image directories as read-only context', () => {
  const profile = resolveAgentRuntimeProfile({
    agent: roomAgent({
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    }),
    projectPath: '/repo',
    imagePaths: [join('/repo', 'uploads', 'shot.png')],
  });

  assert.deepEqual(profile.readableDirs, ['/repo', '/repo/uploads']);
  assert.deepEqual(profile.writableDirs, ['/repo/packages/backend']);
});

test('buildAgentRuntimeContextPrompt exposes hard boundaries', () => {
  const text = buildAgentRuntimeContextPrompt({
    runtimeBackend: 'acp',
    acpBackend: 'codex',
    acpPermissionMode: 'read-only',
    readableDirs: ['/repo'],
    writableDirs: [],
    toolPolicy: { allowed: ['read_files'] },
    memoryScope: 'room',
    contextBudget: null,
    warnings: [],
  });

  assert.match(text, /权限模式：read-only/);
  assert.match(text, /可写目录：无/);
  assert.match(text, /工具能力：read_files/);
  assert.match(text, /记忆范围：room/);
});
