import type { Room, RoomAgent, Task, TaskArtifact, WorkflowStage } from '../types.js';

interface PromptContext {
  projectName: string;
  projectPath: string;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  artifacts: TaskArtifact[];
  childTasks?: Task[];
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

function formatArtifacts(artifacts: TaskArtifact[]): string {
  if (artifacts.length === 0) return '暂无阶段产物。';
  return artifacts.map((artifact) => `## ${artifact.title}\n${artifact.content}`).join('\n\n');
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
  ].join('\n');
}

function buildAnalysisPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的分析智能体。请分析任务目标、成功标准、风险和需要确认的问题。',
    '请不要执行代码修改。',
    '',
    baseContext(context),
    '',
    '输出格式：使用 Markdown，包含「任务目标」「成功标准」「风险」「需要确认的问题」「是否建议继续规划」。',
  ].join('\n');
}

function buildPlanningPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的规划智能体。请基于任务和分析结果生成可执行计划。',
    '必须输出一个 JSON 代码块，字段为 summary、tasks、reviewFocus、verification、risks。',
    'tasks 中每项必须包含 title、description、suggestedRole、priority、acceptance。',
    '',
    baseContext(context),
    '',
    '已有阶段产物：',
    formatArtifacts(context.artifacts),
  ].join('\n');
}

function buildAssignmentPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的协调智能体。请检查计划分配是否合理。',
    '',
    baseContext(context),
    '',
    '已有阶段产物：',
    formatArtifacts(context.artifacts),
  ].join('\n');
}

function buildImplementationPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的执行智能体。请按任务要求修改代码，并在完成后说明改动文件和验证结果。',
    '',
    baseContext(context),
    '',
    '已有阶段产物：',
    formatArtifacts(context.artifacts),
  ].join('\n');
}

function buildReviewPrompt(context: PromptContext): string {
  return [
    '你是开发闭环的代码审查智能体。请审查执行结果，重点发现 bug、回归风险和遗漏验证。',
    '必须输出 JSON 代码块：{"verdict":"pass|changes_requested|failed","findings":[],"requiredFixes":[],"riskLevel":"low|medium|high"}。',
    '',
    baseContext(context),
    '',
    '已有阶段产物：',
    formatArtifacts(context.artifacts),
  ].join('\n');
}

function buildAcceptancePrompt(context: PromptContext): string {
  return [
    '你是开发闭环的功能验收智能体。请根据原始任务、计划、审查结果和验证结果判断是否通过。',
    '必须输出 JSON 代码块：{"verdict":"pass|failed","acceptedCriteria":[],"failedCriteria":[],"notes":"验收说明"}。',
    '',
    baseContext(context),
    '',
    '已有阶段产物：',
    formatArtifacts(context.artifacts),
  ].join('\n');
}
