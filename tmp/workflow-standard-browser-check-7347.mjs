import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const backend='http://localhost:7347';
const frontend='http://127.0.0.1:5187';
const token='workflow-browser-token-7347';
const projectPath='/tmp/opendeepsea-workflow-browser-verify-7347/project';
mkdirSync(projectPath,{recursive:true});
async function api(path, init={}){const res=await fetch(`${backend}${path}`,{...init,headers:{'Content-Type':'application/json',...(init.headers??{})}}); if(!res.ok) throw new Error(`${res.status} ${await res.text()}`); return res.json();}
const project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'Workflow Standard Verify 7347',path:projectPath})});
const session=await api(`/api/projects/${project.id}/sessions`,{method:'POST',body:JSON.stringify({title:'Standard route verify',mode:'ask',provider:'codex'})});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:1024}});
await page.goto(`${frontend}/projects/${project.id}/sessions/${session.id}`,{waitUntil:'domcontentloaded'});
await page.evaluate(v=>localStorage.setItem('opendeepsea.localToken',v),token);
await page.reload({waitUntil:'networkidle'});
await page.waitForSelector('textarea, [contenteditable="true"]',{timeout:15000});
const text='实现一个设置页功能，创建前端界面和必要测试，并完成审查验证。';
const composer=page.locator('textarea').first();
if(await composer.count()) await composer.fill(text); else await page.locator('[contenteditable="true"]').first().fill(text);
let sent=false; const buttons=page.getByRole('button');
for(let i=0,c=await buttons.count(); i<c; i++){const b=buttons.nth(i); const label=`${await b.textContent().catch(()=>'')} ${await b.getAttribute('aria-label').catch(()=>'')??''}`; if(/发送|send/i.test(label)){await b.click(); sent=true; break;}}
if(!sent) await page.keyboard.press('Enter');
await page.waitForFunction(async ({sessionId})=>{const d=await fetch(`/api/sessions/${sessionId}`).then(r=>r.json()); return d.workflowController?.selected_intent === 'standard_development';},{sessionId:session.id},{timeout:60000,polling:1000});
await page.waitForTimeout(1500);
await page.screenshot({path:'output/playwright/workflow-browser-standard-route-7347.png',fullPage:true});
const result=await page.evaluate(async ({sessionId})=>{const d=await fetch(`/api/sessions/${sessionId}`).then(r=>r.json()); const body=document.body.innerText; return {sessionId, workflowController:d.workflowController, artifactTypes:(d.workflowArtifacts??[]).map(a=>`${a.artifact_type}:${a.status}`), gateCount:d.workflowGates?.length??0, messageCount:d.messages?.length??0, runCount:d.runs?.length??0, ui:{hasWorkflowMission:body.includes('Workflow Mission'),hasExecutionLog:body.includes('Execution Log'),hasMetadata:body.includes('metadata')||body.includes('Metadata'),sample:body.slice(0,3000)}};},{sessionId:session.id});
writeFileSync('output/playwright/workflow-browser-standard-route-7347.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
await browser.close();
