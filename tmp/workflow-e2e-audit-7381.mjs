import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const backend = 'http://127.0.0.1:7381';
const frontend = 'http://127.0.0.1:5195';
const token = 'workflow-audit-token-7381';
const outDir = 'output/playwright';
const runStamp = Date.now();
const workspaceRoot = `/tmp/opendeepsea-workflow-audit-7381/browser-project-${runStamp}`;

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
  if (!detail) return null;
  return {
    workflowController: detail.workflowController ?? null,
    artifactTypes: (detail.workflowArtifacts ?? []).map((artifact) => `${artifact.artifact_type}:${artifact.status}`),
    gateCount: detail.workflowGates?.length ?? 0,
    assignmentCount: detail.workflowAgentAssignments?.length ?? 0,
    runCount: detail.runs?.length ?? 0,
    messageCount: detail.messages?.length ?? 0,
  };
}

async function waitForSession(sessionId, predicate, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastDetail = await api(`/api/sessions/${sessionId}`);
    if (predicate(lastDetail)) return lastDetail;
    await sleep(800);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; last=${JSON.stringify(summarizeDetail(lastDetail))}`);
}

async function waitForPageSession(page, sessionId, predicate, timeoutMs = 90_000) {
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

async function approvePendingArtifacts(sessionId) {
  const detail = await api(`/api/sessions/${sessionId}`);
  const pending = (detail.workflowArtifacts ?? [])
    .filter((artifact) => ['spec', 'plan', 'lightweight_plan'].includes(artifact.artifact_type) && artifact.status !== 'approved')
    .sort((a, b) => a.created_at - b.created_at);
  for (const artifact of pending) {
    await api(`/api/sessions/${sessionId}/workflow-artifacts/${artifact.id}/approve`, { method: 'POST' });
    await sleep(500);
  }
}

async function driveApprovalsUntil(sessionId, predicate, timeoutMs = 180_000) {
  const startedAt = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastDetail = await api(`/api/sessions/${sessionId}`);
    if (predicate(lastDetail)) return lastDetail;
    const pendingArtifacts = (lastDetail.workflowArtifacts ?? [])
      .filter((artifact) => ['spec', 'plan', 'lightweight_plan'].includes(artifact.artifact_type) && artifact.status !== 'approved');
    if (pendingArtifacts.length > 0 || lastDetail.workflowController?.status === 'awaiting_approval') {
      await approvePendingArtifacts(sessionId);
    }
    if (
      lastDetail.workflowController?.active_stage === 'finish_branch' &&
      lastDetail.workflowController?.status === 'awaiting_decision' &&
      lastDetail.workflowController?.workflow_run_id &&
      predicate(lastDetail) === false
    ) {
      await api(`/api/sessions/${sessionId}/workflows/${lastDetail.workflowController.workflow_run_id}/finish-branch-decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'keep_branch' }),
      });
    }
    await sleep(900);
  }
  throw new Error(`Timed out driving approvals for ${sessionId}; last=${JSON.stringify(summarizeDetail(lastDetail))}`);
}

async function clickFinishDecision(page, decision = 'keep_branch') {
  const selector = `[data-workflow-finish-branch-decision="true"] [data-finish-branch-decision="${decision}"]`;
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.locator(selector).click();
}

async function collectDomSignals(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;
    const workflowMessages = [...document.querySelectorAll('[data-workflow-chat-message="true"]')];
    const overflowNodes = [...document.querySelectorAll(
      '[data-workflow-chat-message="true"], [data-run-flow-capsule="true"], .deepsea-workflow-flow, .deepsea-workflow-state-step, .deepsea-workflow-event',
    )].map((node) => {
      const element = node;
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: typeof element.className === 'string' ? element.className : '',
        width: rect.width,
        height: rect.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    }).filter((item) => item.scrollWidth > item.clientWidth + 2 || item.scrollHeight > item.clientHeight + 2);
    return {
      bodyLength: bodyText.length,
      hasWorkflowMission: bodyText.includes('Workflow Mission') || document.querySelectorAll('[data-workflow-mission-strip="true"]').length > 0,
      hasWorkflowChatMessage: workflowMessages.length > 0,
      workflowChatMessageCount: workflowMessages.length,
      hasRunFlowCapsule: document.querySelectorAll('[data-run-flow-capsule="true"]').length > 0,
      runFlowCapsuleCount: document.querySelectorAll('[data-run-flow-capsule="true"]').length,
      hasAssignmentSummary: document.querySelectorAll('[data-workflow-assignment-summary="true"]').length > 0,
      hasArtifactApprove: document.querySelectorAll('.deepsea-message--workflow [data-workflow-artifact-action="approve"]').length > 0,
      hasArtifactRequestChange: document.querySelectorAll('.deepsea-message--workflow [data-workflow-artifact-action="request-change"]').length > 0,
      hasFinishBranchDecision: document.querySelectorAll('[data-workflow-finish-branch-decision="true"]').length > 0,
      finishDecisionButtonCount: document.querySelectorAll('[data-workflow-finish-branch-decision="true"] [data-finish-branch-decision]').length,
      hasRawMetadataLabel: /\bmetadata\b|Metadata/.test(bodyText),
      hasRawExecutionLogLabel: bodyText.includes('Execution Log'),
      overflowNodes,
      sample: bodyText.slice(0, 2600),
    };
  });
}

async function captureMobile(projectId, sessionId, suffix) {
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await openSessionPage(mobileContext, projectId, sessionId, { width: 390, height: 844 });
  await page.screenshot({ path: `${outDir}/workflow-audit-7381-${suffix}-mobile.png`, fullPage: true });
  const signals = await collectDomSignals(page);
  await page.close();
  await mobileContext.close();
  return signals;
}

const project = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({
    name: `Workflow Audit 7381 ${runStamp}`,
    path: workspaceRoot,
    description: 'Workflow-first completion audit browser fixture',
  }),
});

const cases = [
  {
    id: 'answer',
    title: 'Audit answer route',
    message: '一句话回答：TypeScript 是什么？只需要直接回答。',
    expectedIntent: 'answer',
    finalPredicate: (detail) => detail.workflowController?.selected_intent === 'answer' && detail.workflowController?.status === 'completed',
  },
  {
    id: 'analysis',
    title: 'Audit analysis route',
    message: '只分析不改代码：为什么移除项目时会提示 project has active runs？请先分析原因。',
    expectedIntent: 'analysis',
    finalPredicate: (detail) => detail.workflowController?.selected_intent === 'analysis' && detail.workflowController?.status === 'completed',
  },
  {
    id: 'lightweight',
    title: 'Audit lightweight route',
    message: '轻量修改 README 文档，追加一行项目说明，并展示轻量计划。',
    expectedIntent: 'lightweight_task',
    finalPredicate: (detail) => detail.workflowController?.selected_intent === 'lightweight_task' && detail.workflowController?.status === 'completed',
    driveApprovals: true,
  },
  {
    id: 'debug',
    title: 'Audit debug route',
    message: 'debug：排查为什么发送消息后马上进入 planning，应该先进入分析阶段，先给 debug_plan。',
    expectedIntent: 'debug',
    finalPredicate: (detail) => detail.workflowController?.selected_intent === 'debug' && detail.workflowController?.status === 'completed',
    driveApprovals: true,
  },
  {
    id: 'review',
    title: 'Audit review route',
    message: '只做代码审查，不要修改文件：审查当前 workflow 聊天消息 UI 是否存在排版风险。',
    expectedIntent: 'review_only',
    finalPredicate: (detail) => detail.workflowController?.selected_intent === 'review_only' && detail.workflowController?.status === 'completed',
  },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
const results = [];

try {
  for (const item of cases) {
    const session = await createSession(project.id, item.title);
    const page = await openSessionPage(context, project.id, session.id);
    await sendViaComposer(page, item.message);
    await waitForPageSession(page, session.id, (detail) => detail.workflowController?.selected_intent === item.expectedIntent, 90_000);
    const detail = item.driveApprovals
      ? await driveApprovalsUntil(session.id, item.finalPredicate, 180_000)
      : await waitForSession(session.id, item.finalPredicate, 120_000);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/workflow-audit-7381-${item.id}-desktop.png`, fullPage: true });
    const dom = await collectDomSignals(page);
    results.push({
      id: item.id,
      sessionId: session.id,
      expectedIntent: item.expectedIntent,
      detail: summarizeDetail(detail),
      artifactTypes: (detail.workflowArtifacts ?? []).map((artifact) => `${artifact.artifact_type}:${artifact.status}:${artifact.title}`),
      gateStatuses: (detail.workflowGates ?? []).map((gate) => `${gate.kind}:${gate.status}`),
      assignmentCount: detail.workflowAgentAssignments?.length ?? 0,
      runCount: detail.runs?.length ?? 0,
      dom,
    });
    await page.close();
  }

  const standardSession = await createSession(project.id, 'Audit standard route finish branch');
  const standardPage = await openSessionPage(context, project.id, standardSession.id);
  await sendViaComposer(
    standardPage,
    '实现一个设置页功能，创建前端界面和必要测试，并完成审查验证。需要分配子代理并走完整流程。',
  );
  await waitForPageSession(
    standardPage,
    standardSession.id,
    (detail) => detail.workflowController?.selected_intent === 'standard_development',
    90_000,
  );
  const standardBeforeFinish = await driveApprovalsUntil(
    standardSession.id,
    (detail) => detail.workflowController?.active_stage === 'finish_branch' && detail.workflowController?.status === 'awaiting_decision',
    240_000,
  );
  await standardPage.waitForTimeout(1500);
  await standardPage.screenshot({ path: `${outDir}/workflow-audit-7381-standard-finish-branch-desktop.png`, fullPage: true });
  const finishDomBefore = await collectDomSignals(standardPage);
  await clickFinishDecision(standardPage, 'keep_branch');
  const standardDetail = await waitForSession(
    standardSession.id,
    (detail) => detail.workflowController?.selected_intent === 'standard_development' && detail.workflowController?.status === 'completed',
    120_000,
  );
  await standardPage.waitForTimeout(1500);
  await standardPage.screenshot({ path: `${outDir}/workflow-audit-7381-standard-completed-desktop.png`, fullPage: true });
  const standardDom = await collectDomSignals(standardPage);
  const mobileDom = await captureMobile(project.id, standardSession.id, 'standard-completed');
  results.push({
    id: 'standard',
    sessionId: standardSession.id,
    expectedIntent: 'standard_development',
    beforeFinish: summarizeDetail(standardBeforeFinish),
    detail: summarizeDetail(standardDetail),
    artifactTypes: (standardDetail.workflowArtifacts ?? []).map((artifact) => `${artifact.artifact_type}:${artifact.status}:${artifact.title}`),
    gateStatuses: (standardDetail.workflowGates ?? []).map((gate) => `${gate.kind}:${gate.status}`),
    assignmentCount: standardDetail.workflowAgentAssignments?.length ?? 0,
    assignmentSample: (standardDetail.workflowAgentAssignments ?? []).slice(0, 5),
    runCount: standardDetail.runs?.length ?? 0,
    finishBranchBeforeDecision: finishDomBefore,
    dom: standardDom,
    mobileDom,
  });
  await standardPage.close();

  const summary = {
    projectId: project.id,
    projectPath: project.path,
    generatedAt: new Date().toISOString(),
    results,
    assertions: {
      allIntentsMatched: results.every((item) => item.detail?.workflowController?.selected_intent === item.expectedIntent),
      noWorkflowMission: results.every((item) => item.dom?.hasWorkflowMission === false),
      workflowChatMessagesPresent: results.every((item) => item.dom?.hasWorkflowChatMessage === true),
      continuousWorkflowMerged: results.every((item) => (item.dom?.workflowChatMessageCount ?? 0) === 1),
      nonAnswerRoutesHaveRunCapsules: results.filter((item) => item.id !== 'answer').every((item) => item.dom?.hasRunFlowCapsule === true),
      standardHasAssignments: results.find((item) => item.id === 'standard')?.assignmentCount > 0,
      standardHadFinishBranchDecision: results.find((item) => item.id === 'standard')?.finishBranchBeforeDecision?.hasFinishBranchDecision === true,
      standardHadFourFinishButtons: results.find((item) => item.id === 'standard')?.finishBranchBeforeDecision?.finishDecisionButtonCount === 4,
      noRawMetadataOrExecutionLog: results.every((item) => item.dom?.hasRawMetadataLabel === false && item.dom?.hasRawExecutionLogLabel === false),
      noDesktopOverflow: results.every((item) => (item.dom?.overflowNodes?.length ?? 0) === 0),
      noMobileOverflow: (results.find((item) => item.id === 'standard')?.mobileDom?.overflowNodes?.length ?? 0) === 0,
    },
  };
  writeFileSync(`${outDir}/workflow-audit-7381-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context.close();
  await browser.close();
}
