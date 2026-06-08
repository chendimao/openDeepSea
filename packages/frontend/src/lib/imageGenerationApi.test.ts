import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';
import type { ImageGenerationJob, ImageProviderProfile } from './types';

test('image generation api posts image job payload', async () => {
  const calls: FetchCall[] = [];
  mockFetch(calls, async () => jsonResponse({
    job: fakeImageJob({ id: 'job-created' }),
    outputs: [],
  }, 202));

  try {
    const response = await api.createImageJob('project-1', {
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      provider_profile_id: 'profile-1',
    });

    assert.equal(calls[0]?.url, '/api/projects/project-1/image-jobs');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      provider_profile_id: 'profile-1',
    });
    assert.equal(response.job.id, 'job-created');
  } finally {
    restoreFetch();
  }
});

test('image generation api lists and controls project jobs', async () => {
  const calls: FetchCall[] = [];
  mockFetch(calls, async (url, init) => {
    if (String(url).includes('/cancel')) return jsonResponse({ job: fakeImageJob({ status: 'canceled' }) });
    if (String(url).includes('/retry')) return jsonResponse({ job: fakeImageJob({ id: 'job-retry' }) }, 202);
    if (String(url).endsWith('/image-jobs/job-1')) {
      return jsonResponse({
        job: fakeImageJob({ id: 'job-1' }),
        outputs: [fakeOutput()],
        source_images: [fakeSourceImage()],
      });
    }
    return jsonResponse({ jobs: [fakeImageJob({ id: 'job-listed' })] });
  });

  try {
    const listed = await api.listImageJobs('project-1', {
      sessionId: 'session-1',
      roomId: 'room-1',
      status: 'completed',
    });
    const detail = await api.getImageJob('project-1', 'job-1');
    const canceled = await api.cancelImageJob('project-1', 'job-1');
    const retried = await api.retryImageJob('project-1', 'job-1');

    assert.equal(
      calls[0]?.url,
      '/api/projects/project-1/image-jobs?sessionId=session-1&roomId=room-1&status=completed',
    );
    assert.equal(calls[1]?.url, '/api/projects/project-1/image-jobs/job-1');
    assert.equal(calls[2]?.url, '/api/projects/project-1/image-jobs/job-1/cancel');
    assert.equal(calls[2]?.init?.method, 'POST');
    assert.equal(calls[3]?.url, '/api/projects/project-1/image-jobs/job-1/retry');
    assert.equal(calls[3]?.init?.method, 'POST');
    assert.equal(listed.jobs[0]?.id, 'job-listed');
    assert.equal(detail.outputs[0]?.mime_type, 'image/png');
    assert.equal(detail.source_images[0]?.file_id, 'source-file-1');
    assert.equal(canceled.job.status, 'canceled');
    assert.equal(retried.job.id, 'job-retry');
  } finally {
    restoreFetch();
  }
});

test('image generation api manages provider profiles and models', async () => {
  const calls: FetchCall[] = [];
  mockFetch(calls, async (url, init) => {
    const path = String(url);
    if (path.endsWith('/models')) {
      return jsonResponse({
        normalized_base_url: 'https://api.example.test/v1',
        models: [{ id: 'gpt-image-2', category: 'image' }],
        warning: null,
      });
    }
    if (init?.method === 'POST' && path.endsWith('/activate')) {
      return jsonResponse(fakeProviderProfile({ active: 1 }));
    }
    if (init?.method === 'POST') return jsonResponse(fakeProviderProfile({ id: 'profile-created' }), 201);
    if (init?.method === 'PATCH') return jsonResponse(fakeProviderProfile({ name: 'Updated Provider' }));
    if (init?.method === 'DELETE') return jsonResponse(fakeProviderProfile({ deleted_at: 1 }));
    return jsonResponse([fakeProviderProfile()]);
  });

  try {
    const profiles = await api.listImageProviderProfiles('project-1');
    const created = await api.createImageProviderProfile('project-1', {
      name: 'SCimage',
      base_url: 'https://api.example.test',
      api_key: 'secret',
      model: 'gpt-image-2',
      compat_profile_id: 'openai',
      supports_count_parameter: true,
    });
    const updated = await api.updateImageProviderProfile('project-1', 'profile-1', {
      name: 'Updated Provider',
      base_url: 'https://api.example.test/v1',
      api_key: '',
      model: 'gpt-image-2',
      compat_profile_id: 'openai',
      supports_count_parameter: true,
    });
    const activated = await api.activateImageProviderProfile('project-1', 'profile-1');
    const models = await api.listImageProviderModels('project-1', 'profile-1');
    const deleted = await api.deleteImageProviderProfile('project-1', 'profile-1');

    assert.equal(calls[0]?.url, '/api/projects/project-1/image-provider-profiles');
    assert.equal(calls[1]?.url, '/api/projects/project-1/image-provider-profiles');
    assert.equal(calls[1]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      name: 'SCimage',
      base_url: 'https://api.example.test',
      api_key: 'secret',
      model: 'gpt-image-2',
      compat_profile_id: 'openai',
      supports_count_parameter: true,
    });
    assert.equal(calls[2]?.url, '/api/projects/project-1/image-provider-profiles/profile-1');
    assert.equal(calls[2]?.init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
      name: 'Updated Provider',
      base_url: 'https://api.example.test/v1',
      api_key: '',
      model: 'gpt-image-2',
      compat_profile_id: 'openai',
      supports_count_parameter: true,
    });
    assert.equal(calls[3]?.url, '/api/projects/project-1/image-provider-profiles/profile-1/activate');
    assert.equal(calls[3]?.init?.method, 'POST');
    assert.equal(calls[4]?.url, '/api/projects/project-1/image-provider-profiles/models');
    assert.equal(calls[4]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { profile_id: 'profile-1' });
    assert.equal(calls[5]?.url, '/api/projects/project-1/image-provider-profiles/profile-1');
    assert.equal(calls[5]?.init?.method, 'DELETE');
    assert.equal(profiles[0]?.id, 'profile-1');
    assert.equal(created.id, 'profile-created');
    assert.equal(updated.name, 'Updated Provider');
    assert.equal(activated.active, 1);
    assert.equal(models.models[0]?.id, 'gpt-image-2');
    assert.equal(deleted.deleted_at, 1);
  } finally {
    restoreFetch();
  }
});

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;

function mockFetch(calls: FetchCall[], handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeProviderProfile(overrides: Partial<ImageProviderProfile> = {}): ImageProviderProfile {
  return {
    id: 'profile-1',
    project_id: 'project-1',
    name: 'SCimage',
    base_url: 'https://api.example.test/v1',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: 1,
    active: 0,
    has_api_key: 1,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}

function fakeImageJob(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return {
    id: 'job-1',
    project_id: 'project-1',
    room_id: null,
    session_id: null,
    source_message_id: null,
    source_agent_id: null,
    source_task_id: null,
    provider_profile_id: 'profile-1',
    workflow: 'generate',
    prompt: 'apple',
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
    ...overrides,
  };
}

function fakeOutput() {
  return {
    id: 'output-1',
    job_id: 'job-1',
    file_id: 'file-1',
    slot: 1,
    name: 'image.png',
    url: '/api/files/file-1/content',
    mime_type: 'image/png',
    size: 68,
    width: null,
    height: null,
    created_at: 1,
  };
}

function fakeSourceImage() {
  return {
    id: 'source-image-1',
    job_id: 'job-1',
    file_id: 'source-file-1',
    slot: 1,
    url: '/api/files/source-file-1/content',
    origin_job_id: null,
    origin_output_id: null,
    created_at: 1,
  };
}
