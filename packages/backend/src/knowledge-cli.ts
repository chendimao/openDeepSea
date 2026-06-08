import {
  listKnowledgeSourcesForAgent,
  readKnowledgeChunkForAgent,
  readKnowledgeSourceSummaryForAgent,
  searchKnowledgeForAgent,
  type KnowledgeAgentUsage,
} from './knowledge-rag.js';

type EnvLike = Record<string, string | undefined>;

export function runKnowledgeCli(argv: string[], env: EnvLike = process.env): unknown {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return {
      commands: [
        'search --project <projectId> --query <query> [--room <roomId>] [--limit 5]',
        'read-chunk --project <projectId> --chunk <chunkId>',
        'source-summary --project <projectId> --source <sourceId> [--mode auto|full|summary]',
        'list-sources --project <projectId> [--room <roomId>] [--limit 20]',
      ],
    };
  }

  if (command === 'search') {
    return searchKnowledgeForAgent({
      projectId: readRequiredOption(args, '--project'),
      roomId: readOption(args, '--room'),
      query: readRequiredOption(args, '--query'),
      limit: readNumberOption(args, '--limit'),
      usage: readUsageFromEnv(env),
    });
  }

  if (command === 'read-chunk') {
    return readKnowledgeChunkForAgent({
      projectId: readRequiredOption(args, '--project'),
      chunkId: readRequiredOption(args, '--chunk'),
      usage: readUsageFromEnv(env),
    });
  }

  if (command === 'source-summary') {
    return readKnowledgeSourceSummaryForAgent({
      projectId: readRequiredOption(args, '--project'),
      sourceId: readRequiredOption(args, '--source'),
      mode: readSummaryMode(readOption(args, '--mode')),
      usage: readUsageFromEnv(env),
    });
  }

  if (command === 'list-sources') {
    return listKnowledgeSourcesForAgent({
      projectId: readRequiredOption(args, '--project'),
      roomId: readOption(args, '--room'),
      limit: readNumberOption(args, '--limit'),
    });
  }

  throw new Error(`unknown command: ${command}`);
}

function readUsageFromEnv(env: EnvLike): KnowledgeAgentUsage | null {
  const agentRunId = env.OPENDEEPSEA_AGENT_RUN_ID?.trim();
  if (agentRunId) {
    return {
      refType: 'agent_run',
      refId: agentRunId,
      metadata: readUsageMetadata(env),
    };
  }
  const sessionRunId = env.OPENDEEPSEA_SESSION_RUN_ID?.trim();
  if (sessionRunId) {
    return {
      refType: 'session_run',
      refId: sessionRunId,
      metadata: readUsageMetadata(env),
    };
  }
  return null;
}

function readUsageMetadata(env: EnvLike): Record<string, unknown> {
  return {
    project_id: env.OPENDEEPSEA_PROJECT_ID ?? null,
    room_id: env.OPENDEEPSEA_ROOM_ID ?? null,
    session_id: env.OPENDEEPSEA_SESSION_ID ?? null,
    agent_id: env.OPENDEEPSEA_AGENT_ID ?? null,
  };
}

function readSummaryMode(value: string | null): 'auto' | 'full' | 'summary' | undefined {
  if (value === null) return undefined;
  if (value === 'auto' || value === 'full' || value === 'summary') return value;
  throw new Error('--mode must be auto, full, or summary');
}

function readRequiredOption(args: string[], name: string): string {
  const value = readOption(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1]?.trim();
  return value || null;
}

function readNumberOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function main(): void {
  try {
    const result = runKnowledgeCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: (err as Error).message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('knowledge-cli.ts') || process.argv[1]?.endsWith('knowledge-cli.js')) {
  main();
}
