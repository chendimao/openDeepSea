import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SkillsMpClient,
  getSkillsMpBearerTokenFromEnv,
  type SkillsMpFetch,
} from './client.js';

test('SkillsMpClient sends anonymous search requests to SkillsMP REST API', async () => {
  const calls: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
  const fetchImpl: SkillsMpFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('Authorization'),
      accept: headers.get('Accept'),
    });
    return new Response(JSON.stringify({
      success: true,
      data: {
        skills: [
          {
            id: 'anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
            name: 'frontend-design',
            author: 'anthropics',
            description: 'Frontend design skill.',
            githubUrl: 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design',
            skillUrl: 'https://skillsmp.com/skills/anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
            stars: 129828,
            updatedAt: '1762911111',
          },
        ],
        pagination: { page: 1, limit: 20, total: 1000, totalPages: 2 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SkillsMpClient({
    baseUrl: 'https://skillsmp.test',
    fetchImpl,
  });

  const result = await client.searchSkills({ q: 'frontend design', page: 1, limit: 20, sortBy: 'stars' });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    'https://skillsmp.test/api/v1/skills/search?q=frontend+design&page=1&limit=20&sortBy=stars',
  );
  assert.equal(calls[0]?.authorization, null);
  assert.equal(calls[0]?.accept, 'application/json');
  assert.equal(Array.isArray(result.data) ? false : result.data?.skills?.[0]?.name, 'frontend-design');
});

test('SkillsMpClient includes optional SkillsMP filters', async () => {
  let requestedUrl = '';
  const fetchImpl: SkillsMpFetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ success: true, data: { skills: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SkillsMpClient({
    baseUrl: 'https://skillsmp.test',
    fetchImpl,
  });

  await client.searchSkills({ q: 'browser', page: 2, limit: 5, sortBy: 'recent', category: 'dev', occupation: 'agent' });

  assert.equal(
    requestedUrl,
    'https://skillsmp.test/api/v1/skills/search?q=browser&page=2&limit=5&sortBy=recent&category=dev&occupation=agent',
  );
});

test('SkillsMpClient sends bearer token when token provider is configured', async () => {
  let authorization: string | null = null;
  const fetchImpl: SkillsMpFetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({ success: true, data: { skills: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SkillsMpClient({
    baseUrl: 'https://skillsmp.test',
    fetchImpl,
    tokenProvider: () => 'skillsmp-token',
  });

  await client.searchSkills({ q: 'browser', page: 1, limit: 5, sortBy: 'stars' });

  assert.equal(authorization, 'Bearer skillsmp-token');
});

test('SkillsMpClient maps upstream rate limits', async () => {
  const client = new SkillsMpClient({
    baseUrl: 'https://skillsmp.test',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
  });

  await assert.rejects(
    () => client.searchSkills({ q: 'browser', page: 1, limit: 30, sortBy: 'stars' }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'upstream_rate_limited');
      return true;
    },
  );
});

test('getSkillsMpBearerTokenFromEnv reads SkillsMP token env vars and trims values', () => {
  assert.equal(getSkillsMpBearerTokenFromEnv({ SKILLSMP_API_TOKEN: '  direct-token  ' }), 'direct-token');
  assert.equal(getSkillsMpBearerTokenFromEnv({ SKILLS_MP_API_TOKEN: '  legacy-token  ' }), 'legacy-token');
  assert.equal(getSkillsMpBearerTokenFromEnv({ SKILLSMP_API_TOKEN: '   ' }), null);
});
