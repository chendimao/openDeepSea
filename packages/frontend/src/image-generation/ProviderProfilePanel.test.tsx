import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderProfilePanelView } from './ProviderProfilePanel';
import { createProviderProfileFormState } from './imageGenerationModel';
import type { ImageProviderProfile } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('provider panel view renders active profile controls without exposing saved api key', () => {
  const activeProfile = fakeProviderProfile({
    id: 'profile-active',
    name: 'OpenAI Images',
    active: 1,
    has_api_key: 1,
  });
  const html = renderToStaticMarkup(
    <ProviderProfilePanelView
      profiles={[activeProfile, fakeProviderProfile({ id: 'profile-other', name: 'Backup Images' })]}
      selectedProfile={activeProfile}
      form={createProviderProfileFormState(activeProfile)}
      mode="edit"
      error={null}
      modelWarning="模型列表接口暂不可用"
      modelIds={['gpt-image-2']}
      busy={false}
      modelsLoading={false}
      onCreateProfile={() => undefined}
      onSelectProfile={() => undefined}
      onFormChange={() => undefined}
      onSave={() => undefined}
      onActivate={() => undefined}
      onDelete={() => undefined}
      onFetchModels={() => undefined}
    />,
  );

  assert.match(html, /OpenAI Images/);
  assert.match(html, /当前使用/);
  assert.match(html, /已保存密钥/);
  assert.match(html, /模型列表接口暂不可用/);
  assert.match(html, /gpt-image-2/);
  assert.match(html, /保存配置/);
  assert.match(html, /设为当前/);
  assert.doesNotMatch(html, /secret/);
});

function fakeProviderProfile(overrides: Partial<ImageProviderProfile> = {}): ImageProviderProfile {
  return {
    id: 'profile-1',
    project_id: 'project-1',
    name: 'SCimage',
    base_url: 'https://api.example.test',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: 1,
    active: 0,
    has_api_key: 0,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}
