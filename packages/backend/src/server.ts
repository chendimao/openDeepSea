import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { getAdapter } from './acp/index.js';
import { bindGatewayEvents } from './dispatcher.js';
import { gatewayClient } from './openclaw/gateway.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { projectRepo } from './repos/projects.js';
import { router } from './routes.js';
import { ensureMessageUploadDir, messageUploadDir, messageUploadRoute } from './uploads.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { wsHub } from './ws-hub.js';
import type { WsClientEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 7330);

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
await ensureMessageUploadDir();
app.use(messageUploadRoute, express.static(messageUploadDir, {
  fallthrough: false,
  immutable: true,
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use('/api', router);

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let event: WsClientEvent;
    try {
      event = JSON.parse(raw.toString()) as WsClientEvent;
    } catch {
      return;
    }
    if (event.type === 'subscribe') wsHub.subscribe(event.roomId, socket);
    else if (event.type === 'unsubscribe') wsHub.unsubscribe(event.roomId, socket);
  });
  socket.on('close', () => wsHub.removeSocket(socket));
});

bindGatewayEvents();

const orphanedSteps = workflowOrchestrator.recoverOrphanedSteps('Backend restarted before workflow step completed');
if (orphanedSteps > 0) {
  console.warn(`[workflows] Marked ${orphanedSteps} orphaned running step(s) as failed`);
}
void recoverInterruptedAgentRuns();

// Try to connect to OpenClaw gateway in background; don't crash if unavailable.
gatewayClient
  .connect()
  .then(() => {
    console.log('[openclaw] Gateway connected');
  })
  .catch((err) => {
    console.warn(`[openclaw] Gateway not connected: ${(err as Error).message}`);
  });

httpServer.listen(PORT, () => {
  console.log(`[server] OpenClaw Room backend listening on :${PORT}`);
});

async function recoverInterruptedAgentRuns(): Promise<void> {
  const activeRuns = agentRunRepo.listActive();
  if (activeRuns.length === 0) return;

  let interrupted = 0;
  for (const run of activeRuns) {
    const reason = await buildInterruptedRunReason(run);
    const updated = agentRunRepo.interruptRun(run.id, reason);
    if (updated) {
      wsHub.broadcast(updated.room_id, {
        type: 'agent_run:updated',
        roomId: updated.room_id,
        run: updated,
      });
      interrupted++;
    }
  }
  if (interrupted > 0) {
    console.warn(`[agent-runs] Marked ${interrupted} orphaned active run(s) as interrupted`);
  }
}

async function buildInterruptedRunReason(run: { backend: string; acp_session_id: string | null; workflow_run_id: string | null }): Promise<string> {
  const base = 'Backend restarted before agent run completed';
  if (!run.acp_session_id || !['claudecode', 'opencode', 'codex'].includes(run.backend)) {
    return `${base}; no resumable ACP session id was recorded.`;
  }
  if (!run.workflow_run_id) return `${base}; ACP session ${run.acp_session_id} can be resumed manually.`;

  const detail = workflowOrchestrator.detail(run.workflow_run_id);
  if (!detail) return `${base}; ACP session ${run.acp_session_id} can be resumed manually.`;
  const project = projectRepo.get(detail.run.project_id);
  if (!project) return `${base}; ACP session ${run.acp_session_id} can be resumed manually.`;

  try {
    const sessions = await getAdapter(run.backend as 'claudecode' | 'opencode' | 'codex').listSessions(project.path);
    const hasSession = sessions.some((session) => session.sessionId === run.acp_session_id);
    return hasSession
      ? `${base}; ACP session ${run.acp_session_id} still exists and the workflow can retry from it.`
      : `${base}; ACP session ${run.acp_session_id} was not found, retry will start a fresh invocation.`;
  } catch (err) {
    return `${base}; ACP session lookup failed: ${(err as Error).message}`;
  }
}
