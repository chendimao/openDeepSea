import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOnlineSkillsService, normalizeSkillsMpSkill } from './service.js';
import type { SkillsMpClientLike, SkillsMpSearchResponse } from './types.js';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-online-skills-service-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.codex');

test('normalizeSkillsMpSkill maps SkillsMP fields and generates a restricted install command', () => {
  const skill = normalizeSkillsMpSkill({
    id: 'anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
    name: 'frontend-design',
    author: 'anthropics',
    description: 'Frontend design skill.',
    githubUrl: 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design',
    skillUrl: 'https://skillsmp.com/skills/anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
    stars: 129828,
    updatedAt: '1762911111',
  }, []);

  assert.equal(skill.id, 'anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md');
  assert.equal(skill.slug, 'frontend-design');
  assert.equal(skill.displayName, 'frontend-design');
  assert.equal(skill.source, 'skillsmp');
  assert.equal(skill.upstreamSource, 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design');
  assert.equal(skill.sourceType, 'github');
  assert.equal(skill.sourceUrl, 'https://skillsmp.com/skills/anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md');
  assert.equal(skill.installUrl, 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design');
  assert.equal(
    skill.installCommand,
    'npx --yes skills add https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design --skill frontend-design',
  );
  assert.equal(skill.stars, 129828);
  assert.equal(skill.installs, null);
  assert.equal(skill.updatedAt, 1_762_911_111_000);
  assert.deepEqual(skill.installedProviders, []);
});

test('online skills service searches SkillsMP by default and overlays installed platform providers by slug', async () => {
  createPlatformSkill('codex', 'frontend-design', 'Installed frontend-design skill.');
  const calls: Array<{ q: string; page: number; limit: number; sortBy?: string }> = [];
  const service = createOnlineSkillsService({
    client: createClient({
      searchSkills: async (input) => {
        calls.push(input);
        return createSearchResponse({
          skills: [
            {
              id: 'anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
              name: 'frontend-design',
              author: 'anthropics',
              githubUrl: 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design',
              skillUrl: 'https://skillsmp.com/skills/anthropics-claude-code-plugins-frontend-design-skills-frontend-design-skill-md',
            },
          ],
          page: 1,
          limit: 30,
          total: 1000,
          totalPages: 2,
        });
      },
    }),
    now: () => 1_780_000_000_000,
  });

  const result = await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30 });

  assert.deepEqual(calls, [{ q: 'skill', page: 1, limit: 30, sortBy: 'stars' }]);
  assert.equal(result.page, 0);
  assert.equal(result.limit, 30);
  assert.equal(result.total, 1000);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.skills[0]?.installedProviders, ['codex']);
  assert.equal(result.stale, false);
  assert.equal(result.updatedAt, 1_780_000_000_000);
});

test('online skills service maps trending view to recent SkillsMP sorting', async () => {
  let sortBy: string | undefined;
  const service = createOnlineSkillsService({
    client: createClient({
      searchSkills: async (input) => {
        sortBy = input.sortBy;
        return createSearchResponse({ skills: [], page: 1, limit: 10, total: 0, totalPages: 0 });
      },
    }),
  });

  await service.listOnlineSkills({ view: 'trending', page: 0, limit: 10 });

  assert.equal(sortBy, 'recent');
});

test('online skills service returns stale cached list when upstream fails after a fresh load', async () => {
  let calls = 0;
  const service = createOnlineSkillsService({
    client: createClient({
      searchSkills: async () => {
        calls += 1;
        if (calls === 1) {
          return createSearchResponse({
            skills: [{ id: 'openclaw-openclaw-skills-skill-creator-skill-md', name: 'skill-creator', githubUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/skill-creator' }],
            page: 1,
            limit: 30,
            total: 1,
            totalPages: 1,
          });
        }
        throw new Error('upstream_unavailable');
      },
    }),
    now: () => 1_780_000_000_000,
  });

  await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30 });
  const stale = await service.listOnlineSkills({ view: 'all-time', page: 0, limit: 30, forceRefresh: true });

  assert.equal(stale.stale, true);
  assert.equal(stale.skills[0]?.slug, 'skill-creator');
});

test('online skills service rejects detail search results without an exact SkillsMP id match', async () => {
  const service = createOnlineSkillsService({
    client: createClient({
      searchSkills: async () => createSearchResponse({
        skills: [{
          id: 'different-id',
          name: 'different-skill',
          githubUrl: 'https://github.com/example/repo/tree/main/skills/different-skill',
        }],
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
      }),
    }),
  });

  await assert.rejects(
    () => service.getOnlineSkill('missing-id'),
    (error: unknown) => {
      assert.equal((error as Error).message, 'skill_not_found');
      return true;
    },
  );
});

test('online skills service exposes no SkillsMP audit data', async () => {
  const service = createOnlineSkillsService({
    client: createClient({}),
    now: () => 1_780_000_000_000,
  });

  const result = await service.getOnlineSkillAudit('openclaw-openclaw-skills-skill-creator-skill-md');

  assert.equal(result.id, 'openclaw-openclaw-skills-skill-creator-skill-md');
  assert.equal(result.status, 'none');
  assert.equal(result.audit, null);
  assert.equal(result.stale, false);
});

function createClient(overrides: Partial<SkillsMpClientLike>): SkillsMpClientLike {
  return {
    searchSkills: async () => createSearchResponse({ skills: [], page: 1, limit: 30, total: 0, totalPages: 0 }),
    ...overrides,
  };
}

function createSearchResponse(input: {
  skills: NonNullable<SkillsMpSearchResponse['skills']>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}): SkillsMpSearchResponse {
  return {
    success: true,
    data: {
      skills: input.skills,
      pagination: {
        page: input.page,
        limit: input.limit,
        total: input.total,
        totalPages: input.totalPages,
      },
    },
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
