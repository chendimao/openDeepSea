import type { Room, RoomAgent, Task, TaskExecutionIntent, WorkflowStage } from '../types.js';

interface PromptContext {
  projectName: string;
  projectPath: string;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  workflowContext?: string;
  childTasks?: Task[];
  memoryContext?: string;
}

export function buildStagePrompt(stage: WorkflowStage, context: PromptContext): string {
  if (stage === 'analysis') return buildAnalysisPrompt(context);
  if (stage === 'planning') return buildPlanningPrompt(context);
  if (stage === 'implementation') return buildImplementationPrompt(context);
  if (stage === 'code_review') return buildReviewPrompt(context);
  if (stage === 'acceptance') return buildAcceptancePrompt(context);
  return buildAssignmentPrompt(context);
}

function formatAgents(agents: RoomAgent[]): string {
  return agents
    .map((agent) => {
      const role = agent.workflow_role ?? '未设置';
      const desc = agent.agent_role?.trim() || '无职责说明';
      return `- ${agent.agent_name} (${agent.agent_id})：workflow_role=${role}；说明=${desc}`;
    })
    .join('\n');
}

function baseContext(context: PromptContext): string {
  return [
    `项目：${context.projectName}`,
    `路径：${context.projectPath}`,
    `聊天室：${context.room.name}`,
    `任务：${context.task.title}`,
    `描述：${context.task.description ?? '无'}`,
    '',
    '可用智能体：',
    formatAgents(context.agents),
    '',
    context.memoryContext || '项目/聊天室记忆：暂无相关记忆。',
  ].join('\n');
}

function workflowContext(context: PromptContext): string {
  return context.workflowContext || '已有工作流上下文：暂无。';
}

function buildAnalysisPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的分析智能体。请分析任务目标、成功标准、风险和需要确认的问题。',
    '请不要执行代码修改。',
    '如果存在会影响计划方向的产品或技术决策，必须输出结构化 JSON 决策块。',
    '每个阻塞决策都要提供 2 到 4 个选项，并给出推荐选项。',
    '如果没有需要用户决策的问题，decisions 输出空数组。',
    '',
    baseContext(context),
    '',
    '输出格式：先使用 Markdown，包含「任务目标」「成功标准」「风险」「需要确认的问题」「是否建议继续规划」。',
    '最后必须输出一个 JSON 代码块，格式如下：',
    '```json',
    '{',
    '  "decisions": [',
    '    {',
    '      "id": "file-scope",',
    '      "question": "文件支持范围是否只做图片，还是所有文件？",',
    '      "reason": "该选择影响前端控件、后端校验和 Agent 上下文。",',
    '      "blocking": true,',
    '      "recommendedOptionId": "images-only",',
    '      "options": [',
    '        {"id":"images-only","label":"仅支持图片","description":"先支持图片，降低实现范围。"},',
    '        {"id":"all-files","label":"支持所有文件","description":"覆盖范围更广，但需要更严格限制。"}',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
  ].join('\n');
}

function buildPlanningPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的规划智能体。请基于任务和分析结果生成可执行计划。',
    '必须输出一个 JSON 代码块，使用现代结构化计划协议。',
    '根字段必须包含 goal、summary、assumptions、steps、risks、verification、needsApproval。',
    'steps 中每项必须包含 title、intent、assigneeRole、scopeRead、scopeWrite、acceptance、dependsOn。',
    'assigneeRole 只能是 analyst、planner、coordinator、executor、reviewer、acceptor。',
    'preferredBackend 可选；有效值为 claudecode、opencode、codex。',
    'verification 每项使用 {"command":"...","reason":"...","required":true}。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
    '',
    '输出示例：',
    '```json',
    '{',
    '  "goal": "交付目标",',
    '  "summary": "计划摘要",',
    '  "assumptions": ["关键假设"],',
    '  "steps": [',
    '    {',
    '      "title": "步骤标题",',
    '      "intent": "步骤目的和执行说明",',
    '      "assigneeRole": "executor",',
    '      "preferredBackend": "codex",',
    '      "scopeRead": ["需要读取的路径"],',
    '      "scopeWrite": ["允许写入的路径"],',
    '      "acceptance": ["验收标准"],',
    '      "dependsOn": []',
    '    }',
    '  ],',
    '  "risks": ["主要风险"],',
    '  "verification": [',
    '    {"command":"npm run build","reason":"验证 TypeScript 与打包","required":true}',
    '  ],',
    '  "needsApproval": true',
    '}',
    '```',
  ].join('\n');
}

function buildAssignmentPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的协调智能体。请检查计划分配是否合理。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
  ].join('\n');
}

function buildImplementationPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的执行智能体。请按任务要求修改代码，并在完成后说明改动文件和验证结果。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
  ].join('\n');
}

function buildReviewPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的代码审查智能体。请审查执行结果，重点发现 bug、回归风险和遗漏验证。',
    '必须输出 JSON 代码块：{"verdict":"pass|changes_requested|failed","findings":["每条发现使用字符串，包含文件位置、问题、证据和影响"],"requiredFixes":["每条必修项使用字符串"],"riskLevel":"low|medium|high"}。',
    '不要把 findings 或 requiredFixes 写成对象数组。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
  ].join('\n');
}

function buildAcceptancePrompt(context: PromptContext): string {
  if (isAnalysisDocumentContext(context)) {
    return [
      '你是方案/文档验收智能体。请根据原始目标、边界、风险、验证方式和后续实现输入判断输出是否可用。',
      '不要要求代码修改、构建或提交。',
      '不要因为没有代码改动、没有 build、没有 commit 而判失败；只有当任务明确要求实现时才检查代码变更。',
      '必须输出 JSON 代码块：{"verdict":"pass|failed","acceptedCriteria":[],"failedCriteria":[],"notes":"验收说明"}。',
      '',
      baseContext(context),
      '',
      workflowContext(context),
    ].join('\n');
  }
  return [
    '你是开发闭环的功能验收智能体。请根据原始任务、计划、审查结果和验证结果判断是否通过。',
    '必须输出 JSON 代码块：{"verdict":"pass|failed","acceptedCriteria":[],"failedCriteria":[],"notes":"验收说明"}。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
  ].join('\n');
}

function isAnalysisDocumentContext(context: PromptContext): boolean {
  const intent = extractTaskExecutionIntent(context.task.description);
  return Boolean(intent && intent !== 'implementation' && intent !== 'debug_fix');
}

function extractTaskExecutionIntent(value: string | null): TaskExecutionIntent | null {
  if (!value) return null;
  const match = value.match(/任务意图[：:]\s*(analysis_only|planning_only|documentation_only|implementation|debug_fix|review_only)/);
  return match ? match[1] as TaskExecutionIntent : null;
}
