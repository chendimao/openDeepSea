import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPromptPresetPayload,
  buildProviderProfilePayload,
  createPromptPresetDraft,
  createProviderProfileFormState,
  filterImageJobGroups,
} from './imageGenerationModel';

test('provider form keeps blank api key as preserve existing secret', () => {
  const payload = buildProviderProfilePayload({
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    model: 'gpt-image-2',
    compatProfileId: 'openai',
    supportsCountParameter: true,
  });

  assert.equal('api_key' in payload, false);
});

test('provider form trims text fields and maps UI names to API payload', () => {
  const payload = buildProviderProfilePayload({
    name: ' SCimage ',
    baseUrl: ' https://api.example.test/v1 ',
    apiKey: ' secret ',
    model: ' flux-kontext ',
    compatProfileId: 'openai-sdk',
    supportsCountParameter: false,
  });

  assert.deepEqual(payload, {
    name: 'SCimage',
    base_url: 'https://api.example.test/v1',
    api_key: 'secret',
    model: 'flux-kontext',
    compat_profile_id: 'openai-sdk',
    supports_count_parameter: false,
  });
});

test('provider form state never includes saved raw api key', () => {
  const state = createProviderProfileFormState({
    id: 'profile-1',
    project_id: 'project-1',
    name: 'Saved Provider',
    base_url: 'https://api.example.test',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: 1,
    active: 1,
    has_api_key: 1,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  });

  assert.equal(state.apiKey, '');
  assert.equal(state.name, 'Saved Provider');
  assert.equal(state.hasSavedApiKey, true);
});

test('prompt preset draft uses current prompt and payload trims fields', () => {
  const draft = createPromptPresetDraft('  生成一张深海主题产品海报，使用冷色调  ');
  const payload = buildPromptPresetPayload({
    ...draft,
    title: '',
  });

  assert.equal(draft.prompt, '生成一张深海主题产品海报，使用冷色调');
  assert.deepEqual(payload, {
    title: '生成一张深海主题产品海报',
    prompt: '生成一张深海主题产品海报，使用冷色调',
  });
});

test('image job group filters match group label and key', () => {
  const groups = filterImageJobGroups([
    {
      key: 'apple poster',
      label: 'Apple Poster',
      count: 2,
      latest_job_id: 'job-1',
      latest_updated_at: 2,
    },
    {
      key: 'banana poster',
      label: 'Banana Poster',
      count: 1,
      latest_job_id: 'job-2',
      latest_updated_at: 1,
    },
  ], 'APPLE');

  assert.deepEqual(groups.map((group) => group.key), ['apple poster']);
});
