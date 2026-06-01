import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.OPENCLAW_ROOM_DB ?? join(DATA_DIR, 'openclaw-room.db');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  pinned_at INTEGER,
  sort_order INTEGER,
  message_routing_mode TEXT NOT NULL DEFAULT 'fallback_reply',
  fallback_agent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  message_routing_mode TEXT,
  fallback_agent_id TEXT,
  interaction_mode TEXT,
  auto_distill_enabled INTEGER CHECK (auto_distill_enabled IN (0, 1)),
  default_workflow_definition_id TEXT,
  superpowers_bootstrap_owner TEXT CHECK (superpowers_bootstrap_owner IN ('project', 'provider', 'disabled')),
  workspace_excluded_dirs TEXT,
  langchain_planner_model TEXT,
  openai_api_key TEXT,
  openai_base_url TEXT,
  active_ai_config_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS ai_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  langchain_planner_model TEXT NOT NULL,
  openai_api_key TEXT,
  openai_base_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL,
  source_uri TEXT,
  install_path TEXT NOT NULL,
  manifest_path TEXT,
  runtime_scopes TEXT NOT NULL,
  trigger_mode TEXT NOT NULL,
  trigger_keywords TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  checksum TEXT,
  package_version TEXT,
  package_revision TEXT,
  runtime_type TEXT,
  entrypoint TEXT,
  permissions_json TEXT,
  install_source_label TEXT,
  update_check_mode TEXT NOT NULL DEFAULT 'startup',
  update_apply_mode TEXT NOT NULL DEFAULT 'prompt',
  last_update_checked_at INTEGER,
  available_version TEXT,
  available_revision TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, priority, updated_at);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  project_id TEXT,
  room_id TEXT,
  agent_id TEXT,
  invoked_by TEXT NOT NULL,
  runtime TEXT NOT NULL,
  entrypoint TEXT NOT NULL,
  input_json TEXT,
  allowed_paths_json TEXT,
  network_enabled INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_skill_runs_project ON skill_runs(project_id, created_at);

CREATE TABLE IF NOT EXISTS skill_bindings (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority_override INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE(skill_id, scope, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_bindings_scope ON skill_bindings(scope, scope_id, enabled);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  pinned_at INTEGER,
  sort_order INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms(project_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  preferred_user_name TEXT,
  personality TEXT,
  rules TEXT,
  responsibilities TEXT,
  default_acp_backend TEXT,
  default_acp_permission_mode TEXT NOT NULL DEFAULT 'bypass',
  default_runtime_backend TEXT NOT NULL DEFAULT 'acp',
  default_tool_policy TEXT NOT NULL DEFAULT '{"allowed":[]}',
  default_workspace_policy TEXT NOT NULL DEFAULT '{"read":[],"write":[]}',
  default_memory_scope TEXT NOT NULL DEFAULT 'agent',
  runtime_profile_version INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  builtin_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updated_at);

CREATE TABLE IF NOT EXISTS room_agents (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  global_agent_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  acp_enabled INTEGER NOT NULL DEFAULT 0,
  acp_backend TEXT,
  acp_session_id TEXT,
  acp_session_label TEXT,
  acp_session_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (acp_session_handoff_pending IN (0, 1)),
  acp_session_handoff_reason TEXT,
  acp_permission_mode TEXT NOT NULL DEFAULT 'bypass',
  acp_writable_dirs TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  default_runtime TEXT NOT NULL DEFAULT 'none',
  runtime_backend TEXT,
  tool_policy TEXT,
  workspace_policy TEXT,
  memory_scope TEXT,
  runtime_profile_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (global_agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  UNIQUE (room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_room_agents_room ON room_agents(room_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  layer TEXT NOT NULL DEFAULT 'chat',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS global_chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_chat_sessions_updated ON global_chat_sessions(archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS global_chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES global_chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_global_chat_messages_session ON global_chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by_id TEXT,
  uploaded_by_name TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_files_project_created ON files(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_project_deleted ON files(project_id, deleted_at);

CREATE TABLE IF NOT EXISTS message_file_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  UNIQUE (message_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_message_file_refs_file ON message_file_refs(file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_file_refs_room ON message_file_refs(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS resource_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  group_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  mime_type TEXT,
  size INTEGER,
  url TEXT,
  file_id TEXT,
  source_message_id TEXT,
  source_room_id TEXT,
  source_agent_id TEXT,
  source_task_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (source_room_id) REFERENCES rooms(id) ON DELETE SET NULL,
  FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_assets_project ON resource_assets(project_id, asset_type, group_key, created_at);
CREATE INDEX IF NOT EXISTS idx_resource_assets_source_message ON resource_assets(source_message_id);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  room_agent_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  status TEXT NOT NULL,
  session_key TEXT,
  acp_session_id TEXT,
  prompt TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  activity_log TEXT NOT NULL DEFAULT '',
  error TEXT,
  superpowers_bootstrap_owner TEXT,
  superpowers_bootstrap_injected INTEGER NOT NULL DEFAULT 0 CHECK (superpowers_bootstrap_injected IN (0, 1)),
  superpowers_bootstrap_skill TEXT,
  superpowers_bootstrap_skip_reason TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_room ON agent_runs(room_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('system', 'project', 'room')),
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  builtin_key TEXT UNIQUE,
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_scope ON workflow_definitions(scope, scope_id, status, updated_at);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  graph_version TEXT,
  graph_state TEXT,
  approval_required INTEGER NOT NULL DEFAULT 1,
  approved_at INTEGER,
  approved_by TEXT,
  openclaw_flow_id TEXT,
  workflow_definition_id TEXT,
  workflow_definition_version INTEGER,
  workflow_definition_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_task ON workflow_runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_room ON workflow_runs(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  node_name TEXT,
  status TEXT NOT NULL,
  room_agent_id TEXT,
  assigned_room_agent_id TEXT,
  scope_read TEXT NOT NULL DEFAULT '[]',
  scope_write TEXT NOT NULL DEFAULT '[]',
  agent_run_id TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  result_message_id TEXT,
  openclaw_child_task_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(workflow_run_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps(status);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_step_id TEXT,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_step_id) REFERENCES workflow_steps(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_workflow ON task_artifacts(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_context_entries (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  workflow_step_id TEXT,
  task_id TEXT NOT NULL,
  room_agent_id TEXT,
  agent_run_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  raw_char_count INTEGER NOT NULL DEFAULT 0,
  summary_char_count INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_step_id) REFERENCES workflow_steps(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_context_run ON workflow_context_entries(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_context_step ON workflow_context_entries(workflow_step_id);
CREATE INDEX IF NOT EXISTS idx_workflow_context_task ON workflow_context_entries(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_context_type ON workflow_context_entries(workflow_run_id, entry_type, created_at);
DROP INDEX IF EXISTS idx_workflow_context_source_version;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_context_source_version
  ON workflow_context_entries(workflow_run_id, source_type, source_id, entry_type, version);

CREATE TABLE IF NOT EXISTS workflow_incidents (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_step_id TEXT,
  task_id TEXT NOT NULL,
  child_task_id TEXT,
  agent_run_id TEXT,
  room_agent_id TEXT,
  incident_type TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  fingerprint TEXT NOT NULL,
  error TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT,
  action TEXT,
  action_status TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_step_id) REFERENCES workflow_steps(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE SET NULL,
  UNIQUE(workflow_run_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_workflow_incidents_open ON workflow_incidents(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflow_incidents_workflow ON workflow_incidents(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_incidents_child ON workflow_incidents(workflow_run_id, child_task_id, incident_type);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  room_id TEXT,
  room_agent_id TEXT,
  task_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'room', 'agent', 'task')),
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('decision', 'fact', 'preference', 'lesson', 'task_summary', 'artifact_summary')
  ),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'message', 'workflow', 'task')),
  source_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CHECK (
    (scope = 'global' AND project_id IS NULL AND room_id IS NULL AND room_agent_id IS NULL AND task_id IS NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND room_id IS NULL AND room_agent_id IS NULL AND task_id IS NULL)
    OR (scope = 'room' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NULL)
    OR (scope = 'agent' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NOT NULL AND task_id IS NULL)
    OR (scope = 'task' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_room ON memory_entries(room_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(room_agent_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_task ON memory_entries(task_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_task_source
  ON memory_entries(task_id, source_type, source_id)
  WHERE task_id IS NOT NULL AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_room_source
  ON memory_entries(room_id, source_type, source_id)
  WHERE scope = 'room' AND room_id IS NOT NULL AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_project_source
  ON memory_entries(project_id, source_type, source_id)
  WHERE scope = 'project' AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_global_source
  ON memory_entries(source_type, source_id)
  WHERE scope = 'global' AND source_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_memory_entries_validate_insert
BEFORE INSERT ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'memory room_id does not belong to project_id')
  WHERE NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = NEW.room_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to project_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      JOIN rooms ON rooms.id = room_agents.room_id
      WHERE room_agents.id = NEW.room_agent_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to room_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      WHERE room_agents.id = NEW.room_agent_id AND room_agents.room_id = NEW.room_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to project_id')
  WHERE NEW.task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to room_id')
  WHERE NEW.task_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.room_id = NEW.room_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_entries_validate_update
BEFORE UPDATE OF project_id, room_id, room_agent_id, task_id, scope ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'memory room_id does not belong to project_id')
  WHERE NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = NEW.room_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to project_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      JOIN rooms ON rooms.id = room_agents.room_id
      WHERE room_agents.id = NEW.room_agent_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to room_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      WHERE room_agents.id = NEW.room_agent_id AND room_agents.room_id = NEW.room_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to project_id')
  WHERE NEW.task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to room_id')
  WHERE NEW.task_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.room_id = NEW.room_id
    );
END;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'normal',
  interaction_mode TEXT NOT NULL DEFAULT 'ask_user',
  assigned_agent_id TEXT,
  source_message_id TEXT,
  created_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  layer TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_task_events_room_created ON task_events(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_layer ON task_events(task_id, layer, seq);

CREATE TABLE IF NOT EXISTS task_executors (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  room_agent_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  acp_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  acp_session_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (acp_session_handoff_pending IN (0, 1)),
  acp_session_handoff_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE,
  UNIQUE(task_id, room_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_task_executors_task ON task_executors(task_id, status);
CREATE INDEX IF NOT EXISTS idx_task_executors_room_agent ON task_executors(room_agent_id, updated_at);
`);

export function migrateUniqueAgentDocumentSourceMessage(database: Database.Database = db): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_resource_assets_unique_source_message;

    UPDATE resource_assets
    SET source_message_id = NULLIF(TRIM(source_message_id), ''),
        updated_at = strftime('%s', 'now') * 1000
    WHERE asset_type = 'agent_document'
      AND source_message_id IS NOT NULL
      AND (TRIM(source_message_id) = '' OR source_message_id <> TRIM(source_message_id));

    WITH ranked AS (
      SELECT
        id,
        project_id,
        source_message_id,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, source_message_id
          ORDER BY created_at DESC, id DESC
        ) AS row_num
      FROM resource_assets
      WHERE asset_type = 'agent_document'
        AND source_message_id IS NOT NULL
        AND deleted_at IS NULL
    )
    UPDATE resource_assets
    SET deleted_at = COALESCE(deleted_at, strftime('%s', 'now') * 1000),
        updated_at = strftime('%s', 'now') * 1000
    WHERE id IN (
      SELECT id
      FROM ranked
      WHERE row_num > 1
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_assets_unique_source_message
      ON resource_assets(project_id, source_message_id)
      WHERE asset_type = 'agent_document'
        AND source_message_id IS NOT NULL
        AND deleted_at IS NULL;
  `);
}

migrateUniqueAgentDocumentSourceMessage();

const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
const projectColumnNames = new Set(projectColumns.map((column) => column.name));
if (!projectColumnNames.has('message_routing_mode')) {
  db.exec("ALTER TABLE projects ADD COLUMN message_routing_mode TEXT NOT NULL DEFAULT 'mentions_only'");
}
if (!projectColumnNames.has('fallback_agent_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN fallback_agent_id TEXT');
}
if (!projectColumnNames.has('pinned_at')) {
  db.exec('ALTER TABLE projects ADD COLUMN pinned_at INTEGER');
}
if (!projectColumnNames.has('sort_order')) {
  db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_sort ON projects(pinned_at IS NULL, sort_order IS NULL, sort_order, created_at DESC)');

const skillColumns = db.prepare('PRAGMA table_info(skills)').all() as { name: string }[];
const skillColumnNames = new Set(skillColumns.map((column) => column.name));
if (!skillColumnNames.has('package_version')) {
  db.exec('ALTER TABLE skills ADD COLUMN package_version TEXT');
}
if (!skillColumnNames.has('package_revision')) {
  db.exec('ALTER TABLE skills ADD COLUMN package_revision TEXT');
}
if (!skillColumnNames.has('runtime_type')) {
  db.exec('ALTER TABLE skills ADD COLUMN runtime_type TEXT');
}
if (!skillColumnNames.has('entrypoint')) {
  db.exec('ALTER TABLE skills ADD COLUMN entrypoint TEXT');
}
if (!skillColumnNames.has('permissions_json')) {
  db.exec('ALTER TABLE skills ADD COLUMN permissions_json TEXT');
}
if (!skillColumnNames.has('install_source_label')) {
  db.exec('ALTER TABLE skills ADD COLUMN install_source_label TEXT');
}
if (!skillColumnNames.has('update_check_mode')) {
  db.exec("ALTER TABLE skills ADD COLUMN update_check_mode TEXT NOT NULL DEFAULT 'startup'");
}
if (!skillColumnNames.has('update_apply_mode')) {
  db.exec("ALTER TABLE skills ADD COLUMN update_apply_mode TEXT NOT NULL DEFAULT 'prompt'");
}
if (!skillColumnNames.has('last_update_checked_at')) {
  db.exec('ALTER TABLE skills ADD COLUMN last_update_checked_at INTEGER');
}
if (!skillColumnNames.has('available_version')) {
  db.exec('ALTER TABLE skills ADD COLUMN available_version TEXT');
}
if (!skillColumnNames.has('available_revision')) {
  db.exec('ALTER TABLE skills ADD COLUMN available_revision TEXT');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_skill_runs_project ON skill_runs(project_id, created_at)');

const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[];
const roomColumnNames = new Set(roomColumns.map((column) => column.name));
if (!roomColumnNames.has('last_opened_at')) {
  db.exec('ALTER TABLE rooms ADD COLUMN last_opened_at INTEGER');
}
if (!roomColumnNames.has('pinned_at')) {
  db.exec('ALTER TABLE rooms ADD COLUMN pinned_at INTEGER');
}
if (!roomColumnNames.has('sort_order')) {
  db.exec('ALTER TABLE rooms ADD COLUMN sort_order INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_project_usage ON rooms(project_id, pinned_at IS NULL, sort_order IS NULL, sort_order, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_project_sort ON rooms(project_id, pinned_at IS NULL, sort_order IS NULL, sort_order, created_at DESC)');

const roomAgentColumns = db.prepare('PRAGMA table_info(room_agents)').all() as { name: string }[];
const roomAgentColumnNames = new Set(roomAgentColumns.map((column) => column.name));
if (!roomAgentColumnNames.has('workflow_role')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN workflow_role TEXT');
}
if (!roomAgentColumnNames.has('acp_permission_mode')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN acp_permission_mode TEXT NOT NULL DEFAULT 'bypass'");
}
if (!roomAgentColumnNames.has('acp_writable_dirs')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN acp_writable_dirs TEXT NOT NULL DEFAULT '[]'");
}
if (!roomAgentColumnNames.has('capabilities')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
}
if (!roomAgentColumnNames.has('default_runtime')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN default_runtime TEXT NOT NULL DEFAULT 'none'");
}
if (!roomAgentColumnNames.has('runtime_backend')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN runtime_backend TEXT');
}
if (!roomAgentColumnNames.has('tool_policy')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN tool_policy TEXT');
}
if (!roomAgentColumnNames.has('workspace_policy')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN workspace_policy TEXT');
}
if (!roomAgentColumnNames.has('memory_scope')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN memory_scope TEXT');
}
if (!roomAgentColumnNames.has('runtime_profile_version')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN runtime_profile_version INTEGER NOT NULL DEFAULT 0');
}
if (!roomAgentColumnNames.has('global_agent_id')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN global_agent_id TEXT');
}
if (!roomAgentColumnNames.has('left_at')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN left_at INTEGER');
}
if (!roomAgentColumnNames.has('acp_session_handoff_pending')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN acp_session_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (acp_session_handoff_pending IN (0, 1))');
}
if (!roomAgentColumnNames.has('acp_session_handoff_reason')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN acp_session_handoff_reason TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_room_agents_global_agent ON room_agents(global_agent_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_room_agents_active ON room_agents(room_id, left_at)');

const agentColumns = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
const agentColumnNames = new Set(agentColumns.map((column) => column.name));
if (!agentColumnNames.has('is_builtin')) {
  db.exec('ALTER TABLE agents ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0');
}
if (!agentColumnNames.has('builtin_key')) {
  db.exec('ALTER TABLE agents ADD COLUMN builtin_key TEXT');
}
if (!agentColumnNames.has('default_runtime_backend')) {
  db.exec("ALTER TABLE agents ADD COLUMN default_runtime_backend TEXT NOT NULL DEFAULT 'acp'");
}
if (!agentColumnNames.has('default_tool_policy')) {
  db.exec("ALTER TABLE agents ADD COLUMN default_tool_policy TEXT NOT NULL DEFAULT '{\"allowed\":[]}'");
}
if (!agentColumnNames.has('default_workspace_policy')) {
  db.exec("ALTER TABLE agents ADD COLUMN default_workspace_policy TEXT NOT NULL DEFAULT '{\"read\":[],\"write\":[]}'");
}
if (!agentColumnNames.has('default_memory_scope')) {
  db.exec("ALTER TABLE agents ADD COLUMN default_memory_scope TEXT NOT NULL DEFAULT 'agent'");
}
if (!agentColumnNames.has('runtime_profile_version')) {
  db.exec('ALTER TABLE agents ADD COLUMN runtime_profile_version INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_agents_builtin_key ON agents(builtin_key)');

const agentRunColumns = db.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[];
const agentRunColumnNames = new Set(agentRunColumns.map((column) => column.name));
if (!agentRunColumnNames.has('task_id')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN task_id TEXT');
}
if (!agentRunColumnNames.has('workflow_run_id')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN workflow_run_id TEXT');
}
if (!agentRunColumnNames.has('workflow_step_id')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN workflow_step_id TEXT');
}
if (!agentRunColumnNames.has('workflow_stage')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN workflow_stage TEXT');
}
if (!agentRunColumnNames.has('collaboration_run_id')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN collaboration_run_id TEXT');
}
if (!agentRunColumnNames.has('collaboration_stage')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN collaboration_stage TEXT');
}
if (!agentRunColumnNames.has('superpowers_bootstrap_owner')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_owner TEXT');
}
if (!agentRunColumnNames.has('superpowers_bootstrap_injected')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_injected INTEGER NOT NULL DEFAULT 0 CHECK (superpowers_bootstrap_injected IN (0, 1))');
}
if (!agentRunColumnNames.has('superpowers_bootstrap_skill')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_skill TEXT');
}
if (!agentRunColumnNames.has('superpowers_bootstrap_skip_reason')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_skip_reason TEXT');
}
if (!agentRunColumnNames.has('activity_log')) {
  db.exec("ALTER TABLE agent_runs ADD COLUMN activity_log TEXT NOT NULL DEFAULT ''");
}

const workflowRunColumns = db.prepare('PRAGMA table_info(workflow_runs)').all() as { name: string }[];
const workflowRunColumnNames = new Set(workflowRunColumns.map((column) => column.name));
if (!workflowRunColumnNames.has('graph_version')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN graph_version TEXT');
}
if (!workflowRunColumnNames.has('graph_state')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN graph_state TEXT');
}
if (!workflowRunColumnNames.has('workflow_definition_id')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN workflow_definition_id TEXT');
}
if (!workflowRunColumnNames.has('workflow_definition_version')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN workflow_definition_version INTEGER');
}
if (!workflowRunColumnNames.has('workflow_definition_snapshot')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN workflow_definition_snapshot TEXT');
}

const workflowStepColumns = db.prepare('PRAGMA table_info(workflow_steps)').all() as { name: string }[];
const workflowStepColumnNames = new Set(workflowStepColumns.map((column) => column.name));
if (!workflowStepColumnNames.has('node_name')) {
  db.exec('ALTER TABLE workflow_steps ADD COLUMN node_name TEXT');
}
if (!workflowStepColumnNames.has('scope_read')) {
  db.exec("ALTER TABLE workflow_steps ADD COLUMN scope_read TEXT NOT NULL DEFAULT '[]'");
}
if (!workflowStepColumnNames.has('scope_write')) {
  db.exec("ALTER TABLE workflow_steps ADD COLUMN scope_write TEXT NOT NULL DEFAULT '[]'");
}
if (!workflowStepColumnNames.has('assigned_room_agent_id')) {
  db.exec('ALTER TABLE workflow_steps ADD COLUMN assigned_room_agent_id TEXT');
}

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
const taskColumnNames = new Set(taskColumns.map((column) => column.name));
if (!taskColumnNames.has('interaction_mode')) {
  db.exec("ALTER TABLE tasks ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'ask_user'");
}
if (!taskColumnNames.has('source_message_id')) {
  db.exec('ALTER TABLE tasks ADD COLUMN source_message_id TEXT');
}
if (!taskColumnNames.has('created_from')) {
  db.exec('ALTER TABLE tasks ADD COLUMN created_from TEXT');
}
if (!taskColumnNames.has('deleted_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN deleted_at INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)');

const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
const messageColumnNames = new Set(messageColumns.map((column) => column.name));
if (!messageColumnNames.has('layer')) {
  db.exec("ALTER TABLE messages ADD COLUMN layer TEXT NOT NULL DEFAULT 'chat'");
}

db.exec(`
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  layer TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_task_events_room_created ON task_events(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_layer ON task_events(task_id, layer, seq);

CREATE TABLE IF NOT EXISTS task_executors (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  room_agent_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  acp_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  acp_session_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (acp_session_handoff_pending IN (0, 1)),
  acp_session_handoff_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE,
  UNIQUE(task_id, room_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_task_executors_task ON task_executors(task_id, status);
CREATE INDEX IF NOT EXISTS idx_task_executors_room_agent ON task_executors(room_agent_id, updated_at);
`);

const taskExecutorColumns = db.prepare('PRAGMA table_info(task_executors)').all() as { name: string }[];
const taskExecutorColumnNames = new Set(taskExecutorColumns.map((column) => column.name));
if (!taskExecutorColumnNames.has('acp_session_handoff_pending')) {
  db.exec('ALTER TABLE task_executors ADD COLUMN acp_session_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (acp_session_handoff_pending IN (0, 1))');
}
if (!taskExecutorColumnNames.has('acp_session_handoff_reason')) {
  db.exec('ALTER TABLE task_executors ADD COLUMN acp_session_handoff_reason TEXT');
}

const memoryColumns = db.prepare('PRAGMA table_info(memory_entries)').all() as { name: string }[];
const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
if (!memoryColumnNames.has('archived')) {
  db.exec('ALTER TABLE memory_entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}
const memoryCreateSql = (db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
).get() as { sql: string } | undefined)?.sql ?? '';
if (
  memoryCreateSql.includes('project_id TEXT NOT NULL') ||
  !memoryCreateSql.includes("'global'")
) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_memory_entries_validate_insert;
    DROP TRIGGER IF EXISTS trg_memory_entries_validate_update;
    DROP INDEX IF EXISTS idx_memory_task_source;
    DROP INDEX IF EXISTS idx_memory_room_source;
    DROP INDEX IF EXISTS idx_memory_project_source;
    DROP INDEX IF EXISTS idx_memory_global_source;
    DROP INDEX IF EXISTS idx_memory_project;
    DROP INDEX IF EXISTS idx_memory_room;
    DROP INDEX IF EXISTS idx_memory_agent;
    DROP INDEX IF EXISTS idx_memory_task;

    CREATE TABLE memory_entries_next (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      room_id TEXT,
      room_agent_id TEXT,
      task_id TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'room', 'agent', 'task')),
      memory_type TEXT NOT NULL CHECK (
        memory_type IN ('decision', 'fact', 'preference', 'lesson', 'task_summary', 'artifact_summary')
      ),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'message', 'workflow', 'task')),
      source_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CHECK (
        (scope = 'global' AND project_id IS NULL AND room_id IS NULL AND room_agent_id IS NULL AND task_id IS NULL)
        OR (scope = 'project' AND project_id IS NOT NULL AND room_id IS NULL AND room_agent_id IS NULL AND task_id IS NULL)
        OR (scope = 'room' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NULL)
        OR (scope = 'agent' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NOT NULL AND task_id IS NULL)
        OR (scope = 'task' AND project_id IS NOT NULL AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NOT NULL)
      )
    );

    INSERT INTO memory_entries_next (
      id, project_id, room_id, room_agent_id, task_id, scope, memory_type, title,
      content, source_type, source_id, pinned, archived, created_at, updated_at
    )
    SELECT
      id, project_id, room_id, room_agent_id, task_id, scope, memory_type, title,
      content, source_type, source_id, pinned, COALESCE(archived, 0), created_at, updated_at
    FROM memory_entries;

    DROP TABLE memory_entries;
    ALTER TABLE memory_entries_next RENAME TO memory_entries;
  `);
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_room ON memory_entries(room_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(room_agent_id, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_task ON memory_entries(task_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_task_source
  ON memory_entries(task_id, source_type, source_id)
  WHERE task_id IS NOT NULL AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_room_source
  ON memory_entries(room_id, source_type, source_id)
  WHERE scope = 'room' AND room_id IS NOT NULL AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_project_source
  ON memory_entries(project_id, source_type, source_id)
  WHERE scope = 'project' AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_global_source
  ON memory_entries(source_type, source_id)
  WHERE scope = 'global' AND source_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_memory_entries_validate_insert
BEFORE INSERT ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'memory room_id does not belong to project_id')
  WHERE NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = NEW.room_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to project_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      JOIN rooms ON rooms.id = room_agents.room_id
      WHERE room_agents.id = NEW.room_agent_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to room_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      WHERE room_agents.id = NEW.room_agent_id AND room_agents.room_id = NEW.room_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to project_id')
  WHERE NEW.task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to room_id')
  WHERE NEW.task_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.room_id = NEW.room_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_entries_validate_update
BEFORE UPDATE OF project_id, room_id, room_agent_id, task_id, scope ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'memory room_id does not belong to project_id')
  WHERE NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = NEW.room_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to project_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      JOIN rooms ON rooms.id = room_agents.room_id
      WHERE room_agents.id = NEW.room_agent_id AND rooms.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory room_agent_id does not belong to room_id')
  WHERE NEW.room_agent_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_agents
      WHERE room_agents.id = NEW.room_agent_id AND room_agents.room_id = NEW.room_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to project_id')
  WHERE NEW.task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id
    );

  SELECT RAISE(ABORT, 'memory task_id does not belong to room_id')
  WHERE NEW.task_id IS NOT NULL
    AND NEW.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = NEW.task_id AND tasks.room_id = NEW.room_id
    );
END;
`);

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all() as { name: string }[];
const settingsColumnNames = new Set(settingsColumns.map((column) => column.name));
if (!settingsColumnNames.has('auto_distill_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN auto_distill_enabled INTEGER CHECK (auto_distill_enabled IN (0, 1))');
}
if (!settingsColumnNames.has('default_workflow_definition_id')) {
  db.exec('ALTER TABLE settings ADD COLUMN default_workflow_definition_id TEXT');
}
if (!settingsColumnNames.has('langchain_planner_model')) {
  db.exec('ALTER TABLE settings ADD COLUMN langchain_planner_model TEXT');
}
if (!settingsColumnNames.has('openai_api_key')) {
  db.exec('ALTER TABLE settings ADD COLUMN openai_api_key TEXT');
}
if (!settingsColumnNames.has('openai_base_url')) {
  db.exec('ALTER TABLE settings ADD COLUMN openai_base_url TEXT');
}
if (!settingsColumnNames.has('active_ai_config_id')) {
  db.exec('ALTER TABLE settings ADD COLUMN active_ai_config_id TEXT');
}
if (!settingsColumnNames.has('superpowers_bootstrap_owner')) {
  db.exec(`
    ALTER TABLE settings ADD COLUMN superpowers_bootstrap_owner TEXT
      CHECK (superpowers_bootstrap_owner IN ('project', 'provider', 'disabled'))
  `);
}
if (!settingsColumnNames.has('workspace_excluded_dirs')) {
  db.exec('ALTER TABLE settings ADD COLUMN workspace_excluded_dirs TEXT');
}

if (!roomAgentColumnNames.has('memory_max_context_chars')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN memory_max_context_chars INTEGER');
}

db.exec(`
UPDATE projects
SET message_routing_mode = 'fallback_reply',
    fallback_agent_id = COALESCE(NULLIF(TRIM(fallback_agent_id), ''), 'planner')
WHERE message_routing_mode = 'fallback_route'
   OR (message_routing_mode = 'fallback_reply' AND (fallback_agent_id IS NULL OR TRIM(fallback_agent_id) = ''));

UPDATE settings
SET message_routing_mode = 'fallback_reply',
    fallback_agent_id = COALESCE(NULLIF(TRIM(fallback_agent_id), ''), 'planner')
WHERE message_routing_mode = 'fallback_route'
   OR (message_routing_mode = 'fallback_reply' AND (fallback_agent_id IS NULL OR TRIM(fallback_agent_id) = ''));
`);

db.exec(`
INSERT OR IGNORE INTO settings (
  scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, auto_distill_enabled, default_workflow_definition_id, updated_at
)
SELECT
  'project',
  id,
  message_routing_mode,
  fallback_agent_id,
  NULL,
  NULL,
  NULL,
  updated_at
FROM projects
WHERE message_routing_mode <> 'mentions_only' OR fallback_agent_id IS NOT NULL
`);

export function now(): number {
  return Date.now();
}
