import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const backend = 'http://localhost:7346';
const frontend = 'http://127.0.0.1:5186';
const token = 'workflow-browser-token-7346';
const outDir = 'output/playwright';
mkdirSync(outDir, { recursive: true });

async function api(path, init = {}) {
  const res = await fetch(`${backend}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const projectPath = '/tmp/opendeepsea-workflow-browser-verify-7346/matrix-project';
mkdirSync(projectPath, { recursive: true });
const project = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ name: 'Workflow Browser Matrix 7346', path: projectPath }),
});

const cases = [
  {
    id: 'analysis',
    title: 'Matrix analysis route',
    message: '分析一下为什么删除项目会报 project has active runs，只需要分析原因，不要改代码。',
    expectedIntent: 'analysis',
  },
  {
    id: 'lightweight',
    title: 'Matrix lightweight route',
    message: '轻量修改 README 文档，追加一行项目说明。',
    expectedIntent: 'lightweight_task',
  },
  {
    id: 'debug',
    title: 'Matrix debug route',
    message: 'debug：分析为什么删除项目时可能提示 project has active runs，先给 debug_plan，不要直接修改文件。',
    expectedIntent: 'debug',
  },
  {
    id: 'review',
    title: 'Matrix review route',
    message: '请审查当前项目代码和测试，指出潜在问题与缺失验证。只做代码审查，不要修改文件。',
    expectedIntent: 'review_only',
  },
  {
    id: 'standard',
    title: 'Matrix standard route',
    message: '实现一个设置页功能，创建前端界面和必要测试，并完成审查验证。',
    expectedIntent: 'standard_development',
  },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
const results = [];

async function sendMessage(page, text) {
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
  const composer = page.locator('textarea').first();
  if (await composer.count()) await composer.fill(text);
  else await page.locator('[contenteditable="true"]').first().fill(text);
  const buttons = page.getByRole('button');
  for (let i = 0, count = await buttons.count(); i < count; i += 1) {
    const button = buttons.nth(i);
    const label = `${await button.textContent().catch(() => '')} ${await button.getAttribute('aria-label').catch(() => '') ?? ''}`;
    if (/发送|send/i.test(label)) {
      await button.click();
      return;
    }
  }
  await page.keyboard.press('Enter');
}

for (const item of cases) {
  const session = await api(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ title: item.title, mode: 'ask', provider: 'codex' }),
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (/error|warn/i.test(msg.type())) console.log(`[${item.id}:${msg.type()}] ${text}`);
  });
  await page.goto(`${frontend}/projects/${project.id}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('opendeepsea.localToken', value), token);
  await page.reload({ waitUntil: 'networkidle' });
  await sendMessage(page, item.message);
  await page.waitForFunction(() => document.body.innerText.length > 0, { timeout: 10000 });
  await page.waitForFunction(async ({ sessionId, expectedIntent }) => {
    const detail = await fetch(`/api/sessions/${sessionId}`).then((res) => res.json());
    return detail.workflowController?.selected_intent === expectedIntent;
  }, { sessionId: session.id, expectedIntent: item.expectedIntent }, { timeout: 60000, polling: 1000 }).catch(() => null);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/workflow-browser-matrix-${item.id}-7346.png`, fullPage: true });
  const detail = await page.evaluate(async ({ sessionId }) => fetch(`/api/sessions/${sessionId}`).then((res) => res.json()), { sessionId: session.id });
  const bodyText = await page.locator('body').innerText();
  const result = {
    id: item.id,
    sessionId: session.id,
    expectedIntent: item.expectedIntent,
    workflowController: detail.workflowController ?? null,
    artifactTypes: (detail.workflowArtifacts ?? []).map((artifact) => `${artifact.artifact_type}:${artifact.status}`),
    gateCount: detail.workflowGates?.length ?? 0,
    messageCount: detail.messages?.length ?? 0,
    runCount: detail.runs?.length ?? 0,
    ui: {
      hasWorkflowMission: bodyText.includes('Workflow Mission'),
      hasExecutionLog: bodyText.includes('Execution Log'),
      hasMetadata: bodyText.includes('metadata') || bodyText.includes('Metadata'),
      hasMergedEvents: bodyText.includes('已合并') && bodyText.includes('工作流事件'),
      hasWorkflowStatus: bodyText.includes('WORKFLOW 状态'),
      sample: bodyText.slice(0, 1800),
    },
  };
  writeFileSync(`${outDir}/workflow-browser-matrix-${item.id}-7346.json`, JSON.stringify(result, null, 2));
  results.push(result);
  await page.close();
}

writeFileSync(`${outDir}/workflow-browser-matrix-summary-7346.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
