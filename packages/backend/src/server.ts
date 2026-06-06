import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { getAdapter } from './acp/index.js';
import { getLocalAccessToken, isTrustedOrigin } from './local-access.js';
import { projectRepo } from './repos/projects.js';
import { router } from './routes.js';
import {
  ensureMessageUploadDir,
  ensureProjectFileUploadRoot,
  messageUploadDir,
  messageUploadRoute,
  projectFileUploadRoot,
  projectFileUploadRoute,
} from './uploads.js';
import { recoverWorkflowStartupOrphans, startWorkflowMonitorService } from './workflows/workflow-monitor-service.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { runSkillsShStartupUpdateCheck } from './skills/update-service.js';
import { startProviderSuperpowersStartupInstall } from './provider-superpowers.js';
import { handleSessionSocketEvent } from './session-socket-controller.js';
import { validateWebSocketAccess } from './websocket-access.js';
import { wsHub } from './ws-hub.js';
import type { AgentRun, WsClientEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 7330);
const configuredLocalAccessToken = process.env.OPENDEEPSEA_LOCAL_TOKEN?.trim();
const localAccessToken = getLocalAccessToken();

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || isTrustedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));
app.use(express.json({ limit: '4mb' }));
await ensureMessageUploadDir();
await ensureProjectFileUploadRoot();
app.use(messageUploadRoute, express.static(messageUploadDir, {
  fallthrough: false,
  immutable: true,
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use(projectFileUploadRoute, express.static(projectFileUploadRoot, {
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
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: ({ req }, done) => {
    const access = validateWebSocketAccess(req);
    done(access.ok, access.ok ? undefined : access.status, access.ok ? undefined : access.reason);
  },
});

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
    else if (event.type === 'session:subscribe') wsHub.subscribeSession(event.sessionId, socket);
    else if (event.type === 'session:unsubscribe') wsHub.unsubscribeSession(event.sessionId, socket);
    else if (handleSessionSocketEvent(socket, event)) return;
  });
  socket.on('close', () => wsHub.removeSocket(socket));
});

httpServer.listen(PORT, () => {
  console.log(`[server] backend listening on :${PORT}`);
  if (!configuredLocalAccessToken) {
    console.log(`[server] local access token: ${localAccessToken}`);
  }
  void startWorkflowMonitoringAfterStartupRecovery();
  void runSkillsShStartupUpdateCheck();
  if (process.env.OPENDEEPSEA_PROVIDER_SUPERPOWERS_AUTO_INSTALL !== '0') {
    void startProviderSuperpowersStartupInstall().catch((err) => {
      console.warn(`[superpowers] provider startup install failed: ${(err as Error).message}`);
    });
  }
});

async function buildInterruptedRunReason(run: AgentRun): Promise<string> {
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

async function startWorkflowMonitoringAfterStartupRecovery(): Promise<void> {
  try {
    const recovered = await recoverWorkflowStartupOrphans({ buildInterruptedRunReason });
    if (recovered.interruptedAgentRuns > 0) {
      console.warn(`[agent-runs] Marked ${recovered.interruptedAgentRuns} orphaned active run(s) as interrupted`);
    }
    if (recovered.orphanedSteps > 0) {
      console.warn(`[workflows] Marked ${recovered.orphanedSteps} orphaned running step(s) as interrupted`);
    }
    if (recovered.incidents > 0) {
      console.warn(`[workflow-monitor] Detected ${recovered.incidents} startup workflow incident(s)`);
    }
  } catch (err) {
    console.warn(`[workflow-monitor] startup recovery failed: ${(err as Error).message}`);
  }

  const monitorService = startWorkflowMonitorService();
  try {
    await monitorService.runOnce();
  } catch (err) {
    console.warn(`[workflow-monitor] initial scan failed: ${(err as Error).message}`);
  }
}
