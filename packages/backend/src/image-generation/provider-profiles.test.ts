import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-provider-profiles-')), 'test.db');

const [{ projectRepo }, { imageProviderProfileRepo }, { normalizeImageBaseUrl }] = await Promise.all([
  import('../repos/projects.js'),
  import('./provider-profiles.js'),
  import('./validation.js'),
]);

function createProject(name: string) {
  return projectRepo.create({ name, path: mkdtempSync(join(tmpdir(), 'opendeepsea-provider-profile-project-')) });
}

test('normalizeImageBaseUrl appends v1 for OpenAI root URL', () => {
  assert.equal(normalizeImageBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1');
});

test('provider profiles create active safe profile and clear other active profiles', () => {
  const project = createProject('provider-create');

  const first = imageProviderProfileRepo.create(project.id, {
    name: 'OpenAI Images',
    base_url: 'https://api.openai.com',
    api_key: 'secret-key',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });

  assert.equal(first.base_url, 'https://api.openai.com/v1');
  assert.equal(first.active, 1);
  assert.equal(first.has_api_key, 1);
  assert.equal(Object.hasOwn(first, 'api_key'), false);

  const second = imageProviderProfileRepo.create(project.id, {
    name: 'SC Image',
    base_url: 'https://scimage.example/v1/',
    api_key: 'second-secret',
    model: 'gpt-image-2',
    compat_profile_id: 'openai-sdk',
    supports_count_parameter: false,
  });

  assert.equal(second.active, 1);
  assert.equal(Object.hasOwn(second, 'api_key'), false);

  const listed = imageProviderProfileRepo.list(project.id);
  assert.deepEqual(
    listed.map((profile) => ({ id: profile.id, active: profile.active, hasApiKey: profile.has_api_key })),
    [
      { id: second.id, active: 1, hasApiKey: 1 },
      { id: first.id, active: 0, hasApiKey: 1 },
    ],
  );
  assert.equal(imageProviderProfileRepo.getActive(project.id)?.id, second.id);
});

test('provider profile update preserves empty or omitted api key and replaces new key', () => {
  const project = createProject('provider-update');
  const created = imageProviderProfileRepo.create(project.id, {
    name: 'OpenAI Images',
    base_url: 'https://api.openai.com',
    api_key: 'secret-key',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });

  const omittedKey = imageProviderProfileRepo.update(project.id, created.id, {
    name: 'OpenAI Images Updated',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-image-3',
    compat_profile_id: 'images-edits',
    supports_count_parameter: false,
  });

  assert.equal(omittedKey.model, 'gpt-image-3');
  assert.equal(omittedKey.has_api_key, 1);
  assert.equal(imageProviderProfileRepo.get(created.id)?.api_key, 'secret-key');

  imageProviderProfileRepo.update(project.id, created.id, {
    name: 'OpenAI Images Updated',
    base_url: 'https://api.openai.com/v1',
    api_key: '   ',
    model: 'gpt-image-3',
    compat_profile_id: 'images-edits',
    supports_count_parameter: false,
  });

  assert.equal(imageProviderProfileRepo.get(created.id)?.api_key, 'secret-key');

  imageProviderProfileRepo.update(project.id, created.id, {
    name: 'OpenAI Images Updated',
    base_url: 'https://api.openai.com/v1',
    api_key: 'new-secret',
    model: 'gpt-image-3',
    compat_profile_id: 'images-edits',
    supports_count_parameter: true,
  });

  assert.equal(imageProviderProfileRepo.get(created.id)?.api_key, 'new-secret');
});

test('provider profiles reject duplicate active names case-insensitively', () => {
  const project = createProject('provider-duplicates');
  imageProviderProfileRepo.create(project.id, {
    name: 'OpenAI Images',
    base_url: 'https://api.openai.com',
    api_key: 'secret-key',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });

  assert.throws(
    () =>
      imageProviderProfileRepo.create(project.id, {
        name: ' openai images ',
        base_url: 'https://api.openai.com',
        api_key: 'second-secret',
        model: 'gpt-image-2',
        compat_profile_id: 'openai',
        supports_count_parameter: true,
      }),
    /name already exists/i,
  );
});

test('provider profiles activate one profile per project', () => {
  const project = createProject('provider-activate');
  const first = imageProviderProfileRepo.create(project.id, {
    name: 'OpenAI Images',
    base_url: 'https://api.openai.com',
    api_key: 'secret-key',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });
  const second = imageProviderProfileRepo.create(project.id, {
    name: 'SC Image',
    base_url: 'https://scimage.example/v1',
    api_key: 'second-secret',
    model: 'gpt-image-2',
    compat_profile_id: 'openai-sdk',
    supports_count_parameter: true,
  });

  assert.equal(imageProviderProfileRepo.getActive(project.id)?.id, second.id);

  const activated = imageProviderProfileRepo.activate(project.id, first.id);

  assert.equal(activated.id, first.id);
  assert.equal(activated.active, 1);
  assert.equal(imageProviderProfileRepo.getActive(project.id)?.id, first.id);
  assert.deepEqual(
    imageProviderProfileRepo.list(project.id).map((profile) => ({ id: profile.id, active: profile.active })),
    [
      { id: first.id, active: 1 },
      { id: second.id, active: 0 },
    ],
  );
});

test('provider profiles soft delete and CRUD ignore deleted profiles', () => {
  const project = createProject('provider-delete');
  const deleted = imageProviderProfileRepo.create(project.id, {
    name: 'OpenAI Images',
    base_url: 'https://api.openai.com',
    api_key: 'secret-key',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });
  const remaining = imageProviderProfileRepo.create(project.id, {
    name: 'SC Image',
    base_url: 'https://scimage.example/v1',
    api_key: 'second-secret',
    model: 'gpt-image-2',
    compat_profile_id: 'openai-sdk',
    supports_count_parameter: true,
  });

  const result = imageProviderProfileRepo.softDelete(project.id, deleted.id);

  assert.equal(result?.id, deleted.id);
  assert.deepEqual(
    imageProviderProfileRepo.list(project.id).map((profile) => profile.id),
    [remaining.id],
  );
  assert.equal(imageProviderProfileRepo.get(deleted.id), undefined);
  assert.equal(imageProviderProfileRepo.getActive(project.id)?.id, remaining.id);
  assert.throws(
    () =>
      imageProviderProfileRepo.update(project.id, deleted.id, {
        name: 'Deleted',
        base_url: 'https://api.openai.com',
        api_key: 'new-secret',
        model: 'gpt-image-3',
        compat_profile_id: 'openai',
        supports_count_parameter: true,
      }),
    /not found/i,
  );
  assert.throws(() => imageProviderProfileRepo.activate(project.id, deleted.id), /not found/i);
});
