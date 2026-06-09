import type { AcpBackend } from '../types.js';
import { getDefaultCodexAcpInvocation } from './protocol-registry.js';

export interface AcpAgentServerConfig {
  provider: Extract<AcpBackend, 'claudecode' | 'codex' | 'opencode'>;
  command: string;
  args: string[];
  transport: 'stdio';
  enabled: boolean;
}

export function getDefaultAcpAgentServers(): AcpAgentServerConfig[] {
  const codexInvocation = getDefaultCodexAcpInvocation();

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
      command: codexInvocation.command,
      args: codexInvocation.args,
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
