import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const projectId = '5fGOwYsS-BdA';
const sessionId = 'U5KDZhpAS4bgmqJL';
const token = 'workflow-browser-token-7346';
const url = `http://127.0.0.1:5186/projects/${projectId}/sessions/${sessionId}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.evaluate((value) => localStorage.setItem('opendeepsea.localToken', value), token);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
const text = '为什么这个系统要使用 workflow-first？请用一句话回答。';
const composer = page.locator('textarea').first();
if (await composer.count()) await composer.fill(text);
else await page.locator('[contenteditable="true"]').first().fill(text);
let sent = false;
const buttons = page.getByRole('button');
for (let i = 0, count = await buttons.count(); i < count; i += 1) {
  const button = buttons.nth(i);
  const label = `${await button.textContent().catch(() => '')} ${await button.getAttribute('aria-label').catch(() => '') ?? ''}`;
  if (/发送|send/i.test(label)) { await button.click(); sent = true; break; }
}
if (!sent) await page.keyboard.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('workflow-first'), { timeout: 20000 });
await page.waitForFunction(async ({ sessionId }) => {
  const detail = await fetch(`/api/sessions/${sessionId}`).then((res) => res.json());
  const c = detail.workflowController;
  return c?.status === 'completed' && c?.selected_intent === 'answer';
}, { sessionId }, { timeout: 45000, polling: 1000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'output/playwright/workflow-browser-answer-route-7346.png', fullPage: true });
const result = await page.evaluate(async ({ sessionId }) => {
  const detail = await fetch(`/api/sessions/${sessionId}`).then((res) => res.json());
  const bodyText = document.body.innerText;
  return {
    messageCount: detail.messages?.length ?? 0,
    runCount: detail.runs?.length ?? 0,
    workflowController: detail.workflowController ?? null,
    workflowArtifacts: detail.workflowArtifacts ?? [],
    workflowGates: detail.workflowGates ?? [],
    textHasWorkflowMission: bodyText.includes('Workflow Mission'),
    textHasExecutionLog: bodyText.includes('Execution Log'),
    textHasMetadata: bodyText.includes('metadata') || bodyText.includes('Metadata'),
    textHasAssistantAnswer: bodyText.includes('fake ACP planner answer') || bodyText.includes('workflow-first answer 路径'),
    textHasMergedWorkflowEvents: bodyText.includes('已合并') && bodyText.includes('工作流事件'),
    textSample: bodyText.slice(0, 4500),
  };
}, { sessionId });
writeFileSync('output/playwright/workflow-browser-answer-route-7346.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
