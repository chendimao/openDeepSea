import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SkillRuntimeScope, SkillTriggerMode } from './types.js';

const VALID_RUNTIME_SCOPES: SkillRuntimeScope[] = ['planner', 'model_chat', 'workflow', 'memory', 'review'];

export interface LoadedSkill {
  name: string;
  description: string | null;
  runtimeScopes: SkillRuntimeScope[];
  triggerMode: SkillTriggerMode;
  triggerKeywords: string[];
  priority: number;
  manifestPath: string;
  instructions: string;
  truncated: boolean;
}

export interface LoadSkillOptions {
  maxInstructionChars?: number;
}

interface ParsedFrontmatter {
  values: Record<string, string>;
  arrays: Record<string, string[]>;
  body: string;
}

export async function loadSkillFromDirectory(dir: string, options: LoadSkillOptions = {}): Promise<LoadedSkill> {
  const manifestPath = 'SKILL.md';
  const raw = await readFile(join(dir, manifestPath), 'utf-8');
  const parsed = parseFrontmatter(raw);
  const triggerKeywords = parsed.arrays['trigger_keywords'] ?? parseInlineArray(parsed.values['trigger_keywords']);
  const runtimeScopes = (parsed.arrays['runtime_scopes'] ?? parseInlineArray(parsed.values['runtime_scopes']))
    .filter(isSkillRuntimeScope);
  const body = parsed.body.trim();
  const maxInstructionChars = Math.max(0, options.maxInstructionChars ?? 4000);
  const instructions = body.slice(0, maxInstructionChars);

  return {
    name: normalizedString(parsed.values['name']) ?? basename(dir),
    description: normalizedString(parsed.values['description']) ?? fallbackDescription(body),
    runtimeScopes,
    triggerMode: normalizeTriggerMode(parsed.values['trigger_mode'], triggerKeywords),
    triggerKeywords,
    priority: normalizePriority(parsed.values['priority']),
    manifestPath,
    instructions,
    truncated: body.length > instructions.length,
  };
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith('---\n')) {
    return { values: {}, arrays: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { values: {}, arrays: {}, body: raw };
  const header = raw.slice(4, end).split('\n');
  const body = raw.slice(end + '\n---'.length).replace(/^\n/, '');
  const values: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};
  let currentArrayKey: string | null = null;

  for (const rawLine of header) {
    const line = rawLine.trimEnd();
    const arrayItem = line.match(/^\s*-\s+(.+)$/);
    if (arrayItem && currentArrayKey) {
      arrays[currentArrayKey] = [...(arrays[currentArrayKey] ?? []), stripQuotes(arrayItem[1]!.trim())];
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      currentArrayKey = null;
      continue;
    }
    const key = pair[1]!;
    const value = pair[2]!.trim();
    if (!value) {
      arrays[key] = [];
      currentArrayKey = key;
    } else {
      values[key] = stripQuotes(value);
      currentArrayKey = null;
    }
  }

  return { values, arrays, body };
}

function parseInlineArray(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [stripQuotes(trimmed)];
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function normalizedString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function fallbackDescription(body: string): string | null {
  const first = body.split('\n').map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  return first.replace(/^#+\s*/, '').trim() || null;
}

function normalizeTriggerMode(value: string | undefined, triggerKeywords: string[]): SkillTriggerMode {
  if (value === 'manual' || value === 'keyword' || value === 'always_for_scope') return value;
  return triggerKeywords.length > 0 ? 'keyword' : 'manual';
}

function normalizePriority(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 100;
}

function isSkillRuntimeScope(value: string): value is SkillRuntimeScope {
  return VALID_RUNTIME_SCOPES.includes(value as SkillRuntimeScope);
}
