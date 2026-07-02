import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const projectId = 'N3D17GfvPJXa';
const sessionId = 'MDwGhw1M9SlkETRw';
const token = 'workflow-browser-token-7339';
const url = `http://127.0.0.1:5179/projects/${projectId}/sessions/${sessionId}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.evaluate((value) => localStorage.setItem('opendeepsea.localToken', value), token);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
const composer = page.locator('textarea').first();
if (await composer.count()) {
  await composer.fill('为什么这个系统要使用 workflow-first？请用一句话回答。');
} else {
  await page.locator('[contenteditable="true"]').first().fill('为什么这个系统要使用 workflow-first？请用一句话回答。');
}
let sent = false;
const buttons = page.getByRole('button');
const count = await buttons.count();
for (let i = 0; i < count; i += 1) {
  const button = buttons.nth(i);
  const label = `${await button.textContent().catch(() => '')} ${await button.getAttribute('aria-label').catch(() => '') ?? ''}`;
  if (/发送|send/i.test(label)) {
    await button.click();
    sent = true;
    break;
  }
}
if (!sent) {
  await page.keyboard.press('Enter');
}
await page.waitForTimeout(1000);
await page.waitForFunction(() => document.body.innerText.includes('workflow-first'), { timeout: 20000 });
await page.waitForTimeout(10000);
await page.screenshot({ path: 'output/playwright/workflow-browser-answer-route-7339.png', fullPage: true });
const bodyText = await page.locator('body').innerText();
const result = await page.evaluate(async ({ sessionId }) => {
  const detail = await fetch(`/api/sessions/${sessionId}`).then((res) => res.json());
  return {
    messageCount: detail.messages?.length ?? 0,
    runCount: detail.runs?.length ?? 0,
    workflowController: detail.workflowController ?? null,
    workflowArtifacts: detail.workflowArtifacts ?? [],
    workflowGates: detail.workflowGates ?? [],
    textHasWorkflowMission: document.body.innerText.includes('Workflow Mission'),
    textHasExecutionLog: document.body.innerText.includes('Execution Log'),
    textHasMetadata: document.body.innerText.includes('metadata') || document.body.innerText.includes('Metadata'),
    textSample: document.body.innerText.slice(0, 3000),
  };
}, { sessionId });
writeFileSync('output/playwright/workflow-browser-answer-route-7339.json', JSON.stringify({ result, bodyTextLength: bodyText.length }, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
