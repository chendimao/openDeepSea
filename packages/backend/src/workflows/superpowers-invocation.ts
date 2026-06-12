import { parseSuperpowersEvidence } from './graph/superpowers-evidence.js';
import type { SuperpowersStageController } from './superpowers-stage-registry.js';

interface BuildInvocationPromptInput {
  stageId: string;
  controller: SuperpowersStageController;
  requiredSkills: string[];
  roleInstruction: string;
  context: string;
  expectedEvidence: string[];
}

export function buildSuperpowersInvocationPrompt(input: BuildInvocationPromptInput): string {
  return [
    `当前 Superpowers 阶段：${input.stageId}`,
    `执行权限：${input.controller}`,
    input.roleInstruction,
    '',
    input.controller !== 'planner'
      ? '你不是 planner。不要重新设计 workflow，不要修改 approved spec/plan，只执行分配给你的阶段或任务。'
      : '你是 planner controller。你负责流程控制、artifact 修订、用户确认和子代理分配。',
    '',
    '必须遵循以下 Superpowers skills：',
    ...input.requiredSkills.map((skill) => `- ${skill}`),
    '',
    '阶段上下文：',
    input.context,
    '',
    '阶段完成时必须输出 fenced JSON evidence，至少包含：',
    ...input.expectedEvidence.map((item) => `- ${item}`),
  ].join('\n');
}

export function parseRequiredSuperpowersEvidence(
  output: string,
  requiredFields: string[],
): { ok: true; evidence: Record<string, unknown> } | { ok: false; error: string } {
  const evidence = parseSuperpowersEvidence(output) as Record<string, unknown>;
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(evidence, field));
  if (missing.length > 0) return { ok: false, error: `missing required evidence: ${missing.join(', ')}` };
  return { ok: true, evidence };
}
