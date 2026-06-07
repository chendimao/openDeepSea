import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-startup-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { imageGenerationJobRepo } = await import('./jobs.js');
const { imageProviderProfileRepo } = await import('./provider-profiles.js');

test('server startup recovers interrupted image generation jobs', async () => {
  const project = projectRepo.create({
    name: 'image generation startup recovery',
    path: mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-startup-project-')),
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: 'Startup Recovery Provider',
    base_url: 'https://startup.example.test/v1',
    api_key: 'startup-key',
    model: 'startup-image-model',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });
  const queued = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, 'queued'));
  const running = imageGenerationJobRepo.markRunning(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, 'running')).id,
  );
  const canceling = imageGenerationJobRepo.markCanceling(
    imageGenerationJobRepo.markRunning(
      imageGenerationJobRepo.create(createJobInput(project.id, profile.id, 'canceling')).id,
    ).id,
  );
  const port = await getAvailablePort();
  const serverPath = fileURLToPath(new URL('../server.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      OPENDEEPSEA_LOCAL_TOKEN: 'startup-recovery-token',
      OPENDEEPSEA_PROVIDER_SUPERPOWERS_AUTO_INSTALL: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  try {
    await waitForServer(port, child);
    await waitForRecovered([queued.id, running.id, canceling.id]);
  } finally {
    child.kill('SIGINT');
    await waitForChildExit(child);
  }

  for (const jobId of [queued.id, running.id, canceling.id]) {
    const job = imageGenerationJobRepo.get(jobId);
    assert.equal(job?.status, 'canceled');
    assert.equal(job?.message, '后端重启，图片生成任务已停止。');
    assert.equal(job?.error, null);
  }
  assert.equal(stdout.join('').includes('startup-key'), false);
  assert.equal(stderr.join('').includes('startup-key'), false);
});

function createJobInput(projectId: string, profileId: string, prompt: string) {
  return {
    project_id: projectId,
    room_id: null,
    session_id: null,
    source_message_id: null,
    source_agent_id: null,
    source_task_id: null,
    provider_profile_id: profileId,
    workflow: 'generate' as const,
    prompt,
    count: 1,
    quality: 'auto',
    size: 'auto',
  };
}

async function waitForServer(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { 'x-opendeepsea-local-token': 'startup-recovery-token' },
      });
      if (res.ok) return;
    } catch {
      // keep polling until the server listens
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function waitForRecovered(jobIds: string[]): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const jobs = jobIds.map((jobId) => imageGenerationJobRepo.get(jobId));
    if (jobs.every((job) => job?.status === 'canceled')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('image generation jobs were not recovered');
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
  return port;
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
  const result = await Promise.race([exited, timeout]);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }
}
