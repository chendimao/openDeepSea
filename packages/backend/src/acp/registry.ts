import type { AcpBackend } from '../types.js';

export interface AcpAgentServerConfig {
  provider: Extract<AcpBackend, 'claudecode' | 'codex' | 'opencode'>;
  command: string;
  args: string[];
  transport: 'stdio';
  enabled: boolean;
}

export function getDefaultAcpAgentServers(): AcpAgentServerConfig[] {
  return [
    {
      provider: 'claudecode',
      command: 'npx',
      args: ['@agentclientprotocol/claude-agent-acp'],
      transport: 'stdio',
      enabled: true,
    },
    {
      provider: 'codex',
      command: 'npx',
      args: ['@zed-industries/codex-acp'],
      transport: 'stdio',
      enabled: true,
    },
    {
      provider: 'opencode',
      command: 'opencode',
      args: ['acp'],
      transport: 'stdio',
      enabled: true,
    },
  ];
}
