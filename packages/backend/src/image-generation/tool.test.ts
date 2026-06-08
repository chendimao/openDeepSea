import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-tool-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { sessionRepo } = await import('../repos/sessions.js');
const { createImageGenerationService } = await import('./service.js');
const { imageProviderProfileRepo } = await import('./provider-profiles.js');
const { createGenerateImageSessionTool, runGenerateImageTool } = await import('./tool.js');

test('generate image tool creates project-scoped job with active profile defaults and hides provider secret', async () => {
  const project = projectRepo.create({
    name: 'tool project',
    path: mkdtempSync(join(tmpdir(), 'image-tool-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Image Tool Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: 'Active Images',
    base_url: 'https://example.com/v1',
    api_key: 'tool-secret-token',
    model: 'gpt-image-2',
  });
  const runtimeRequests: Array<{ profileId: string; apiKey: string; count: number; quality: string; size: string }> = [];
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      runtimeRequests.push({
        profileId: request.profileId,
        apiKey: request.apiKey,
        count: request.count,
        quality: request.quality,
        size: request.size,
      });
      return {
        images: [
          {
            data: Buffer.from('fake-png'),
            mimeType: 'image/png',
            width: 16,
            height: 9,
          },
        ],
      };
    },
  });

  const result = await runGenerateImageTool({
    project_id: project.id,
    session_id: session.id,
    prompt: 'apple on a steel desk',
    workflow: 'generate',
  }, { service });

  assert.equal(result.job_id.length > 0, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.error, null);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0]?.resource_id, `file:${result.outputs[0]?.file_id}`);
  assert.match(result.outputs[0]?.url ?? '', new RegExp(`/uploads/files/${project.id}/`));
  assert.deepEqual(runtimeRequests, [{
    profileId: profile.id,
    apiKey: 'tool-secret-token',
    count: 1,
    quality: 'auto',
    size: 'auto',
  }]);
  assert.equal(JSON.stringify(result).includes('tool-secret-token'), false);
});

test('generate image tool returns failed job errors without leaking provider secrets', async () => {
  const project = projectRepo.create({
    name: 'tool failure project',
    path: mkdtempSync(join(tmpdir(), 'image-tool-failure-project-')),
  });
  imageProviderProfileRepo.create(project.id, {
    name: 'Failure Images',
    base_url: 'https://example.com/v1',
    api_key: 'failure-secret-token',
    model: 'gpt-image-2',
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => {
      throw new Error('upstream Authorization: Bearer failure-secret-token failed');
    },
  });

  const result = await runGenerateImageTool({
    project_id: project.id,
    prompt: 'broken image',
    workflow: 'generate',
  }, { service });

  assert.equal(result.status, 'failed');
  assert.equal(result.outputs.length, 0);
  assert.match(result.error ?? '', /\[REDACTED_CREDENTIAL\]/);
  assert.equal(JSON.stringify(result).includes('failure-secret-token'), false);
});

test('generate image session tool rejects unknown workflow instead of defaulting silently', async () => {
  const tool = createGenerateImageSessionTool({ id: 'session-1', project_id: 'project-1' });

  await assert.rejects(
    () => tool.execute({
      prompt: 'invalid workflow',
      workflow: 'paint',
    }),
    /workflow must be generate or image-to-image/,
  );
});
