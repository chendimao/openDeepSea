import {
  getProjectOverview,
  getRoomOverview,
  getSystemOverview,
  listProjectFiles,
  listRoomAgents,
  listRoomFiles,
  listRoomTasks,
} from './system-context.js';

type CommandResult = unknown;

export function runSystemContextCli(argv: string[]): CommandResult {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return {
      commands: [
        'system-overview',
        'project-overview <projectId>',
        'room-overview <roomId>',
        'list-room-tasks <roomId>',
        'list-room-agents <roomId>',
        'list-files --project <projectId>',
        'list-files --room <roomId>',
      ],
    };
  }

  if (command === 'system-overview') return getSystemOverview();
  if (command === 'project-overview') return getProjectOverview(requireArg(args[0], 'projectId'));
  if (command === 'room-overview') return getRoomOverview(requireArg(args[0], 'roomId'));
  if (command === 'list-room-tasks') return listRoomTasks(requireArg(args[0], 'roomId'));
  if (command === 'list-room-agents') return listRoomAgents(requireArg(args[0], 'roomId'));
  if (command === 'list-files') {
    const projectId = readOption(args, '--project');
    const roomId = readOption(args, '--room');
    if (projectId && roomId) throw new Error('choose either --project or --room');
    if (projectId) return listProjectFiles(projectId);
    if (roomId) return listRoomFiles(roomId);
    throw new Error('list-files requires --project <projectId> or --room <roomId>');
  }

  throw new Error(`unknown command: ${command}`);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return requireArg(args[index + 1], name);
}

function main(): void {
  try {
    const result = runSystemContextCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: (err as Error).message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('system-context-cli.ts') || process.argv[1]?.endsWith('system-context-cli.js')) {
  main();
}
