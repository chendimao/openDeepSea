import type { Room, RoomAgent, Task, TaskExecutionIntent, WorkflowStage } from '../types.js';
import {
  formatProjectSuperpowersSkill,
  loadProjectSuperpowersSkills,
  PROJECT_SUPERPOWERS_SKILL_SOURCE_WARNING,
} from '../project-superpowers.js';
import { getSuperpowersPhaseSkills, type SuperpowersRuntimePhase } from './superpowers-skills.js';

export type WorkflowPromptKind = 'development' | 'analysis_document';

interface PromptContext {
  projectName: string;
  projectPath: string;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  workflowContext?: string;
  childTasks?: Task[];
  memoryContext?: string;
  workflowKind?: WorkflowPromptKind;
}

export function buildStagePrompt(stage: WorkflowStage, context: PromptContext): string {
  if (stage === 'analysis') return buildAnalysisPrompt(context);
  if (stage === 'planning') return buildPlanningPrompt(context);
  if (stage === 'implementation') return buildImplementationPrompt(context);
  if (stage === 'code_review') return buildReviewPrompt(context);
  if (stage === 'acceptance') return buildAcceptancePrompt(context);
  return buildAssignmentPrompt(context);
}

export function buildSuperpowersPhasePrompt(phase: SuperpowersRuntimePhase, context: PromptContext): string {
  return [
    buildSuperpowersPhaseHeader(phase),
    '',
    'Superpowers workflow 顺序：using-superpowers -> brainstorming -> writing-plans -> subagent-driven-development/executing-plans -> TDD/debugging/review/verification -> finishing-a-development-branch。',
    '',
    formatSuperpowersSkillInstruction(phase),
    '',
    formatSuperpowersEvidenceInstruction(phase),
    '',
    baseContext(context),
    '',
    workflowContext(context),
  ].join('\n');
}

export function buildSuperpowersRoutingPrompt(context: PromptContext): string {
  return [
    '你是 Superpowers 开发闭环的 planner 路由智能体。',
    '必须先遵循 using-superpowers，判断当前任务下一步应调用哪个 Superpowers skill 或进入哪个执行阶段。',
    'using-superpowers 在这里 routing 只做判断，不替代 brainstorming、writing-plans、systematic-debugging 或执行阶段。',
    '如果输出不是合法 JSON，runtime 会把任务动作标记为 blocked。',
    '',
    '允许的 next_action：brainstorming、writing_plans、subagent_execution、systematic_debugging、verification、finish_branch、blocked。',
    'brainstorming 与 writing_plans 必须推荐 recommended_agent_id=planner。',
    '复杂、不明确、高风险或需要跨模块协调的任务，应先进入 brainstorming / writing_plans。',
    '简单明确、低风险、局部修改且已有清晰验收方式的轻量任务，可以直接进入 subagent_execution；此时必须输出 planning_required=false 和 skip_planning_reason。',
    '没有 planning_required=false 时，runtime 会继续要求已有 designDocPath / implementationPlanPath 后才能进入执行、调试、验证阶段。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
    '',
    '最后必须输出一个 fenced JSON 代码块，格式如下：',
    '```json',
    '{',
    '  "superpowers_routing": {',
    '    "next_action": "brainstorming",',
    '    "required_skill": "brainstorming",',
    '    "reason": "任务是功能或行为变更，需要先澄清需求并产出 spec。",',
    '    "recommended_agent_id": "planner",',
    '    "expected_evidence": ["designDocPath"],',
    '    "planning_required": true',
    '  }',
    '}',
    '```',
    '',
    '轻量直达执行示例：',
    '```json',
    '{',
    '  "superpowers_routing": {',
    '    "next_action": "subagent_execution",',
    '    "required_skill": "subagent-driven-development",',
    '    "reason": "任务范围明确且是低风险局部改动，可直接执行并用定向测试验证。",',
    '    "recommended_agent_id": "frontend-executor",',
    '    "expected_evidence": ["tddEvidence"],',
    '    "planning_required": false,',
    '    "skip_planning_reason": "轻量明确任务，无需单独 spec/plan"',
    '  }',
    '}',
    '```',
  ].join('\n');
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

function buildSuperpowersPhaseHeader(phase: SuperpowersRuntimePhase): string {
  if (phase === 'brainstorming') {
    return [
      '你是 Superpowers 开发闭环的 brainstorming 阶段智能体。',
      '请使用 Superpowers brainstorming 流程澄清目标、约束、验收标准、风险和开放问题。',
      '本阶段聚焦需求与设计，不要执行代码修改。',
    ].join('\n');
  }

  return `你是 Superpowers 开发闭环的 ${phase} 阶段智能体。请按该阶段门禁产出可追踪结果。`;
}

function formatSuperpowersSkillInstruction(phase: SuperpowersRuntimePhase): string {
  const skillNames = getSuperpowersPhaseSkills(phase);
  const skills = loadProjectSuperpowersSkills(skillNames);
  return [
    '本阶段必须激活并遵循以下 Superpowers skills：',
    ...skillNames.map((skillName) => `- ${skillName}`),
    '',
    '<OPENDEEPSEA_PROJECT_SUPERPOWERS>',
    'OpenDeepSea project-owned Superpowers skills are loaded below.',
    'Use these project-builtin skill instructions as the source of truth for this workflow phase.',
    PROJECT_SUPERPOWERS_SKILL_SOURCE_WARNING,
    '',
    ...skills.map(formatProjectSuperpowersSkill),
    '</OPENDEEPSEA_PROJECT_SUPERPOWERS>',
  ].join('\n');
}

function formatSuperpowersEvidenceInstruction(phase: SuperpowersRuntimePhase): string {
  const lines = [
    '阶段完成时必须输出一个 fenced JSON 代码块，根字段为 superpowers，用于 workflow runtime 记录门禁证据。',
    '不要把证据只写在自然语言里。',
  ];

  if (phase === 'brainstorming') {
    return [
      ...lines,
      '```json',
      '{',
      '  "superpowers": {',
      '    "designDocPath": "docs/superpowers/specs/YYYY-MM-DD-topic-design.md",',
      '    "designReviewVerdict": "approved"',
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  if (phase === 'worktree') {
    return [
      ...lines,
      '```json',
      '{',
      '  "superpowers": {',
      '    "worktree": {"path": "/absolute/worktree-or-project-path", "branchName": "branch-name-or-current", "baseRef": "base-ref-or-null"}',
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  if (phase === 'writing_plans') {
    return [
      ...lines,
      '```json',
      '{',
      '  "superpowers": {',
      '    "implementationPlanPath": "docs/superpowers/plans/YYYY-MM-DD-topic.md",',
      '    "planReviewVerdict": "approved"',
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  if (phase === 'tdd_execute') {
    return [
      ...lines,
      '必须记录 RED 失败与 GREEN 通过；只读/文档任务可以输出 tddExemption，但必须说明原因和批准人。',
      '```json',
      '{',
      '  "superpowers": {',
      '    "tddEvidence": [',
      '      {"stage": "RED", "command": "npm test -- specific.test.ts", "passed": false, "summary": "测试按预期失败"},',
      '      {"stage": "GREEN", "command": "npm test -- specific.test.ts", "passed": true, "summary": "实现后通过"}',
      '    ]',
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  if (phase === 'spec_compliance_review' || phase === 'code_quality_review') {
    const field = phase === 'spec_compliance_review' ? 'specComplianceReview' : 'codeQualityReview';
    return [
      ...lines,
      'verdict 只能是 approved、changes_requested、failed 或 pending。',
      '```json',
      '{',
      '  "superpowers": {',
      `    "${field}": {"verdict": "approved", "findings": [], "reviewedAt": "2026-05-27T00:00:00.000Z"}`,
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  if (phase === 'verify') {
    return [
      ...lines,
      '```json',
      '{',
      '  "superpowers": {',
      '    "verificationEvidence": [',
      '      {"command": "npm run build", "status": "passed", "required": true, "fresh": true, "recordedAt": "2026-05-27T00:00:00.000Z"}',
      '    ]',
      '  }',
      '}',
      '```',
    ].join('\n');
  }

  return [
    ...lines,
    '```json',
    '{',
    '  "superpowers": {',
    '    "finishBranchDecision": {"decision": "keep_branch", "options": ["merge_local", "create_pr", "keep_branch", "discard_work"], "reason": "等待用户确认最终收口方式", "decidedAt": "2026-05-27T00:00:00.000Z"}',
    '  }',
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
    '先判断任务类型，再选择 workflow template；不要先假设所有任务都是前后端开发。',
    '常见 workflowTemplate 包括 frontend_feature、backend_feature、fullstack_feature、bugfix、presentation、documentation、data_analysis。',
    '前端 UI、侧边栏、页面、组件、交互、i18n、空态、高亮等任务必须在 scopeRead/scopeWrite 中尽量写出 packages/frontend 相关路径。',
    '后端 API、数据库、路由、仓储、SQLite 等任务必须在 scopeRead/scopeWrite 中尽量写出 packages/backend 相关路径。',
    'PPT、演示文稿、文档、数据分析等非代码任务不要套用前后端开发模板，也不要强行分配给 frontend/backend executor。',
    'scopeWrite 为空只能用于只读、规划、审查或确实无法确定路径的任务；实现类任务必须尽量给出写入路径或在 risks 中说明无法确定原因。',
    '复杂实现任务必须拆出必要的测试、代码审查和验收；如果不拆成单独 step，也必须在 verification 与 acceptance 中明确覆盖。',
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
    buildSuperpowersPhasePrompt('tdd_execute', context),
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
  if (context.workflowKind === 'analysis_document') return true;
  const intent = extractTaskExecutionIntent(context.task.description);
  return Boolean(intent && intent !== 'implementation' && intent !== 'debug_fix');
}

function extractTaskExecutionIntent(value: string | null): TaskExecutionIntent | null {
  if (!value) return null;
  const match = value.match(/任务意图[：:]\s*(analysis_only|planning_only|documentation_only|implementation|debug_fix|review_only)/);
  return match ? match[1] as TaskExecutionIntent : null;
}
