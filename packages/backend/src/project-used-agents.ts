import { db } from './db.js';
import { projectRepo } from './repos/projects.js';
import { resolveSessionPlannerRuntime } from './session-planner-runtime.js';
import type { AcpBackend, ProjectUsedAgentsPayload, ProjectUsedRoomAgent, WorkflowRole } from './types.js';

type RoomAgentUsageRow = {
  room_id: string;
  room_name: string;
  room_agent_id: string;
  global_agent_id: string | null;
  agent_id: string;
  name: string;
  acp_enabled: 0 | 1;
  acp_backend: AcpBackend | null;
  workflow_role: WorkflowRole | null;
};

function listProjectRoomAgentUsageRows(projectId: string): RoomAgentUsageRow[] {
  return db
    .prepare(
      `SELECT
        rooms.id AS room_id,
        rooms.name AS room_name,
        room_agents.id AS room_agent_id,
        room_agents.global_agent_id AS global_agent_id,
        COALESCE(agents.agent_id, room_agents.agent_id) AS agent_id,
        COALESCE(agents.name, room_agents.agent_name) AS name,
        room_agents.acp_enabled AS acp_enabled,
        room_agents.acp_backend AS acp_backend,
        room_agents.workflow_role AS workflow_role
      FROM rooms
      JOIN room_agents ON room_agents.room_id = rooms.id
      LEFT JOIN agents ON agents.id = room_agents.global_agent_id
      WHERE rooms.project_id = ?
        AND room_agents.left_at IS NULL
      ORDER BY rooms.created_at ASC, rooms.name ASC, room_agents.joined_at ASC, room_agents.id ASC`,
    )
    .all(projectId) as RoomAgentUsageRow[];
}

function dedupeKey(row: Pick<RoomAgentUsageRow, 'global_agent_id' | 'agent_id'>): string {
  return row.global_agent_id ? `global:${row.global_agent_id}` : `local:${row.agent_id}`;
}

function selectSummaryBackend(existing: AcpBackend | null, next: AcpBackend | null): AcpBackend | null {
  return existing ?? next;
}

function buildRoomAgents(projectId: string): ProjectUsedRoomAgent[] {
  const agentsByKey = new Map<string, ProjectUsedRoomAgent>();

  for (const row of listProjectRoomAgentUsageRows(projectId)) {
    const key = dedupeKey(row);
    const binding: ProjectUsedRoomAgent['room_bindings'][number] = {
      room_id: row.room_id,
      room_name: row.room_name,
      room_agent_id: row.room_agent_id,
      acp_backend: row.acp_backend,
      workflow_role: row.workflow_role,
    };

    const existing = agentsByKey.get(key);
    if (!existing) {
      agentsByKey.set(key, {
        kind: 'room_agent',
        global_agent_id: row.global_agent_id,
        agent_id: row.agent_id,
        name: row.name,
        acp_enabled: Boolean(row.acp_enabled),
        acp_backend: row.acp_backend,
        room_bindings: [binding],
      });
      continue;
    }

    existing.acp_enabled = existing.acp_enabled || Boolean(row.acp_enabled);
    existing.acp_backend = selectSummaryBackend(existing.acp_backend, row.acp_backend);
    existing.room_bindings.push(binding);
  }

  return Array.from(agentsByKey.values());
}

export function buildProjectUsedAgents(projectId: string): ProjectUsedAgentsPayload {
  if (!projectRepo.get(projectId)) throw new Error('project not found');
  const plannerRuntime = resolveSessionPlannerRuntime(projectId);

  return {
    planner: {
      kind: 'session_planner',
      agent_id: 'planner',
      name: plannerRuntime.agent.name,
      effective_acp_backend: plannerRuntime.backend,
      project_override_acp_backend: plannerRuntime.projectOverrideBackend,
      backend_source: plannerRuntime.backendSource,
      runtime_profile: {
        permission_mode: plannerRuntime.permissionMode,
        runtime_backend: plannerRuntime.runtimeBackend,
        tool_policy: plannerRuntime.toolPolicy,
        workspace_policy: plannerRuntime.workspacePolicy,
        memory_scope: plannerRuntime.memoryScope,
      },
    },
    agents: buildRoomAgents(projectId),
  };
}
