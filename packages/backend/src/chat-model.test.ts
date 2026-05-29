import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { testConfiguredModel } from './chat-model.js';

test('testConfiguredModel reports success without exposing api key', async () => {
  const result = await testConfiguredModel(
    {
      langchain_planner_model: ' test-model ',
      openai_api_key: ' sk-test-secret1234 ',
      openai_base_url: ' https://model.example ',
    },
    {
      prompt: ' custom prompt ',
      tester: {
        async invoke(messages) {
          const humanMessage = messages.find((message): message is HumanMessage => message instanceof HumanMessage);
          assert.equal(humanMessage?.content, 'custom prompt');
          return ' model ok ';
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.model, 'test-model');
  assert.equal(result.baseURL, 'https://model.example/v1');
  assert.equal(result.output, 'model ok');
  assert.equal(result.error, null);
  assert.equal(typeof result.tested_at, 'number');
  assert.equal(JSON.stringify(result).includes('sk-test-secret1234'), false);
});

test('testConfiguredModel reports missing api key without invoking model tester', async () => {
  let invoked = false;
  const result = await testConfiguredModel(
    {
      langchain_planner_model: 'test-model',
      openai_api_key: null,
      openai_base_url: 'https://model.example/v1',
    },
    {
      tester: {
        async invoke() {
          invoked = true;
          return 'unexpected';
        },
      },
    },
  );

  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'missing_credentials');
  assert.equal(result.model, 'test-model');
  assert.equal(result.baseURL, 'https://model.example/v1');
  assert.equal(result.output, null);
  assert.equal(result.error, 'AI config requires both model and API key');
  assert.equal(typeof result.tested_at, 'number');
});

test('testConfiguredModel sanitizes model test failures in result report', async () => {
  const result = await testConfiguredModel(
    {
      langchain_planner_model: 'failing-model',
      openai_api_key: 'sk-failing-secret9999',
      openai_base_url: 'https://model.example/v1',
    },
    {
      tester: {
        async invoke() {
          throw new Error('Authorization: Bearer sk-failing-secret9999 failed');
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.model, 'failing-model');
  assert.equal(result.output, null);
  assert.match(result.error ?? '', /\[REDACTED/);
  assert.equal(JSON.stringify(result).includes('sk-failing-secret9999'), false);
});
