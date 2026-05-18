import assert from 'node:assert/strict';
import test from 'node:test';
import type { SelectedSkill } from './selector.js';

const { formatSkillPrompt } = await import('./prompt.js');

test('formatSkillPrompt returns empty string when no skills are selected', () => {
  assert.equal(formatSkillPrompt([]), '');
});

test('formatSkillPrompt renders stable active skill context', () => {
  const prompt = formatSkillPrompt([
    {
      skill: {
        id: 'skill-tdd',
        name: 'test-driven-development',
        description: 'Use when changing behavior.',
        source_type: 'manual',
        source_uri: null,
        install_path: '/managed/tdd',
        manifest_path: 'SKILL.md',
        runtime_scopes: ['planner'],
        trigger_mode: 'keyword',
        trigger_keywords: ['TDD'],
        enabled: 1,
        priority: 80,
        checksum: null,
        created_at: 1,
        updated_at: 1,
      },
      effectivePriority: 80,
      reasons: ['keyword match "TDD"'],
      instructions: 'Write the failing test first.',
      truncated: false,
    } satisfies SelectedSkill,
  ]);

  assert.match(prompt, /OpenDeepSea active skills for this runtime/);
  assert.match(prompt, /Skill: test-driven-development/);
  assert.match(prompt, /Reason: keyword match "TDD"/);
  assert.match(prompt, /Priority: 80/);
  assert.match(prompt, /Write the failing test first/);
});
