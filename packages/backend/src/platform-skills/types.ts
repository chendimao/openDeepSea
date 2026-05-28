export type PlatformSkillProvider = 'codex' | 'claudecode' | 'opencode';
export type PlatformSkillInstallMode = 'copy' | 'symlink' | 'unknown';

export interface PlatformSkillDefinition {
  provider: PlatformSkillProvider;
  label: string;
  root: string;
}

export interface PlatformSkillSummary {
  provider: PlatformSkillProvider;
  label: string;
  root: string;
  rootExists: boolean;
  rootWritable: boolean;
  installedCount: number;
  issues: string[];
}

export interface PlatformSkill {
  provider: PlatformSkillProvider;
  name: string;
  description: string | null;
  path: string;
  manifestPath: string | null;
  installMode: PlatformSkillInstallMode;
  sourceLabel: string | null;
  version: string | null;
  lastModifiedAt: number | null;
  valid: boolean;
  issues: string[];
}

export interface InstallPlatformSkillInput {
  installLabel: string;
  targets: PlatformSkillProvider[];
  installMode: Exclude<PlatformSkillInstallMode, 'unknown'>;
}

export interface ImportLocalPlatformSkillInput {
  path: string;
  targets: PlatformSkillProvider[];
  installMode: Exclude<PlatformSkillInstallMode, 'unknown'>;
}
