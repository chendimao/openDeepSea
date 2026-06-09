import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SkillsShClient,
  getSkillsShBearerTokenFromEnv,
  type SkillsShFetch,
} from './client.js';

test('getSkillsShBearerTokenFromEnv prefers explicit skills token and trims values', () => {
  const env = {
    SKILLS_SH_API_TOKEN: '  explicit-token  ',
    VERCEL_OIDC_TOKEN: 'oidc-token',
  };

  assert.equal(getSkillsShBearerTokenFromEnv(env), 'explicit-token');
});

test('getSkillsShBearerTokenFromEnv ignores VERCEL_OIDC_TOKEN because OIDC is runtime scoped', () => {
  const env = {
    VERCEL_OIDC_TOKEN: '  oidc-token  ',
  };

  assert.equal(getSkillsShBearerTokenFromEnv(env), null);
});

test('SkillsShClient sends bearer token and uses official leaderboard parameters', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: SkillsShFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('Authorization'),
    });
    return new Response(JSON.stringify({
      data: [
        {
          id: 'vercel-labs/skills/find-skills',
          slug: 'find-skills',
          name: 'Find Skills',
          source: 'vercel-labs/skills',
          installUrl: 'https://github.com/vercel-labs/skills',
          url: 'https://skills.sh/vercel-labs/skills/find-skills',
          installs: 456,
        },
      ],
      pagination: {
        page: 0,
        per_page: 20,
        total: 1,
        total_pages: 1,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl,
    tokenProvider: () => 'secret-token',
  });

  const result = await client.listSkills({ view: 'trending', page: 0, limit: 20 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://skills.test/api/v1/skills?view=trending&page=0&per_page=20');
  assert.equal(calls[0]?.authorization, 'Bearer secret-token');
  assert.equal(Array.isArray(result.data), true);
  const skills = result.data as Array<{ id?: string }>;
  assert.equal(skills[0]?.id, 'vercel-labs/skills/find-skills');
});

test('SkillsShClient sends official search parameters', async () => {
  let requestedUrl = '';
  const fetchImpl: SkillsShFetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ data: [], pagination: { page: 0, per_page: 5, total: 0, total_pages: 0 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl,
    tokenProvider: () => 'secret-token',
  });

  await client.searchSkills({ q: 'react native', limit: 5 });

  assert.equal(requestedUrl, 'https://skills.test/api/v1/skills/search?q=react+native&limit=5');
});

test('SkillsShClient maps missing token to token_missing without calling fetch', async () => {
  let called = false;
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
    tokenProvider: () => null,
  });

  await assert.rejects(
    () => client.searchSkills({ q: 'browser', limit: 30 }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'token_missing');
      return true;
    },
  );
  assert.equal(called, false);
});

test('SkillsShClient maps audit 404 to audit_not_found', async () => {
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
    tokenProvider: () => 'secret-token',
  });

  await assert.rejects(
    () => client.getSkillAudit('vercel-labs/skills/find-skills'),
    (error: unknown) => {
      assert.equal((error as Error).message, 'audit_not_found');
      return true;
    },
  );
});
