import type { TaskActionKind } from '../types.js';

export type SuperpowersRoutingNextAction =
  | 'brainstorming'
  | 'writing_plans'
  | 'subagent_execution'
  | 'systematic_debugging'
  | 'verification'
  | 'finish_branch'
  | 'blocked';

export interface SuperpowersRouting {
  next_action: SuperpowersRoutingNextAction;
  required_skill: string;
  reason: string;
  recommended_agent_id: string;
  expected_evidence: string[];
  planning_required?: boolean;
  skip_planning_reason?: string;
}

export type SuperpowersRoutingParseResult =
  | { ok: true; routing: SuperpowersRouting }
  | { ok: false; error: string };

const NEXT_ACTIONS = new Set<SuperpowersRoutingNextAction>([
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
  'blocked',
]);

export function parseSuperpowersRouting(content: string): SuperpowersRoutingParseResult {
  const jsonBlocks = content.matchAll(/```json\s*([\s\S]*?)```/gu);
  const errors: string[] = [];

  for (const match of jsonBlocks) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as unknown;
      const routing = isRecord(parsed) ? parsed.superpowers_routing : null;
      const validation = validateSuperpowersRouting(routing);
      if (validation.ok) return validation;
      errors.push(validation.error);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'routing JSON 解析失败');
    }
  }

  return { ok: false, error: errors[0] ?? '缺少 superpowers_routing JSON 代码块' };
}

export function routingActionToTaskAction(action: SuperpowersRoutingNextAction): TaskActionKind | null {
  if (action === 'blocked') return null;
  return action;
}

function validateSuperpowersRouting(value: unknown): SuperpowersRoutingParseResult {
  if (!isRecord(value)) return { ok: false, error: 'superpowers_routing 必须是对象' };

  const requiredKeys = ['next_action', 'required_skill', 'reason', 'recommended_agent_id', 'expected_evidence'];
  const missing = requiredKeys.filter((key) => !(key in value));
  if (missing.length > 0) {
    return { ok: false, error: `superpowers_routing 缺少字段：${missing.join(', ')}` };
  }

  if (!isNonEmptyString(value.next_action) || !NEXT_ACTIONS.has(value.next_action as SuperpowersRoutingNextAction)) {
    return { ok: false, error: 'superpowers_routing.next_action 非法' };
  }
  if (!isNonEmptyString(value.required_skill)) {
    return { ok: false, error: 'superpowers_routing.required_skill 必须是非空字符串' };
  }
  if (!isNonEmptyString(value.reason)) {
    return { ok: false, error: 'superpowers_routing.reason 必须是非空字符串' };
  }
  if (!isNonEmptyString(value.recommended_agent_id)) {
    return { ok: false, error: 'superpowers_routing.recommended_agent_id 必须是非空字符串' };
  }
  if (!Array.isArray(value.expected_evidence) || !value.expected_evidence.every(isNonEmptyString)) {
    return { ok: false, error: 'superpowers_routing.expected_evidence 必须是非空字符串数组' };
  }

  return {
    ok: true,
    routing: {
      next_action: value.next_action as SuperpowersRoutingNextAction,
      required_skill: value.required_skill,
      reason: value.reason,
      recommended_agent_id: value.recommended_agent_id,
      expected_evidence: value.expected_evidence,
      planning_required: typeof value.planning_required === 'boolean' ? value.planning_required : undefined,
      skip_planning_reason: isNonEmptyString(value.skip_planning_reason) ? value.skip_planning_reason : undefined,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
