import type { AcpBackend } from '../types.js';

export type AcpProtocolMode = 'auto' | 'protocol' | 'legacy';

export interface AcpServerConfig {
  backend: AcpBackend;
  mode: AcpProtocolMode;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: 'stdio';
  enabled: boolean;
}

type AcpProtocolEnv = Partial<Record<string, string | undefined>>;

export const DEFAULT_COMMANDS: Record<AcpBackend, string> = {
  codex: 'npx @zed-industries/codex-acp',
  claudecode: 'npx @agentclientprotocol/claude-agent-acp',
  opencode: 'opencode acp',
};

export const COMMAND_ENV: Record<AcpBackend, string> = {
  codex: 'OPENCLAW_ACP_CODEX_COMMAND',
  claudecode: 'OPENCLAW_ACP_CLAUDECODE_COMMAND',
  opencode: 'OPENCLAW_ACP_OPENCODE_COMMAND',
};

export function parseAcpMode(value: string | undefined): AcpProtocolMode {
  if (value === 'protocol' || value === 'legacy' || value === 'auto') {
    return value;
  }

  return 'auto';
}

export function splitCommand(input: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '\\' && quote !== "'") {
      tokenStarted = true;
      const next = input[index + 1];

      if (next === undefined) {
        current += char;
      } else {
        current += next;
        index += 1;
      }

      continue;
    }

    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === quote) {
      quote = null;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (tokenStarted) {
        parts.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    tokenStarted = true;
    current += char;
  }

  if (quote !== null) {
    throw new Error('ACP command has unmatched quote');
  }

  if (tokenStarted) {
    parts.push(current);
  }

  const [command = '', ...args] = parts;

  if (command.length === 0) {
    throw new Error('ACP command is empty');
  }

  return { command, args };
}

export function getAcpServerConfig(
  backend: AcpBackend,
  env: AcpProtocolEnv = process.env,
): AcpServerConfig {
  const mode = parseAcpMode(env.OPENCLAW_ACP_MODE);
  const commandText = env[COMMAND_ENV[backend]]?.trim() || DEFAULT_COMMANDS[backend];
  const { command, args } = splitCommand(commandText);

  return {
    backend,
    mode,
    command,
    args,
    transport: 'stdio',
    enabled: mode !== 'legacy',
  };
}
