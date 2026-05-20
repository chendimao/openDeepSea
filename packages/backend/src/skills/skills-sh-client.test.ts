import assert from 'node:assert/strict';
import test from 'node:test';

const { SkillsShClient } = await import('./skills-sh-client.js');

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

test('SkillsShClient parses public skills.sh search results', async () => {
  const requestedUrls: string[] = [];
  const client = new SkillsShClient({
    fetch: async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return jsonResponse({
        query: 'react',
        searchType: 'fuzzy',
        skills: [
          {
            id: 'vercel-labs/agent-skills/vercel-react-best-practices',
            skillId: 'vercel-react-best-practices',
            name: 'vercel-react-best-practices',
            installs: 411423,
            source: 'vercel-labs/agent-skills',
          },
        ],
      });
    },
  });

  const results = await client.search('react');

  assert.equal(new URL(requestedUrls[0]!).origin, 'https://skills.sh');
  assert.equal(new URL(requestedUrls[0]!).pathname, '/api/search');
  assert.equal(new URL(requestedUrls[0]!).searchParams.get('q'), 'react');
  assert.equal(new URL(requestedUrls[0]!).searchParams.get('limit'), '10');
  assert.deepEqual(results, [
    {
      id: 'vercel-labs/agent-skills/vercel-react-best-practices',
      name: 'vercel-react-best-practices',
      skillId: 'vercel-react-best-practices',
      source: 'vercel-labs/agent-skills',
      installLabel: 'vercel-labs/agent-skills/vercel-react-best-practices',
      description: null,
      installs: 411423,
      version: null,
      revision: null,
    },
  ]);
});

test('SkillsShClient fetches packages from the public skills.sh download endpoint', async () => {
  const requestedUrls: string[] = [];
  const client = new SkillsShClient({
    fetch: async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return jsonResponse({
        hash: 'snapshot-a',
        files: {
          'SKILL.md': '# React Best Practices\n',
        },
      });
    },
  });

  const pkg = await client.fetchPackage('vercel-labs/agent-skills/vercel-react-best-practices');

  assert.equal(new URL(requestedUrls[0]!).origin, 'https://skills.sh');
  assert.equal(new URL(requestedUrls[0]!).pathname, '/api/download/vercel-labs/agent-skills/vercel-react-best-practices');
  assert.equal(pkg.installLabel, 'vercel-labs/agent-skills/vercel-react-best-practices');
  assert.equal(pkg.source, 'vercel-labs/agent-skills');
  assert.equal(pkg.skillId, 'vercel-react-best-practices');
  assert.equal(pkg.revision, 'snapshot-a');
});


test('SkillsShClient accepts the public download files contents field', async () => {
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      hash: 'snapshot-contents',
      files: [
        { path: 'SKILL.md', contents: '# Contents Field\n' },
      ],
    }),
  });

  const pkg = await client.fetchPackage('vercel-labs/agent-skills/contents-field');

  assert.equal(pkg.revision, 'snapshot-contents');
  assert.deepEqual(pkg.files, [
    { path: 'SKILL.md', content: '# Contents Field\n' },
  ]);
});

test('SkillsShClient normalizes conservative supported result shapes', async () => {
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      data: {
        results: [
          {
            id: 'owner/repo/plain-skill',
            skill_id: 'plain-skill',
            title: 'Plain Skill',
            repository: 'owner/repo',
            summary: 'Prompt-only skill.',
            package_version: '1.0.0',
            package_revision: 'rev-a',
          },
        ],
      },
    }),
  });

  const results = await client.search('plain');

  assert.deepEqual(results, [
    {
      id: 'owner/repo/plain-skill',
      name: 'Plain Skill',
      skillId: 'plain-skill',
      source: 'owner/repo',
      installLabel: 'owner/repo/plain-skill',
      description: 'Prompt-only skill.',
      installs: null,
      version: '1.0.0',
      revision: 'rev-a',
    },
  ]);
});


test('SkillsShClient rejects install labels with dot segments', async () => {
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({ files: { 'SKILL.md': '# Should not fetch\n' } }),
  });

  await assert.rejects(
    () => client.fetchPackage('../search'),
    /dot segments/i,
  );
});

test('SkillsShClient only allows the public skills.sh source', () => {
  assert.throws(
    () => new SkillsShClient({ baseUrl: 'https://registry.example.test' }),
    /only public skills\.sh/i,
  );
});
