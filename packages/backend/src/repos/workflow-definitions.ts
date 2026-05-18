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

const BUILTIN_DEFAULT_KEY = 'default-langgraph';

const ALLOWED_NODE_TYPES = new Set<WorkflowDefinitionNodeType>([
  'context',
  'planning',
  'approval_gate',
  'dispatch',
  'execute',
  'review',
  'repair_decision',
  'verify',
  'acceptance',
  'memory',
]);

const DEFAULT_DEFINITION: WorkflowDefinitionGraph = {
  nodes: [
    { id: 'context', type: 'context', label: 'Context', stage: 'analysis', position: { x: 0, y: 80 } },
    { id: 'planning', type: 'planning', label: 'Planning', stage: 'planning', role: 'planner', position: { x: 220, y: 80 } },
    { id: 'approval', type: 'approval_gate', label: 'Approval', stage: 'planning', position: { x: 440, y: 80 } },
    { id: 'dispatch', type: 'dispatch', label: 'Dispatch', stage: 'assignment', role: 'coordinator', position: { x: 660, y: 80 } },
    { id: 'execute', type: 'execute', label: 'Execute', stage: 'implementation', role: 'executor', position: { x: 880, y: 80 } },
    { id: 'review', type: 'review', label: 'Review', stage: 'code_review', role: 'reviewer', position: { x: 1100, y: 80 } },
    { id: 'repair_decision', type: 'repair_decision', label: 'Repair Decision', stage: 'assignment', role: 'coordinator', position: { x: 1100, y: 240 } },
    { id: 'verify', type: 'verify', label: 'Verify', stage: 'code_review', position: { x: 1320, y: 80 } },
    { id: 'acceptance', type: 'acceptance', label: 'Acceptance', stage: 'acceptance', role: 'acceptor', position: { x: 1540, y: 80 } },
    { id: 'memory', type: 'memory', label: 'Memory', stage: 'acceptance', position: { x: 1760, y: 80 } },
  ],
  edges: [
    { from: 'context', to: 'planning' },
    { from: 'planning', to: 'approval' },
    { from: 'approval', to: 'dispatch', condition: 'approved' },
    { from: 'dispatch', to: 'execute' },
    { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
    { from: 'execute', to: 'review', condition: 'done' },
    { from: 'review', to: 'repair_decision', condition: 'changes_requested' },
    { from: 'review', to: 'verify', condition: 'pass' },
    { from: 'repair_decision', to: 'execute' },
    { from: 'verify', to: 'acceptance' },
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

export const workflowDefinitionRepo = {
  ensureBuiltInDefinitions(): WorkflowDefinition {
    const existing = db
      .prepare('SELECT * FROM workflow_definitions WHERE builtin_key = ?')
      .get(BUILTIN_DEFAULT_KEY) as WorkflowDefinitionRow | undefined;
    if (existing) return normalize(existing);

    const id = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO workflow_definitions (
        id, name, description, scope, scope_id, version, status, builtin_key, definition_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'system', 'default', 1, 'published', ?, ?, ?, ?)`,
    ).run(
      id,
      '默认开发闭环',
      '内置 LangGraph 开发闭环：规划、审批、执行、审查、验证、验收和记忆。',
      BUILTIN_DEFAULT_KEY,
      JSON.stringify(this.validateDefinition(DEFAULT_DEFINITION)),
      ts,
      ts,
    );
    return this.get(id)!;
  },

  get(id: string): WorkflowDefinition | undefined {
    const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id) as WorkflowDefinitionRow | undefined;
    return row ? normalize(row) : undefined;
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
      ) VALUES (?, ?, ?, ?, ?, 1, 'draft', NULL, ?, ?, ?)`,
    ).run(
      draftId,
      target?.name?.trim() || `${source.name} 副本`,
      target?.description === undefined ? source.description : target.description?.trim() || null,
      scope,
      scopeId,
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
    const nodeTypes = new Set<WorkflowDefinitionNodeType>();
    const nodes = input.nodes.map((node) => {
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) throw new Error('workflow node id is required');
      if (ids.has(id)) throw new Error(`duplicate workflow node id: ${id}`);
      ids.add(id);
      if (!ALLOWED_NODE_TYPES.has(node.type)) {
        throw new Error(`unsupported workflow node type: ${String(node.type)}`);
      }
      if (nodeTypes.has(node.type)) {
        throw new Error(`duplicate workflow node type is not supported yet: ${node.type}`);
      }
      nodeTypes.add(node.type);
      return {
        id,
        type: node.type,
        label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : id,
        stage: node.stage ?? defaultStageForNodeType(node.type),
        role: node.role ?? null,
        position: normalizePosition(node.position),
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

    requireSupportedWorkflowShape({ nodes, edges });
    requireExecutableWorkflowShape({ nodes, edges });
    return { nodes, edges };
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
  if (from === 'context') return to === 'planning';
  if (from === 'planning') return to === 'approval_gate';
  if (from === 'approval_gate') return to === 'dispatch' && (!condition || condition === 'approved' || condition === 'default');
  if (from === 'dispatch') return to === 'execute';
  if (from === 'execute') {
    return (
      (to === 'execute' && condition === 'has_runnable_child') ||
      (to === 'review' && (!condition || condition === 'done' || condition === 'review' || condition === 'complete' || condition === 'default'))
    );
  }
  if (from === 'review') {
    return (
      (to === 'repair_decision' && condition === 'changes_requested') ||
      (to === 'verify' && (!condition || condition === 'pass' || condition === 'verify' || condition === 'default'))
    );
  }
  if (from === 'repair_decision') return to === 'execute' && (!condition || condition === 'repair' || condition === 'execute' || condition === 'default');
  if (from === 'verify') return to === 'acceptance' && (!condition || condition === 'pass' || condition === 'acceptance' || condition === 'default');
  if (from === 'acceptance') return to === 'memory' && (!condition || condition === 'completed' || condition === 'default');
  return false;
}

function defaultStageForNodeType(type: WorkflowDefinitionNodeType) {
  if (type === 'context') return 'analysis';
  if (type === 'planning' || type === 'approval_gate') return 'planning';
  if (type === 'dispatch' || type === 'repair_decision') return 'assignment';
  if (type === 'execute') return 'implementation';
  if (type === 'review' || type === 'verify') return 'code_review';
  return 'acceptance';
}

function normalizePosition(position: unknown): { x: number; y: number } | null {
  if (!position || typeof position !== 'object') return null;
  const value = position as { x?: unknown; y?: unknown };
  if (typeof value.x !== 'number' || typeof value.y !== 'number') return null;
  return { x: value.x, y: value.y };
}
