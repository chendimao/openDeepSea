import { execFile } from 'node:child_process';
import type { OpenClawAgentInfo } from './gateway.js';

interface OpenClawConfigAgent {
  id?: string;
  name?: string;
  description?: string;
  workspace?: string;
  identity?: {
    name?: string;
  };
}

export function listOpenClawAgentsFromCli(timeoutMs = 5000): Promise<OpenClawAgentInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['config', 'get', 'agents.list', '--json'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        try {
          const raw = JSON.parse(stdout) as OpenClawConfigAgent[];
          if (!Array.isArray(raw)) {
            reject(new Error('OpenClaw agents.list is not an array'));
            return;
          }
          resolve(
            raw
              .filter((agent) => typeof agent.id === 'string' && agent.id.length > 0)
              .map((agent) => ({
                id: agent.id!,
                name: agent.name ?? agent.identity?.name ?? agent.id,
                description: agent.description,
                workspace: agent.workspace,
              })),
          );
        } catch (parseError) {
          reject(new Error(`Failed to parse OpenClaw agents.list: ${(parseError as Error).message}`));
        }
      },
    );
  });
}
