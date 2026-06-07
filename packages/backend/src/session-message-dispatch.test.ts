import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-dispatch-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { fileRepo } = await import('./repos/files.js');
const { settingsRepo } = await import('./repos/settings.js');
const { sessionMessageRepo, sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const {
  dispatchSessionUserMessage,
  recordSessionImageGenerationJobMessage,
  recordSessionImageGenerationToolResultEvidence,
} = await import('./session-message-dispatch.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
});

test('dispatchSessionUserMessage uses project Session Planner backend instead of session provider', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Planner Backend',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-planner-backend-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'opencode',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'opencode-session', stderr: '' }),
  });

  await dispatchSessionUserMessage({ sessionId: session.id, content: '分析当前项目' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const [run] = sessionRunRepo.listBySession(session.id);
  assert.equal(run?.agent_id, 'planner');
  assert.equal(run?.provider, 'opencode');
  assert.match(run?.runtime_profile_snapshot ?? '', /"backend_source":"project"/);
});

test('dispatchSessionUserMessage stores normalized file refs in message metadata', async () => {
  const project = projectRepo.create({
    name: 'Dispatch File Refs',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-file-refs-')),
  });
  mkdirSync(join(project.path, 'src'), { recursive: true });
  writeFileSync(join(project.path, 'src', 'app.ts'), 'export const answer = 42;\n');
  const libraryFile = fileRepo.createAgentDocument({
    project_id: project.id,
    title: 'handoff.md',
    content: '历史交接记录',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch File Refs',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-session', stderr: '' }),
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '结合这些文件分析',
    workspaceFileRefs: [' ./src/../src/app.ts ', 'src/app.ts'],
    libraryFileRefs: [libraryFile.id, libraryFile.id],
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as {
    workspace_file_refs?: string[];
    library_file_refs?: string[];
  };
  assert.deepEqual(metadata.workspace_file_refs, ['src/app.ts']);
  assert.deepEqual(metadata.library_file_refs, [libraryFile.id]);
});

test('dispatchSessionUserMessage stores uploaded project file refs as message attachments', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Uploaded Attachment Metadata',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-uploaded-attachment-')),
  });
  const storedPath = join(project.path, 'brief.txt');
  writeFileSync(storedPath, '用户粘贴的文本附件');
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'brief.txt',
    stored_name: 'stored-brief.txt',
    mime_type: 'text/plain',
    size: 27,
    url: '/uploads/files/project/brief.txt',
    storage_path: storedPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Uploaded Attachment Metadata',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-uploaded-metadata', stderr: '' }),
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析附件',
    libraryFileRefs: [uploadedFile.id],
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as {
    library_file_refs?: string[];
    attachments?: Array<{
      id: string;
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      url: string;
      isImage: boolean;
      deleted: boolean;
    }>;
  };
  assert.deepEqual(metadata.library_file_refs, [uploadedFile.id]);
  assert.deepEqual(metadata.attachments, [{
    id: uploadedFile.id,
    fileId: uploadedFile.id,
    name: 'brief.txt',
    mimeType: 'text/plain',
    size: 27,
    isImage: false,
    url: '/uploads/files/project/brief.txt',
    deleted: false,
  }]);
});

test('dispatchSessionUserMessage rejects foreign library refs before creating a message', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Reject File Refs',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-reject-file-refs-')),
  });
  const otherProject = projectRepo.create({
    name: 'Dispatch Foreign Library',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-foreign-library-')),
  });
  const foreignFile = fileRepo.createAgentDocument({
    project_id: otherProject.id,
    title: 'foreign.md',
    content: '其它项目的资料',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Reject File Refs',
    provider: 'codex',
    workspace_path: project.path,
  });

  await assert.rejects(
    () => dispatchSessionUserMessage({
      sessionId: session.id,
      content: '不要创建这条消息',
      libraryFileRefs: [foreignFile.id],
    }),
    /library file reference is not available/,
  );
  assert.equal(sessionRepo.get(session.id)?.title, 'Dispatch Reject File Refs');
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
});

test('dispatchSessionUserMessage injects referenced file context into runtime prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-dispatch-context-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = true;\n');
  const project = projectRepo.create({ name: 'Dispatch Context', path: root });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Context Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-context', stderr: '' };
    },
  });

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析引用',
    workspaceFileRefs: ['src/app.ts'],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(prompts[0] ?? '', /## Referenced Files/);
  assert.match(prompts[0] ?? '', /Source: src\/app\.ts/);
  assert.match(prompts[0] ?? '', /export const app = true/);
});

test('dispatchSessionUserMessage injects uploaded text and image project files into runtime context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-dispatch-uploaded-context-'));
  const textPath = join(root, 'notes.md');
  const imagePath = join(root, 'screen.png');
  writeFileSync(textPath, '# 粘贴文本\n\n请读取这段内容。\n');
  writeFileSync(imagePath, 'fake-png');
  const project = projectRepo.create({ name: 'Dispatch Uploaded Context', path: root });
  const textFile = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.md',
    stored_name: 'stored-notes.md',
    mime_type: 'text/markdown',
    size: 42,
    url: '/uploads/files/project/notes.md',
    storage_path: textPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const imageFile = fileRepo.create({
    project_id: project.id,
    original_name: 'screen.png',
    stored_name: 'stored-screen.png',
    mime_type: 'image/png',
    size: 8,
    url: '/uploads/files/project/screen.png',
    storage_path: imagePath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Uploaded Context Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const captured: Array<{ prompt: string; imagePaths?: string[] }> = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, imagePaths }) => {
      captured.push({ prompt, imagePaths });
      return { exitCode: 0, sessionId: 'codex-uploaded-context', stderr: '' };
    },
  });

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析粘贴附件',
    libraryFileRefs: [textFile.id, imageFile.id],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(captured[0]?.prompt ?? '', /Library: notes\.md/);
  assert.match(captured[0]?.prompt ?? '', /请读取这段内容/);
  assert.deepEqual(captured[0]?.imagePaths, [realpathSync(imagePath)]);
});

test('recordSessionImageGenerationJobMessage stores image job id and output attachments', () => {
  const project = projectRepo.create({
    name: 'Session Image Job Message',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-job-message-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Session Image Job Message',
    provider: 'codex',
    workspace_path: project.path,
  });

  const message = recordSessionImageGenerationJobMessage({
    sessionId: session.id,
    job: {
      id: 'image-job-output-test',
      project_id: project.id,
      room_id: null,
      session_id: session.id,
      source_message_id: null,
      source_agent_id: null,
      source_task_id: null,
      provider_profile_id: 'profile-test',
      workflow: 'generate',
      prompt: '生成一张海报',
      count: 1,
      quality: 'auto',
      size: 'auto',
      status: 'completed',
      message: null,
      error: null,
      created_at: 1,
      started_at: 2,
      completed_at: 3,
      updated_at: 3,
    },
    outputs: [{
      id: 'output-test',
      job_id: 'image-job-output-test',
      file_id: 'file-output-test',
      slot: 1,
      name: 'generated.png',
      url: '/uploads/files/generated.png',
      mime_type: 'image/png',
      size: 42,
      width: 1024,
      height: 1024,
      created_at: 3,
    }],
  });

  const stored = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(stored?.metadata ?? '{}') as {
    image_generation_job_id?: string;
    image_generation_status?: string;
    attachments?: Array<{
      id: string;
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      url: string;
      isImage: boolean;
    }>;
  };
  assert.equal(message.role, 'system');
  assert.equal(message.sender_id, 'image-generation');
  assert.match(message.content, /生成一张海报/);
  assert.equal(metadata.image_generation_job_id, 'image-job-output-test');
  assert.equal(metadata.image_generation_status, 'completed');
  assert.deepEqual(metadata.attachments, [{
    id: 'file-output-test',
    fileId: 'file-output-test',
    name: 'generated.png',
    mimeType: 'image/png',
    size: 42,
    url: '/uploads/files/generated.png',
    isImage: true,
  }]);
});

test('recordSessionImageGenerationJobMessage rejects mismatched job and target session', () => {
  const project = projectRepo.create({
    name: 'Session Image Job Mismatch',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-job-mismatch-')),
  });
  const sourceSession = sessionRepo.create({
    project_id: project.id,
    title: 'Source Image Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const targetSession = sessionRepo.create({
    project_id: project.id,
    title: 'Target Image Session',
    provider: 'codex',
    workspace_path: project.path,
  });

  assert.throws(
    () => recordSessionImageGenerationJobMessage({
      sessionId: targetSession.id,
      job: {
        id: 'image-job-mismatch-test',
        project_id: project.id,
        room_id: null,
        session_id: sourceSession.id,
        source_message_id: null,
        source_agent_id: null,
        source_task_id: null,
        provider_profile_id: 'profile-test',
        workflow: 'generate',
        prompt: '不要写入错误会话',
        count: 1,
        quality: 'auto',
        size: 'auto',
        status: 'queued',
        message: null,
        error: null,
        created_at: 1,
        started_at: null,
        completed_at: null,
        updated_at: 1,
      },
    }),
    /image generation job session mismatch/,
  );
  assert.equal(sessionMessageRepo.listBySession(targetSession.id).length, 0);
});

test('recordSessionImageGenerationToolResultEvidence stores generated outputs as session evidence', () => {
  const project = projectRepo.create({
    name: 'Session Image Tool Evidence',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-tool-evidence-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Session Image Tool Evidence',
    provider: 'codex',
    workspace_path: project.path,
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    phase: 'implementing',
    prompt: '生成图片',
  });

  const event = recordSessionImageGenerationToolResultEvidence({
    sessionId: session.id,
    sourceRunId: run.id,
    result: {
      job_id: 'image-tool-job-1',
      status: 'completed',
      error: null,
      outputs: [{
        file_id: 'file-generated-1',
        resource_id: 'file:file-generated-1',
        url: '/uploads/files/project/generated.png',
        slot: 1,
      }],
    },
  });

  assert.equal(event.event_type, 'tool_result');
  assert.equal(event.source_run_id, run.id);
  assert.equal(event.title, '图片生成结果');
  assert.match(event.summary ?? '', /1 张图片/);
  assert.deepEqual(event.payload, {
    tool_name: 'generate_image',
    job_id: 'image-tool-job-1',
    status: 'completed',
    error: null,
    outputs: [{
      file_id: 'file-generated-1',
      resource_id: 'file:file-generated-1',
      url: '/uploads/files/project/generated.png',
      slot: 1,
    }],
  });
});
