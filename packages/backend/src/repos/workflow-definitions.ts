import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { projectRepo } from './projects.js';
import { roomRepo } from './rooms.js';
import type {
  WorkflowDefinition,
  WorkflowDefinitionGraph,
  WorkflowDefinitionNodeType,
  WorkflowDefinitionScope,
  WorkflowDefinitionStatus,
} from '../types.js';

const BUILTIN_SUPERPOWERS_KEY = 'superpowers-development';

const ALLOWED_NODE_TYPES = new Set<WorkflowDefinitionNodeType>([
  'context',
  'planning',
  'brainstorming',
  'spec_review',
  'worktree',
  'writing_plans',
  'plan_review',
  'approval_gate',
  'dispatch',
  'execute',
  'tdd_execute',
  'review',
  'spec_compliance_review',
  'code_quality_review',
  'repair_decision',
  'verify',
  'finish_branch',
  'acceptance',
  'memory',
]);

const SUPERPOWERS_DEFINITION: WorkflowDefinitionGraph = {
  metadata: {
    runtime_profile: 'superpowers',
    required_skill_names: [
      'using-superpowers',
      'brainstorming',
      'using-git-worktrees',
      'writing-plans',
      'test-driven-development',
      'subagent-driven-development',
      'requesting-code-review',
      'verification-before-completion',
      'finishing-a-development-branch',
    ],
    gate_policy: 'superpowers-development',
  },
  nodes: [
    { id: 'context', type: 'context', label: '上下文', stage: 'analysis', position: { x: 0, y: 80 } },
    {
      id: 'brainstorming',
      type: 'brainstorming',
      label: '需求澄清',
      stage: 'analysis',
      role: 'analyst',
      position: { x: 220, y: 80 },
      metadata: {
        required_skill_names: ['using-superpowers', 'brainstorming'],
        gate_policy: 'produce_design_doc',
      },
    },
    {
      id: 'spec_review',
      type: 'spec_review',
      label: '规格自审',
      stage: 'analysis',
      role: 'reviewer',
      position: { x: 440, y: 80 },
      metadata: {
        gate_policy: 'inline_self_review',
      },
    },
    {
      id: 'worktree',
      type: 'worktree',
      label: '工作区隔离',
      stage: 'planning',
      role: 'coordinator',
      position: { x: 660, y: 80 },
      metadata: {
        required_skill_names: ['using-git-worktrees'],
        gate_policy: 'record_isolation_decision',
      },
    },
    {
      id: 'writing_plans',
      type: 'writing_plans',
      label: '计划编写',
      stage: 'planning',
      role: 'planner',
      position: { x: 880, y: 80 },
      metadata: {
        required_skill_names: ['writing-plans'],
        gate_policy: 'produce_executable_plan',
      },
    },
    {
      id: 'plan_review',
      type: 'plan_review',
      label: '计划自审',
      stage: 'planning',
      role: 'reviewer',
      position: { x: 1100, y: 80 },
      metadata: {
        gate_policy: 'inline_self_review',
      },
    },
    { id: 'approval', type: 'approval_gate', label: '审批', stage: 'planning', position: { x: 1320, y: 80 } },
    { id: 'dispatch', type: 'dispatch', label: '派发', stage: 'assignment', role: 'coordinator', position: { x: 1540, y: 80 } },
    {
      id: 'tdd_execute',
      type: 'tdd_execute',
      label: 'TDD 执行',
      stage: 'implementation',
      role: 'executor',
      position: { x: 1760, y: 80 },
      metadata: {
        required_skill_names: ['test-driven-development', 'subagent-driven-development'],
        gate_policy: 'record_red_green_refactor',
      },
    },
    {
      id: 'spec_compliance_review',
      type: 'spec_compliance_review',
      label: '规格符合审查',
      stage: 'code_review',
      role: 'reviewer',
      position: { x: 1980, y: 80 },
      metadata: {
        required_skill_names: ['requesting-code-review'],
        gate_policy: 'block_spec_mismatch',
      },
    },
    {
      id: 'code_quality_review',
      type: 'code_quality_review',
      label: '代码质量审查',
      stage: 'code_review',
      role: 'reviewer',
      position: { x: 2200, y: 80 },
      metadata: {
        required_skill_names: ['requesting-code-review'],
        gate_policy: 'block_critical_or_important_findings',
      },
    },
    {
      id: 'verify',
      type: 'verify',
      label: '验证',
      stage: 'code_review',
      position: { x: 2420, y: 80 },
      metadata: {
        required_skill_names: ['verification-before-completion'],
        gate_policy: 'fresh_verification_evidence',
      },
    },
    {
      id: 'finish_branch',
      type: 'finish_branch',
      label: '分支收口',
      stage: 'acceptance',
      role: 'coordinator',
      position: { x: 2640, y: 80 },
      metadata: {
        required_skill_names: ['finishing-a-development-branch'],
        gate_policy: 'record_closeout_choice',
      },
    },
    { id: 'acceptance', type: 'acceptance', label: '验收', stage: 'acceptance', role: 'acceptor', position: { x: 2860, y: 80 } },
    { id: 'memory', type: 'memory', label: '记忆', stage: 'acceptance', position: { x: 3080, y: 80 } },
  ],
  edges: [
    { from: 'context', to: 'brainstorming' },
    { from: 'brainstorming', to: 'spec_review' },
    { from: 'spec_review', to: 'worktree' },
    { from: 'worktree', to: 'writing_plans' },
    { from: 'writing_plans', to: 'plan_review' },
    { from: 'plan_review', to: 'approval' },
    { from: 'approval', to: 'dispatch', condition: 'approved' },
    { from: 'dispatch', to: 'tdd_execute' },
    { from: 'tdd_execute', to: 'spec_compliance_review' },
    { from: 'spec_compliance_review', to: 'code_quality_review' },
    { from: 'code_quality_review', to: 'verify' },
    { from: 'verify', to: 'finish_branch' },
    { from: 'finish_branch', to: 'acceptance' },
    { from: 'acceptance', to: 'memory', condition: 'completed' },
  ],
};

type WorkflowDefinitionRow = Omit<WorkflowDefinition, 'definition'>;
type WorkflowDefinitionListFilters = {
  scope?: WorkflowDefinitionScope;
  status?: WorkflowDefinitionStatus;
  projectId?: string;
  roomId?: string;
  includeArchived?: boolean;
};

function normalize(row: WorkflowDefinitionRow): WorkflowDefinition {
  const parsed = JSON.parse(row.definition_json) as WorkflowDefinitionGraph;
  return {
    ...row,
    definition: workflowDefinitionRepo.validateDefinition(parsed),
  };
}

function ensureBuiltInDefinition(
  key: string,
  name: string,
  description: string,
  definition: WorkflowDefinitionGraph,
): WorkflowDefinition {
  const definitionJson = JSON.stringify(definition);
  const existing = db
    .prepare('SELECT * FROM workflow_definitions WHERE builtin_key = ?')
    .get(key) as WorkflowDefinitionRow | undefined;

  if (existing) {
    if (existing.name !== name || existing.description !== description || existing.definition_json !== definitionJson) {
      db.prepare(
        `UPDATE workflow_definitions
         SET name = ?, description = ?, definition_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(name, description, definitionJson, now(), existing.id);
      return workflowDefinitionRepo.get(existing.id)!;
    }
    return normalize(existing);
  }

  const id = nanoid(14);
  const ts = now();
  db.prepare(
    `INSERT INTO workflow_definitions (
      id, name, description, scope, scope_id, version, status, builtin_key, definition_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'system', 'default', 1, 'published', ?, ?, ?, ?)`,
  ).run(id, name, description, key, definitionJson, ts, ts);
  return workflowDefinitionRepo.get(id)!;
}

export const workflowDefinitionRepo = {
  ensureBuiltInDefinitions(): WorkflowDefinition {
    return ensureBuiltInDefinition(
      BUILTIN_SUPERPOWERS_KEY,
      'Superpowers 开发闭环',
      '内置 Superpowers 开发闭环：需求澄清、规格自审、工作区隔离、计划、审批、派发、TDD 执行、审查、验证、分支收口、验收和记忆。',
      this.validateDefinition(SUPERPOWERS_DEFINITION),
    );
  },

  get(id: string): WorkflowDefinition | undefined {
    const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id) as WorkflowDefinitionRow | undefined;
    return row ? normalize(row) : undefined;
  },

  getBuiltInByKey(key: string): WorkflowDefinition | undefined {
    this.ensureBuiltInDefinitions();
    const row = db.prepare('SELECT * FROM workflow_definitions WHERE builtin_key = ?').get(key) as WorkflowDefinitionRow | undefined;
    return row ? normalize(row) : undefined;
  },

  getSuperpowersDefinition(): WorkflowDefinition {
    const definition = this.getBuiltInByKey(BUILTIN_SUPERPOWERS_KEY);
    if (!definition) throw new Error('Superpowers workflow definition is not available');
    return definition;
  },

  listSelectableBuiltIns(): WorkflowDefinition[] {
    return [this.getSuperpowersDefinition()];
  },

  listSelectableForRoom(roomId: string): WorkflowDefinition[] {
    if (!roomRepo.get(roomId)) return [];
    return this.listSelectableBuiltIns();
  },

  getPublishedOrDefault(id: string | null | undefined): WorkflowDefinition {
    if (id) {
      const definition = this.get(id);
      if (definition?.status === 'published') return definition;
    }
    return this.ensureBuiltInDefinitions();
  },

  getPublishedForRoomOrDefault(id: string | null | undefined, roomId: string): WorkflowDefinition {
    if (id && this.isVisibleForRoom(id, roomId)) return this.get(id)!;
    return this.ensureBuiltInDefinitions();
  },

  isVisibleForProject(id: string, projectId: string): boolean {
    const definition = this.get(id);
    if (!definition || definition.status !== 'published') return false;
    return definition.scope === 'system' || (definition.scope === 'project' && definition.scope_id === projectId);
  },

  isVisibleForRoom(id: string, roomId: string): boolean {
    const room = roomRepo.get(roomId);
    if (!room) return false;
    const definition = this.get(id);
    if (!definition || definition.status !== 'published') return false;
    return (
      definition.scope === 'system' ||
      (definition.scope === 'project' && definition.scope_id === room.project_id) ||
      (definition.scope === 'room' && definition.scope_id === room.id)
    );
  },

  isVisibleForSystem(id: string): boolean {
    const definition = this.get(id);
    return Boolean(definition && definition.status === 'published' && definition.scope === 'system');
  },

  list(filters: WorkflowDefinitionListFilters = {}): WorkflowDefinition[] {
    this.ensureBuiltInDefinitions();
    const rows = db
      .prepare('SELECT * FROM workflow_definitions ORDER BY updated_at DESC, created_at DESC')
      .all() as WorkflowDefinitionRow[];
    return rows
      .map(normalize)
      .filter((definition) => matchesListFilters(definition, filters));
  },

  listVisibleForRoom(roomId: string): WorkflowDefinition[] {
    const room = roomRepo.get(roomId);
    if (!room) return [];
    this.ensureBuiltInDefinitions();
    const rows = db
      .prepare(
        `SELECT * FROM workflow_definitions
         WHERE status = 'published'
           AND (
             scope = 'system'
             OR (scope = 'project' AND scope_id = ?)
             OR (scope = 'room' AND scope_id = ?)
           )
         ORDER BY scope ASC, updated_at DESC`,
      )
      .all(room.project_id, room.id) as WorkflowDefinitionRow[];
    return rows.map(normalize);
  },

  createDraft(input: {
    name: string;
    description?: string | null;
    scope: WorkflowDefinitionScope;
    scope_id: string;
    definition: WorkflowDefinitionGraph;
  }): WorkflowDefinition {
    const scopeId = normalizeScopeTarget(input.scope, input.scope_id);
    const graph = this.validateDefinition(input.definition);
    const id = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO workflow_definitions (
        id, name, description, scope, scope_id, version, status, builtin_key, definition_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'draft', NULL, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      input.description?.trim() || null,
      input.scope,
      scopeId,
      JSON.stringify(graph),
      ts,
      ts,
    );
    return this.get(id)!;
  },

  duplicate(id: string, target?: {
    name?: string;
    description?: string | null;
    scope?: WorkflowDefinitionScope;
    scope_id?: string;
    version?: number;
  }): WorkflowDefinition | undefined {
    const source = this.get(id);
    if (!source) return undefined;
    const scope = target?.scope ?? source.scope;
    const scopeId = normalizeScopeTarget(scope, target?.scope_id ?? source.scope_id);
    const draftId = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO workflow_definitions (
        id, name, description, scope, scope_id, version, status, builtin_key, definition_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?)`,
    ).run(
      draftId,
      target?.name?.trim() || `${source.name} 副本`,
      target?.description === undefined ? source.description : target.description?.trim() || null,
      scope,
      scopeId,
      target?.version ?? 1,
      JSON.stringify(source.definition),
      ts,
      ts,
    );
    return this.get(draftId);
  },

  createEditDraft(id: string): WorkflowDefinition | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status === 'draft') return existing;
    if (existing.status === 'archived') return undefined;
    return this.duplicate(id, {
      name: existing.name,
      description: existing.description,
      scope: existing.scope,
      scope_id: existing.scope_id,
      version: existing.version + 1,
    });
  },

  archive(id: string): WorkflowDefinition | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.builtin_key) throw new Error('builtin workflow definition cannot be archived');
    if (existing.status !== 'published') throw new Error('only published workflow definitions can be archived');
    db.prepare(
      `UPDATE workflow_definitions
       SET status = 'archived', updated_at = ?
       WHERE id = ?`,
    ).run(now(), id);
    db.prepare(
      `UPDATE settings
       SET default_workflow_definition_id = NULL, updated_at = ?
       WHERE default_workflow_definition_id = ?`,
    ).run(now(), id);
    return this.get(id);
  },

  deleteDraft(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.builtin_key) throw new Error('builtin workflow definition cannot be deleted');
    if (existing.status !== 'draft') throw new Error('only draft workflow definitions can be deleted');
    const result = db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id);
    return result.changes > 0;
  },

  updateDraft(id: string, patch: {
    name?: string;
    description?: string | null;
    definition?: WorkflowDefinitionGraph;
  }): WorkflowDefinition | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.builtin_key) throw new Error('builtin workflow definition cannot be edited');
    if (existing.status !== 'draft') throw new Error('only draft workflow definitions can be edited');
    const graph = patch.definition ? this.validateDefinition(patch.definition) : existing.definition;
    db.prepare(
      `UPDATE workflow_definitions
       SET name = ?, description = ?, definition_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.name?.trim() || existing.name,
      patch.description === undefined ? existing.description : patch.description?.trim() || null,
      JSON.stringify(graph),
      now(),
      id,
    );
    return this.get(id);
  },

  publish(id: string): WorkflowDefinition | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.builtin_key) return existing;
    if (existing.status !== 'draft') throw new Error('only draft workflow definitions can be published');
    db.prepare(
      `UPDATE workflow_definitions
       SET status = 'published', version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(existing.version, now(), id);
    return this.get(id);
  },

  validateDefinition(input: WorkflowDefinitionGraph): WorkflowDefinitionGraph {
    if (!input || typeof input !== 'object') throw new Error('workflow definition must be an object');
    if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
      throw new Error('workflow definition must include nodes');
    }
    if (!Array.isArray(input.edges)) throw new Error('workflow definition edges must be an array');

    const ids = new Set<string>();
    const nodeTypeIds = new Set<string>();
    const nodes = input.nodes.map((node) => {
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) throw new Error('workflow node id is required');
      if (ids.has(id)) throw new Error(`duplicate workflow node id: ${id}`);
      ids.add(id);
      if (!ALLOWED_NODE_TYPES.has(node.type)) {
        throw new Error(`unsupported workflow node type: ${String(node.type)}`);
      }
      if (nodeTypeIds.has(node.type)) {
        throw new Error(`duplicate workflow node type is not supported yet: ${node.type}`);
      }
      nodeTypeIds.add(node.type);
      const metadata = normalizeDefinitionMetadata(node.metadata);
      return {
        id,
        type: node.type,
        label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : id,
        stage: node.stage ?? defaultStageForNodeType(node.type),
        role: node.role ?? null,
        position: normalizePosition(node.position),
        ...(metadata ? { metadata } : {}),
      };
    });

    const edges = input.edges.map((edge) => {
      const from = typeof edge.from === 'string' ? edge.from.trim() : '';
      const to = typeof edge.to === 'string' ? edge.to.trim() : '';
      if (!ids.has(from)) throw new Error(`unknown workflow edge source: ${from}`);
      if (!ids.has(to)) throw new Error(`unknown workflow edge target: ${to}`);
      return {
        from,
        to,
        condition: typeof edge.condition === 'string' && edge.condition.trim() ? edge.condition.trim() : null,
      };
    });

    const metadata = normalizeDefinitionMetadata(input.metadata);
    const graph = metadata ? { nodes, edges, metadata } : { nodes, edges };
    requireSupportedWorkflowShape(graph);
    requireExecutableWorkflowShape(graph);
    return graph;
  },
};

function normalizeScopeTarget(scope: WorkflowDefinitionScope, scopeId: string): string {
  if (scope === 'system') return 'default';
  if (scope === 'project' && !projectRepo.get(scopeId)) throw new Error('workflow definition project scope does not exist');
  if (scope === 'room' && !roomRepo.get(scopeId)) throw new Error('workflow definition room scope does not exist');
  return scopeId;
}

function matchesListFilters(definition: WorkflowDefinition, filters: WorkflowDefinitionListFilters): boolean {
  if (filters.scope && definition.scope !== filters.scope) return false;
  if (filters.status && definition.status !== filters.status) return false;
  if (!filters.status && !filters.includeArchived && definition.status === 'archived') return false;
  if (filters.roomId) {
    const room = roomRepo.get(filters.roomId);
    if (!room) return false;
    if (filters.projectId && room.project_id !== filters.projectId) return false;
    return (
      definition.scope === 'system' ||
      (definition.scope === 'project' && definition.scope_id === room.project_id) ||
      (definition.scope === 'room' && definition.scope_id === room.id)
    );
  }
  if (filters.projectId) {
    return definition.scope === 'system' || (definition.scope === 'project' && definition.scope_id === filters.projectId);
  }
  return true;
}

function requireSupportedWorkflowShape(input: WorkflowDefinitionGraph): void {
  const types = new Set(input.nodes.map((node) => node.type));
  if (input.metadata?.runtime_profile === 'superpowers' || types.has('tdd_execute')) {
    requireSuperpowersWorkflowShape(types);
    return;
  }
  const hasDevelopmentNode = ['approval_gate', 'dispatch', 'execute', 'review', 'repair_decision', 'verify']
    .some((type) => types.has(type as WorkflowDefinitionNodeType));
  if (!hasDevelopmentNode) {
    requireAnalysisWorkflowShape(types);
    return;
  }
  requireDevelopmentWorkflowShape(types);
}

function requireSuperpowersWorkflowShape(types: Set<WorkflowDefinitionNodeType>): void {
  const required: WorkflowDefinitionNodeType[] = [
    'context',
    'brainstorming',
    'spec_review',
    'worktree',
    'writing_plans',
    'plan_review',
    'approval_gate',
    'dispatch',
    'tdd_execute',
    'spec_compliance_review',
    'code_quality_review',
    'verify',
    'finish_branch',
    'acceptance',
    'memory',
  ];
  for (const type of required) {
    if (!types.has(type)) throw new Error(`workflow definition must include ${type} node`);
  }
}

function requireDevelopmentWorkflowShape(types: Set<WorkflowDefinitionNodeType>): void {
  const required: WorkflowDefinitionNodeType[] = [
    'planning',
    'approval_gate',
    'dispatch',
    'execute',
    'review',
    'repair_decision',
    'verify',
    'acceptance',
    'memory',
  ];
  for (const type of required) {
    if (!types.has(type)) throw new Error(`workflow definition must include ${type} node`);
  }
}

function requireAnalysisWorkflowShape(types: Set<WorkflowDefinitionNodeType>): void {
  const required: WorkflowDefinitionNodeType[] = ['context', 'planning', 'acceptance', 'memory'];
  for (const type of required) {
    if (!types.has(type)) throw new Error(`workflow definition must include ${type} node`);
  }
}

function requireExecutableWorkflowShape(input: WorkflowDefinitionGraph): void {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const incoming = new Map(input.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, WorkflowDefinitionGraph['edges']>();
  for (const edge of input.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const startNodes = input.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  if (startNodes.length !== 1) throw new Error('workflow definition must have exactly one start node');

  const visited = new Set<string>();
  const stack = [startNodes[0]!.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (!visited.has(edge.to)) stack.push(edge.to);
    }
  }
  if (visited.size !== input.nodes.length) throw new Error('workflow definition must be fully reachable from the start node');

  for (const edge of input.edges) {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    if (!isSupportedRuntimeTransition(from.type, to.type, edge.condition ?? null)) {
      throw new Error(`unsupported workflow transition: ${from.type} -> ${to.type}`);
    }
  }
}

function isSupportedRuntimeTransition(
  from: WorkflowDefinitionNodeType,
  to: WorkflowDefinitionNodeType,
  condition: string | null,
): boolean {
  if (from === 'context') return to === 'planning' || to === 'brainstorming';
  if (from === 'brainstorming') return to === 'spec_review';
  if (from === 'spec_review') return to === 'worktree';
  if (from === 'worktree') return to === 'writing_plans';
  if (from === 'writing_plans') return to === 'plan_review';
  if (from === 'plan_review') return to === 'approval_gate';
  if (from === 'planning') return to === 'approval_gate' || to === 'acceptance';
  if (from === 'approval_gate') return to === 'dispatch' && (!condition || condition === 'approved' || condition === 'default');
  if (from === 'dispatch') return to === 'execute' || to === 'tdd_execute';
  if (from === 'execute') {
    return (
      (to === 'execute' && condition === 'has_runnable_child') ||
      (to === 'review' && (!condition || condition === 'done' || condition === 'review' || condition === 'complete' || condition === 'default'))
    );
  }
  if (from === 'tdd_execute') return to === 'spec_compliance_review';
  if (from === 'spec_compliance_review') return to === 'code_quality_review';
  if (from === 'code_quality_review') return to === 'verify';
  if (from === 'review') {
    return (
      (to === 'repair_decision' && condition === 'changes_requested') ||
      (to === 'verify' && (!condition || condition === 'pass' || condition === 'verify' || condition === 'default'))
    );
  }
  if (from === 'repair_decision') return to === 'execute' && (!condition || condition === 'repair' || condition === 'execute' || condition === 'default');
  if (from === 'verify') {
    return (
      (to === 'acceptance' && (!condition || condition === 'pass' || condition === 'acceptance' || condition === 'default')) ||
      (to === 'finish_branch' && (!condition || condition === 'pass' || condition === 'default'))
    );
  }
  if (from === 'finish_branch') return to === 'acceptance' && (!condition || condition === 'completed' || condition === 'default');
  if (from === 'acceptance') return to === 'memory' && (!condition || condition === 'completed' || condition === 'default');
  return false;
}

function defaultStageForNodeType(type: WorkflowDefinitionNodeType) {
  if (type === 'context' || type === 'brainstorming' || type === 'spec_review') return 'analysis';
  if (type === 'planning' || type === 'worktree' || type === 'writing_plans' || type === 'plan_review' || type === 'approval_gate') return 'planning';
  if (type === 'dispatch' || type === 'repair_decision') return 'assignment';
  if (type === 'execute' || type === 'tdd_execute') return 'implementation';
  if (type === 'review' || type === 'spec_compliance_review' || type === 'code_quality_review' || type === 'verify') return 'code_review';
  return 'acceptance';
}

function normalizeDefinitionMetadata(metadata: unknown): NonNullable<WorkflowDefinitionGraph['metadata']> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = metadata as {
    runtime_profile?: unknown;
    required_skill_names?: unknown;
    gate_policy?: unknown;
  };
  const normalized: NonNullable<WorkflowDefinitionGraph['metadata']> = {};
  if (value.runtime_profile === 'superpowers') normalized.runtime_profile = 'superpowers';
  if (Array.isArray(value.required_skill_names)) {
    const names = value.required_skill_names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length > 0) normalized.required_skill_names = names;
  }
  if (typeof value.gate_policy === 'string' && value.gate_policy.trim()) {
    normalized.gate_policy = value.gate_policy.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizePosition(position: unknown): { x: number; y: number } | null {
  if (!position || typeof position !== 'object') return null;
  const value = position as { x?: unknown; y?: unknown };
  if (typeof value.x !== 'number' || typeof value.y !== 'number') return null;
  return { x: value.x, y: value.y };
}
