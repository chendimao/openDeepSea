import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOnlineSkillsService, normalizeSkillsShSkill } from './service.js';
import type { SkillsShClientLike } from './types.js';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-online-skills-service-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.codex');

test('normalizeSkillsShSkill maps official fields and generates a restricted install command', () => {
  const skill = normalizeSkillsShSkill({
    id: 'vercel-labs/skills/find-skills',
    slug: 'find-skills',
    name: 'Find Skills',
    source: 'vercel-labs/skills',
    installs: 456,
    sourceType: 'github',
    installUrl: 'https://github.com/vercel-labs/skills',
    url: 'https://skills.sh/vercel-labs/skills/find-skills',
  }, []);

  assert.equal(skill.id, 'vercel-labs/skills/find-skills');
  assert.equal(skill.slug, 'find-skills');
  assert.equal(skill.displayName, 'Find Skills');
  assert.equal(skill.source, 'skills_sh');
  assert.equal(skill.upstreamSource, 'vercel-labs/skills');
  assert.equal(skill.sourceUrl, 'https://skills.sh/vercel-labs/skills/find-skills');
  assert.equal(skill.installUrl, 'https://github.com/vercel-labs/skills');
  assert.equal(skill.installCommand, 'npx skills add https://github.com/vercel-labs/skills --skill find-skills');
  assert.equal(skill.installs, 456);
  assert.deepEqual(skill.installedProviders, []);
});

test('online skills service overlays installed platform providers by slug', async () => {
  createPlatformSkill('codex', 'find-skills', 'Installed find-skills skill.');
  const service = createOnlineSkillsService({
    client: createClient({
      listSkills: async () => ({
        data: [
          {
            id: 'vercel-labs/skills/find-skills',
            slug: 'find-skills',
            name: 'Find Skills',
            source: 'vercel-labs/skills',
            installUrl: 'https://github.com/vercel-labs/skills',
            url: 'https://skills.sh/vercel-labs/skills/find-skills',
          },
        ],
        pagination: { page: 0, per_page: 30, total: 1, total_pages: 1 },
      }),
    }),
    now: () => 1_780_000_000_000,
  });

  const result = await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30 });

  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.skills[0]?.installedProviders, ['codex']);
  assert.equal(result.stale, false);
  assert.equal(result.updatedAt, 1_780_000_000_000);
});

test('online skills service returns stale cached list when upstream fails after a fresh load', async () => {
  let calls = 0;
  const service = createOnlineSkillsService({
    client: createClient({
      listSkills: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            data: [{ id: 'vercel-labs/skills/find-skills', slug: 'find-skills', installUrl: 'https://github.com/vercel-labs/skills' }],
            pagination: { page: 0, per_page: 30, total: 1, total_pages: 1 },
          };
        }
        throw new Error('upstream_unavailable');
      },
    }),
    now: () => 1_780_000_000_000,
  });

  await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30 });
  const stale = await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30, forceRefresh: true });

  assert.equal(stale.stale, true);
  assert.equal(stale.skills[0]?.slug, 'find-skills');
});

test('online skills service maps audit 404 to empty audit response', async () => {
  const service = createOnlineSkillsService({
    client: createClient({
      getSkillAudit: async () => {
        throw new Error('audit_not_found');
      },
    }),
    now: () => 1_780_000_000_000,
  });

  const result = await service.getOnlineSkillAudit('vercel-labs/skills/find-skills');

  assert.equal(result.id, 'vercel-labs/skills/find-skills');
  assert.equal(result.status, 'none');
  assert.equal(result.audit, null);
});

function createClient(overrides: Partial<SkillsShClientLike>): SkillsShClientLike {
  return {
    listSkills: async () => ({ data: [], pagination: { page: 0, per_page: 30, total: 0, total_pages: 0 } }),
    searchSkills: async () => ({ data: [], pagination: { page: 0, per_page: 30, total: 0, total_pages: 0 } }),
    getSkill: async () => ({}),
    getSkillAudit: async () => ({}),
    ...overrides,
  };
}

function createPlatformSkill(provider: 'codex' | 'claudecode' | 'opencode', name: string, description: string): void {
  const root = provider === 'codex'
    ? join(process.env.CODEX_HOME!, 'skills')
    : provider === 'claudecode'
      ? join(testHome, '.claude', 'skills')
      : join(testHome, '.config', 'opencode', 'skills');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
}
