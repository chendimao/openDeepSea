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
  status TEXT NOT NULL,
  room_agent_id TEXT,
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

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
const taskColumnNames = new Set(taskColumns.map((column) => column.name));
if (!taskColumnNames.has('interaction_mode')) {
  db.exec("ALTER TABLE tasks ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'ask_user'");
}

db.exec(`
INSERT OR IGNORE INTO settings (
  scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, updated_at
)
SELECT
  'project',
  id,
  message_routing_mode,
  fallback_agent_id,
  NULL,
  updated_at
FROM projects
WHERE message_routing_mode <> 'mentions_only' OR fallback_agent_id IS NOT NULL
`);

export function now(): number {
  return Date.now();
}
