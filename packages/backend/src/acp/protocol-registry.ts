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

const CODEX_REASONING_EFFORT_ENV = 'OPENCLAW_ACP_CODEX_REASONING_EFFORT';
const CODEX_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

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
    const char = input[index] ?? '';

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
  const resolvedArgs = appendBackendArgs(backend, args, env);

  return {
    backend,
    mode,
    command,
    args: resolvedArgs,
    env: buildSuperpowersEnv(env),
    transport: 'stdio',
    enabled: mode !== 'legacy',
  };
}

function buildSuperpowersEnv(env: AcpProtocolEnv): Record<string, string> {
  const owner = env.OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER;
  // Best-effort guard: provider CLIs may ignore this unless their Superpowers plugin
  // honors SUPERPOWERS_BOOTSTRAP_DISABLED. Project prompt injection still has
  // duplicate-bootstrap detection as the final guard.
  if (owner === 'project' || owner === 'disabled') {
    return {
      OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: owner,
      SUPERPOWERS_BOOTSTRAP_DISABLED: '1',
    };
  }
  if (owner === 'provider') {
    return {
      OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: 'provider',
    };
  }
  return {};
}

function appendBackendArgs(
  backend: AcpBackend,
  args: string[],
  env: AcpProtocolEnv,
): string[] {
  if (backend !== 'codex') return args;

  const reasoningEffort = readCodexReasoningEffort(env[CODEX_REASONING_EFFORT_ENV]);
  if (!reasoningEffort) return args;
  if (args.some((arg) => arg.includes('model_reasoning_effort'))) return args;

  return [...args, '-c', `model_reasoning_effort=${reasoningEffort}`];
}

function readCodexReasoningEffort(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'off' || normalized === 'none') return null;
  return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
}
