import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProviderProfilePayload,
  createProviderProfileFormState,
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
