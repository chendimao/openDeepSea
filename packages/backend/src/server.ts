import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { bindGatewayEvents } from './dispatcher.js';
import { gatewayClient } from './openclaw/gateway.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { router } from './routes.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { wsHub } from './ws-hub.js';
import type { WsClientEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 7330);

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
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

const orphanedRuns = agentRunRepo.failActiveRuns('Backend restarted before agent run completed');
if (orphanedRuns > 0) {
  console.warn(`[agent-runs] Marked ${orphanedRuns} orphaned active run(s) as failed`);
}
const orphanedSteps = workflowOrchestrator.recoverOrphanedSteps('Backend restarted before workflow step completed');
if (orphanedSteps > 0) {
  console.warn(`[workflows] Marked ${orphanedSteps} orphaned running step(s) as failed`);
}

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
