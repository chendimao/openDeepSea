import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.HOME = mkdtempSync(join(tmpdir(), 'opendeepsea-online-skills-routes-home-'));
process.env.CODEX_HOME = join(process.env.HOME, '.codex');
process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-online-skills-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'online-skills-routes-token';

const { createOnlineSkillsRouter } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/online-skills', createOnlineSkillsRouter({
  listOnlineSkills: async (input) => ({
    skills: [{
      id: 'openclaw-openclaw-skills-skill-creator-skill-md',
      slug: 'skill-creator',
      name: 'skill-creator',
      displayName: 'skill-creator',
      description: 'Create and edit skills.',
      source: 'skillsmp',
      upstreamSource: 'https://github.com/openclaw/openclaw/tree/main/skills/skill-creator',
      sourceType: 'github',
      sourceUrl: 'https://skillsmp.com/skills/openclaw-openclaw-skills-skill-creator-skill-md',
      installUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/skill-creator',
      installCommand: 'npx --yes skills add https://github.com/openclaw/openclaw/tree/main/skills/skill-creator --skill skill-creator',
      tags: [],
      author: 'openclaw',
      stars: 376558,
      installs: null,
      updatedAt: 1_780_166_575_000,
      auditStatus: 'none',
      installedProviders: [],
      isDuplicate: false,
    }],
    total: 1,
    page: input.page,
    pages: 1,
    limit: input.limit,
    stale: false,
    updatedAt: 1,
  }),
  searchOnlineSkills: async (input) => ({
    skills: [],
    total: 0,
    page: input.page ?? 0,
    pages: 0,
    limit: input.limit,
    stale: false,
    updatedAt: 1,
  }),
  getOnlineSkill: async () => ({
    skill: {
      id: 'openclaw-openclaw-skills-skill-creator-skill-md',
      slug: 'skill-creator',
      name: 'skill-creator',
      displayName: 'skill-creator',
      description: 'Create and edit skills.',
      source: 'skillsmp',
      upstreamSource: 'https://github.com/openclaw/openclaw/tree/main/skills/skill-creator',
      sourceType: 'github',
      sourceUrl: 'https://skillsmp.com/skills/openclaw-openclaw-skills-skill-creator-skill-md',
      installUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/skill-creator',
      installCommand: 'npx --yes skills add https://github.com/openclaw/openclaw/tree/main/skills/skill-creator --skill skill-creator',
      tags: [],
      author: 'openclaw',
      stars: 376558,
      installs: null,
      updatedAt: 1_780_166_575_000,
      auditStatus: 'none',
      installedProviders: [],
      isDuplicate: false,
    },
    stale: false,
    updatedAt: 1,
  }),
  getOnlineSkillAudit: async (id) => ({
    id,
    status: 'none',
    audit: null,
    stale: false,
    updatedAt: 1,
  }),
}));

async function request(path: string, init: RequestInit = {}, options: { localToken?: boolean } = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (options.localToken !== false) {
      headers.set('X-OpenDeepSea-Local-Token', process.env.OPENDEEPSEA_LOCAL_TOKEN!);
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('online skills routes require local access token', async () => {
  const res = await request('/api/online-skills', {}, { localToken: false });
  assert.equal(res.status, 403);
});

test('online skills routes do not expose token configuration endpoints', async () => {
  const res = await request('/api/online-skills/config');
  assert.equal(res.status, 404);
});

test('online skills routes list online SkillsMP skills with validated defaults', async () => {
  const res = await request('/api/online-skills?view=trending&limit=20');
  assert.equal(res.status, 200);
  const body = await res.json() as { skills: Array<{ id: string; source: string; installCommand: string }>; page: number; limit: number };
  assert.equal(body.page, 0);
  assert.equal(body.limit, 20);
  assert.equal(body.skills[0]?.id, 'openclaw-openclaw-skills-skill-creator-skill-md');
  assert.equal(body.skills[0]?.source, 'skillsmp');
  assert.equal(body.skills[0]?.installCommand, 'npx --yes skills add https://github.com/openclaw/openclaw/tree/main/skills/skill-creator --skill skill-creator');
});

test('online skills routes search with query and get audit by encoded id', async () => {
  const searchRes = await request('/api/online-skills/search?q=browser&limit=10');
  assert.equal(searchRes.status, 200);

  const auditRes = await request('/api/online-skills/openclaw-openclaw-skills-skill-creator-skill-md/audit');
  assert.equal(auditRes.status, 200);
  const audit = await auditRes.json() as { id: string; status: string };
  assert.equal(audit.id, 'openclaw-openclaw-skills-skill-creator-skill-md');
  assert.equal(audit.status, 'none');
});

test('online skills routes map SkillsMP rate limits', async () => {
  const errorApp = express();
  errorApp.use('/api/online-skills', createOnlineSkillsRouter({
    listOnlineSkills: async () => {
      throw new Error('upstream_rate_limited');
    },
    searchOnlineSkills: async () => {
      throw new Error('upstream_rate_limited');
    },
    getOnlineSkill: async () => {
      throw new Error('upstream_rate_limited');
    },
    getOnlineSkillAudit: async () => {
      throw new Error('upstream_rate_limited');
    },
  }));
  const server = errorApp.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/online-skills`, {
      headers: { 'X-OpenDeepSea-Local-Token': process.env.OPENDEEPSEA_LOCAL_TOKEN! },
    });
    assert.equal(res.status, 429);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'SkillsMP API rate limit exceeded');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('online skills routes hide generic upstream error codes from users', async () => {
  const errorApp = express();
  errorApp.use('/api/online-skills', createOnlineSkillsRouter({
    listOnlineSkills: async () => {
      throw new Error('upstream_unavailable');
    },
    searchOnlineSkills: async () => {
      throw new Error('upstream_unavailable');
    },
    getOnlineSkill: async () => {
      throw new Error('upstream_unavailable');
    },
    getOnlineSkillAudit: async () => {
      throw new Error('upstream_unavailable');
    },
  }));
  const server = errorApp.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/online-skills`, {
      headers: { 'X-OpenDeepSea-Local-Token': process.env.OPENDEEPSEA_LOCAL_TOKEN! },
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'SkillsMP API request failed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
