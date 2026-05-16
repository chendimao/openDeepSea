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
  message_routing_mode TEXT NOT NULL DEFAULT 'mentions_only',
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
  langchain_planner_model TEXT,
  openai_api_key TEXT,
  openai_base_url TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms(project_id);

CREATE TABLE IF NOT EXISTS room_agents (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT,
  joined_at INTEGER NOT NULL,
  acp_enabled INTEGER NOT NULL DEFAULT 0,
  acp_backend TEXT,
  acp_session_id TEXT,
  acp_session_label TEXT,
  acp_permission_mode TEXT NOT NULL DEFAULT 'bypass',
  acp_writable_dirs TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  default_runtime TEXT NOT NULL DEFAULT 'openclaw',
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
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
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

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
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (room_agent_id) REFERENCES room_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_room ON agent_runs(room_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

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

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  room_id TEXT,
  room_agent_id TEXT,
  task_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'room', 'agent', 'task')),
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
    (scope = 'project' AND room_id IS NULL AND room_agent_id IS NULL AND task_id IS NULL)
    OR (scope = 'room' AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NULL)
    OR (scope = 'agent' AND room_id IS NOT NULL AND room_agent_id IS NOT NULL AND task_id IS NULL)
    OR (scope = 'task' AND room_id IS NOT NULL AND room_agent_id IS NULL AND task_id IS NOT NULL)
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
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
const projectColumnNames = new Set(projectColumns.map((column) => column.name));
if (!projectColumnNames.has('message_routing_mode')) {
  db.exec("ALTER TABLE projects ADD COLUMN message_routing_mode TEXT NOT NULL DEFAULT 'mentions_only'");
}
if (!projectColumnNames.has('fallback_agent_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN fallback_agent_id TEXT');
}

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
  db.exec("ALTER TABLE room_agents ADD COLUMN default_runtime TEXT NOT NULL DEFAULT 'openclaw'");
}

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

const memoryColumns = db.prepare('PRAGMA table_info(memory_entries)').all() as { name: string }[];
const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
if (!memoryColumnNames.has('archived')) {
  db.exec('ALTER TABLE memory_entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all() as { name: string }[];
const settingsColumnNames = new Set(settingsColumns.map((column) => column.name));
if (!settingsColumnNames.has('auto_distill_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN auto_distill_enabled INTEGER CHECK (auto_distill_enabled IN (0, 1))');
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

if (!roomAgentColumnNames.has('memory_max_context_chars')) {
  db.exec('ALTER TABLE room_agents ADD COLUMN memory_max_context_chars INTEGER');
}

db.exec(`
INSERT OR IGNORE INTO settings (
  scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, auto_distill_enabled, updated_at
)
SELECT
  'project',
  id,
  message_routing_mode,
  fallback_agent_id,
  NULL,
  NULL,
  updated_at
FROM projects
WHERE message_routing_mode <> 'mentions_only' OR fallback_agent_id IS NOT NULL
`);

export function now(): number {
  return Date.now();
}
