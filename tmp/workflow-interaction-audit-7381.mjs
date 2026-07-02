import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const backend = 'http://127.0.0.1:7381';
const frontend = 'http://127.0.0.1:5195';
const token = 'workflow-audit-token-7381';
const outDir = 'output/playwright';
const runStamp = Date.now();
const workspaceRoot = `/tmp/opendeepsea-workflow-interaction-audit-7381/browser-project-${runStamp}`;

mkdirSync(outDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });

async function api(path, init = {}) {
  const res = await fetch(`${backend}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function pageApi(page, path, init = {}) {
  return page.evaluate(
    async ({ path: requestPath, init: requestInit }) => {
      const res = await fetch(requestPath, {
        ...requestInit,
        headers: {
          'Content-Type': 'application/json',
          ...(requestInit.headers ?? {}),
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${requestInit.method ?? 'GET'} ${requestPath} failed: ${res.status} ${text}`);
      return text ? JSON.parse(text) : null;
    },
    { path, init },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeDetail(detail) {
  return {
    workflowController: detail.workflowController ?? null,
    artifacts: (detail.workflowArtifacts ?? []).map((artifact) => ({
      id: artifact.id,
      type: artifact.artifact_type,
      status: artifact.status,
      title: artifact.title,
      version: artifact.version,
    })),
    gates: (detail.workflowGates ?? []).map((gate) => ({
      kind: gate.kind,
      status: gate.status,
      artifactVersionId: gate.artifact_version_id,
    })),
    messages: (detail.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      senderName: message.sender_name,
      content: message.content.slice(0, 180),
      metadata: safeJson(message.metadata),
    })).slice(-8),
  };
}

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function waitForSession(sessionId, predicate, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastDetail = await api(`/api/sessions/${sessionId}`);
    if (predicate(lastDetail)) return lastDetail;
    await sleep(800);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; last=${JSON.stringify(summarizeDetail(lastDetail))}`);
}

async function waitForPageSession(page, sessionId, predicate, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastDetail = await pageApi(page, `/api/sessions/${sessionId}`);
    if (predicate(lastDetail)) return lastDetail;
    await sleep(800);
  }
  throw new Error(`Timed out waiting for page session ${sessionId}; last=${JSON.stringify(summarizeDetail(lastDetail))}`);
}

async function createSession(projectId, title) {
  return api(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ title, mode: 'ask', provider: 'codex' }),
  });
}

async function openSessionPage(context, projectId, sessionId, viewport = { width: 1280, height: 1024 }) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    }
  });
  await page.goto(`${frontend}/projects/${projectId}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('opendeepsea.localToken', value), token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-session-composer-textarea="true"], textarea.deepsea-composer__textarea', { timeout: 20_000 });
  return page;
}

async function sendViaComposer(page, text) {
  const textarea = page.locator('[data-session-composer-textarea="true"], textarea.deepsea-composer__textarea').first();
  await textarea.fill(text);
  await page.locator('button[aria-label="发送"], .deepsea-send-button').first().click();
}

function hasPendingGate(detail) {
  return (detail.workflowGates ?? []).some((gate) => gate.status === 'pending' && gate.artifact_version_id);
}

async function waitForPendingGateButtons(page, sessionId, timeoutMs = 120_000) {
  await waitForPageSession(page, sessionId, (detail) => hasPendingGate(detail), timeoutMs);
  const approve = page.locator('.deepsea-message--workflow [data-workflow-artifact-action="approve"]').first();
  const requestChange = page.locator('.deepsea-message--workflow [data-workflow-artifact-action="request-change"]').first();
  await approve.waitFor({ state: 'visible', timeout: 30_000 });
  await requestChange.waitFor({ state: 'visible', timeout: 30_000 });
  return { approve, requestChange };
}

async function collectInteractionDom(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;
    const workflowMessages = document.querySelectorAll('[data-workflow-chat-message="true"]');
    const finish = document.querySelector('[data-workflow-finish-branch-decision="true"]');
    const approveButtons = document.querySelectorAll('.deepsea-message--workflow [data-workflow-artifact-action="approve"]');
    const requestButtons = document.querySelectorAll('.deepsea-message--workflow [data-workflow-artifact-action="request-change"]');
    const overflowNodes = [...document.querySelectorAll(
      '[data-workflow-chat-message="true"], [data-run-flow-capsule="true"], .deepsea-workflow-flow, .deepsea-workflow-state-step, .deepsea-workflow-event',
    )].map((node) => {
      const element = node;
      return {
        className: typeof element.className === 'string' ? element.className : '',
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    }).filter((item) => item.scrollWidth > item.clientWidth + 2 || item.scrollHeight > item.clientHeight + 2);
    return {
      hasWorkflowMission: bodyText.includes('Workflow Mission') || document.querySelectorAll('[data-workflow-mission-strip="true"]').length > 0,
      workflowChatMessageCount: workflowMessages.length,
      runFlowCapsuleCount: document.querySelectorAll('[data-run-flow-capsule="true"]').length,
      approveButtonCount: approveButtons.length,
      requestChangeButtonCount: requestButtons.length,
      finishDecisionVisible: Boolean(finish),
      finishDecisionButtonCount: document.querySelectorAll('[data-workflow-finish-branch-decision="true"] [data-finish-branch-decision]').length,
      hasRawMetadataOrExecutionLog: /\bmetadata\b|Metadata|Execution Log/.test(bodyText),
      overflowNodes,
      sample: bodyText.slice(0, 2600),
    };
  });
}

async function clickApprovalsUntil(page, sessionId, predicate, timeoutMs = 240_000) {
  const startedAt = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastDetail = await pageApi(page, `/api/sessions/${sessionId}`);
    if (predicate(lastDetail)) return lastDetail;
    if (hasPendingGate(lastDetail)) {
      const button = page.locator('.deepsea-message--workflow [data-workflow-artifact-action="approve"]').first();
      await button.waitFor({ state: 'visible', timeout: 30_000 });
      await button.click();
      await page.waitForTimeout(1200);
    }
    await sleep(900);
  }
  throw new Error(`Timed out clicking approvals for ${sessionId}; last=${JSON.stringify(summarizeDetail(lastDetail))}`);
}

async function auditRequestChange(context, projectId) {
  const session = await createSession(projectId, 'Interaction request change');
  const page = await openSessionPage(context, projectId, session.id);
  await sendViaComposer(page, '实现一个设置页功能，先产出 spec，让我可以请求修改。');
  await waitForPageSession(
    page,
    session.id,
    (detail) => detail.workflowController?.selected_intent === 'standard_development',
  );
  const { requestChange } = await waitForPendingGateButtons(page, session.id);
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-request-change-before.png`, fullPage: true });
  const beforeDom = await collectInteractionDom(page);
  await requestChange.click();
  const detailAfterRequest = await waitForPageSession(
    page,
    session.id,
    (detail) => (detail.messages ?? []).some((message) => {
      const metadata = safeJson(message.metadata);
      return message.role === 'user' && Boolean(metadata?.workflow_artifact_change_request);
    }),
    120_000,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-request-change-after.png`, fullPage: true });
  const afterDom = await collectInteractionDom(page);
  await page.close();
  const requestMessage = [...(detailAfterRequest.messages ?? [])].reverse().find((message) => {
    const metadata = safeJson(message.metadata);
    return message.role === 'user' && Boolean(metadata?.workflow_artifact_change_request);
  });
  return {
    sessionId: session.id,
    beforeDom,
    afterDom,
    after: summarizeDetail(detailAfterRequest),
    requestMessage: requestMessage ? {
      id: requestMessage.id,
      content: requestMessage.content,
      metadata: safeJson(requestMessage.metadata),
    } : null,
  };
}

async function auditApprove(context, projectId) {
  const session = await createSession(projectId, 'Interaction approve artifact');
  const page = await openSessionPage(context, projectId, session.id);
  await sendViaComposer(page, '轻量修改 README 文档，追加一行项目说明，并展示轻量计划。');
  await waitForPageSession(
    page,
    session.id,
    (detail) => detail.workflowController?.selected_intent === 'lightweight_task',
  );
  const { approve } = await waitForPendingGateButtons(page, session.id);
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-approve-before.png`, fullPage: true });
  const beforeDom = await collectInteractionDom(page);
  await approve.click();
  const detailAfterApprove = await waitForPageSession(
    page,
    session.id,
    (detail) => (detail.workflowGates ?? []).some((gate) => gate.status === 'approved'),
    120_000,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-approve-after.png`, fullPage: true });
  const afterDom = await collectInteractionDom(page);
  await page.close();
  return {
    sessionId: session.id,
    beforeDom,
    afterDom,
    after: summarizeDetail(detailAfterApprove),
  };
}

async function auditFinishBranch(context, projectId) {
  const session = await createSession(projectId, 'Interaction finish branch');
  const page = await openSessionPage(context, projectId, session.id);
  await sendViaComposer(
    page,
    '实现一个设置页功能，创建前端界面和必要测试，并完成审查验证。需要分配子代理并走完整流程。',
  );
  await waitForPageSession(
    page,
    session.id,
    (detail) => detail.workflowController?.selected_intent === 'standard_development',
  );
  const beforeFinish = await clickApprovalsUntil(
    page,
    session.id,
    (detail) => detail.workflowController?.active_stage === 'finish_branch' &&
      detail.workflowController?.status === 'awaiting_decision',
  );
  await page.locator('[data-workflow-finish-branch-decision="true"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-finish-before.png`, fullPage: true });
  const beforeDom = await collectInteractionDom(page);
  await page.locator('[data-workflow-finish-branch-decision="true"] [data-finish-branch-decision="keep_branch"]').click();
  const afterFinish = await waitForPageSession(
    page,
    session.id,
    (detail) => detail.workflowController?.selected_intent === 'standard_development' &&
      detail.workflowController?.status === 'completed',
    120_000,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/workflow-interaction-7381-finish-after.png`, fullPage: true });
  const afterDom = await collectInteractionDom(page);
  await page.close();
  return {
    sessionId: session.id,
    beforeFinish: summarizeDetail(beforeFinish),
    beforeDom,
    after: summarizeDetail(afterFinish),
    afterDom,
  };
}

const project = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({
    name: `Workflow Interaction Audit 7381 ${runStamp}`,
    path: workspaceRoot,
    description: 'Workflow-first interaction audit browser fixture',
  }),
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });

try {
  const requestChange = await auditRequestChange(context, project.id);
  const approve = await auditApprove(context, project.id);
  const finishBranch = await auditFinishBranch(context, project.id);

  const summary = {
    projectId: project.id,
    projectPath: project.path,
    generatedAt: new Date().toISOString(),
    requestChange,
    approve,
    finishBranch,
    assertions: {
      requestChangeButtonsVisible: requestChange.beforeDom.approveButtonCount > 0 &&
        requestChange.beforeDom.requestChangeButtonCount > 0,
      requestChangeSentWorkflowMetadata: Boolean(requestChange.requestMessage?.metadata?.workflow_artifact_change_request),
      approveButtonVisible: approve.beforeDom.approveButtonCount > 0,
      approveAdvancedGate: approve.after.gates.some((gate) => gate.status === 'approved'),
      finishBranchDecisionVisible: finishBranch.beforeDom.finishDecisionVisible === true,
      finishBranchHasFourButtons: finishBranch.beforeDom.finishDecisionButtonCount === 4,
      finishBranchKeepBranchCompleted: finishBranch.after.workflowController?.status === 'completed',
      noWorkflowMission: [requestChange.beforeDom, requestChange.afterDom, approve.beforeDom, approve.afterDom, finishBranch.beforeDom, finishBranch.afterDom]
        .every((dom) => dom.hasWorkflowMission === false),
      workflowRenderedAsChatMessage: [requestChange.beforeDom, approve.beforeDom, finishBranch.beforeDom]
        .every((dom) => dom.workflowChatMessageCount >= 1),
      noRawMetadataOrExecutionLog: [requestChange.beforeDom, requestChange.afterDom, approve.beforeDom, approve.afterDom, finishBranch.beforeDom, finishBranch.afterDom]
        .every((dom) => dom.hasRawMetadataOrExecutionLog === false),
      noDesktopOverflow: [requestChange.beforeDom, requestChange.afterDom, approve.beforeDom, approve.afterDom, finishBranch.beforeDom, finishBranch.afterDom]
        .every((dom) => dom.overflowNodes.length === 0),
    },
  };

  writeFileSync(`${outDir}/workflow-interaction-7381-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context.close();
  await browser.close();
}
