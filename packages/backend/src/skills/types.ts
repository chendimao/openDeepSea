export type SkillRuntimeScope = 'planner' | 'model_chat' | 'workflow' | 'memory' | 'review';
export type SkillSourceType = 'local_directory' | 'git_repo' | 'manual' | 'skills_sh';
export type SkillTriggerMode = 'manual' | 'keyword' | 'always_for_scope';
export type SkillBindingScope = 'system' | 'project' | 'room' | 'agent';
export type SkillExecutableRuntime = 'node' | 'python' | 'shell';
export type SkillUpdateCheckMode = 'off' | 'startup' | 'manual' | 'scheduled';
export type SkillUpdateApplyMode = 'prompt' | 'download' | 'auto';

export interface SkillPermissions {
  filesystem: 'project';
  network: boolean;
  commands: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  source_type: SkillSourceType;
  source_uri: string | null;
  install_path: string;
  manifest_path: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords: string[];
  enabled: 0 | 1;
  priority: number;
  checksum: string | null;
  package_version: string | null;
  package_revision: string | null;
  runtime_type: SkillExecutableRuntime | null;
  entrypoint: string | null;
  permissions: SkillPermissions | null;
  install_source_label: string | null;
  update_check_mode: SkillUpdateCheckMode;
  update_apply_mode: SkillUpdateApplyMode;
  last_update_checked_at: number | null;
  available_version: string | null;
  available_revision: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillBinding {
  id: string;
  skill_id: string;
  scope: SkillBindingScope;
  scope_id: string;
  enabled: 0 | 1;
  priority_override: number | null;
  created_at: number;
  updated_at: number;
}

export interface EffectiveSkillBinding {
  skill: Skill;
  binding: SkillBinding;
  effectivePriority: number;
  scopeSpecificity: number;
}

export type SkillRunInvoker = 'workflow' | 'agent' | 'manual';
export type SkillRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SkillRun {
  id: string;
  skill_id: string;
  project_id: string | null;
  room_id: string | null;
  agent_id: string | null;
  invoked_by: SkillRunInvoker;
  runtime: SkillExecutableRuntime | 'shell';
  entrypoint: string;
  input: unknown;
  allowed_paths: string[];
  network_enabled: 0 | 1;
  status: SkillRunStatus;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  result: unknown;
  error: string | null;
  created_at: number;
  updated_at: number;
}
