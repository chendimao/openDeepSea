import { runSkillInProjectSandbox, type RunSkillInput } from './runtime.js';
import type { SkillRun } from './types.js';

export async function invokeSkill(input: RunSkillInput): Promise<SkillRun> {
  return runSkillInProjectSandbox(input);
}
