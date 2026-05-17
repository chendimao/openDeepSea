import { GitBranch, ListChecks, Play, Workflow } from 'lucide-react';
import type { CollaborationDecision, RoomAgent } from '../lib/types';
import { Button } from './ui/Button';

interface CollaborationDecisionCardProps {
  decision: CollaborationDecision;
  sourceMessageId: string;
  agents: RoomAgent[];
  starting?: boolean;
  promoting?: boolean;
  onStartCollaboration: () => void;
  onPromoteToWorkflow: () => void;
}

const intentLabels: Record<CollaborationDecision['intent'], string> = {
  question: '问答',
  analysis: '分析',
  implementation: '实现',
};

const modeLabels: Record<CollaborationDecision['recommendedMode'], string> = {
  chat_collaboration: '轻量群聊协作',
  formal_workflow: '正式 workflow',
};

const areaLabels: Record<CollaborationDecision['problemArea'], string> = {
  frontend: '前端',
  backend: '后端',
  fullstack: '全栈',
  unknown: '待判断',
};

const stageLabels: Record<CollaborationDecision['stages'][number]['stage'], string> = {
  execute: '开发',
  review: '审查',
  acceptance: '验收',
  summary: '总结',
};

export function CollaborationDecisionCard({
  decision,
  sourceMessageId,
  agents,
  starting,
  promoting,
  onStartCollaboration,
  onPromoteToWorkflow,
}: CollaborationDecisionCardProps) {
  const agentNameById = new Map(agents.map((agent) => [agent.agent_id, agent.agent_name]));
  const participants = uniqueIds([
    ...decision.proposedAgents.executors,
    ...decision.proposedAgents.reviewers,
    ...decision.proposedAgents.testers,
    ...decision.proposedAgents.acceptors,
  ]);

  return (
    <article className="collaboration-decision-card">
      <div className="collaboration-decision-header">
        <div className="collaboration-decision-icon" aria-hidden="true">
          <GitBranch className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <div className="collaboration-decision-kicker">协作模式选择</div>
          <h3>{decision.summary}</h3>
        </div>
      </div>

      <div className="collaboration-decision-grid">
        <DecisionMetric label="类型" value={intentLabels[decision.intent]} />
        <DecisionMetric label="推荐" value={modeLabels[decision.recommendedMode]} strong />
        <DecisionMetric label="归属" value={areaLabels[decision.problemArea]} />
      </div>

      <p className="collaboration-decision-rationale">{decision.rationale}</p>

      {participants.length > 0 && (
        <div className="collaboration-decision-section">
          <span className="collaboration-decision-section-title">推荐参与者</span>
          <div className="collaboration-agent-list">
            {participants.map((agentId) => (
              <span key={agentId}>{agentNameById.get(agentId) ?? agentId}</span>
            ))}
          </div>
        </div>
      )}

      <div className="collaboration-stage-list">
        {decision.stages.map((stage, index) => (
          <div key={`${stage.stage}-${index}`} className="collaboration-stage-item">
            <ListChecks className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>{stageLabels[stage.stage]}</span>
            <small>{stage.parallel ? '并行' : '串行'}</small>
          </div>
        ))}
      </div>

      <div className="collaboration-decision-actions">
        <Button
          type="button"
          size="sm"
          variant={decision.recommendedMode === 'chat_collaboration' ? 'primary' : 'secondary'}
          onClick={onStartCollaboration}
          disabled={starting || promoting || !sourceMessageId}
        >
          <Play className="h-3.5 w-3.5" strokeWidth={1.8} />
          {starting ? '启动中' : '群聊协作'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={decision.recommendedMode === 'formal_workflow' ? 'primary' : 'secondary'}
          onClick={onPromoteToWorkflow}
          disabled={starting || promoting || !sourceMessageId}
        >
          <Workflow className="h-3.5 w-3.5" strokeWidth={1.8} />
          {promoting ? '创建中' : '正式 workflow'}
        </Button>
      </div>
    </article>
  );
}

function DecisionMetric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="collaboration-decision-metric">
      <span>{label}</span>
      <strong data-strong={strong ? 'true' : undefined}>{value}</strong>
    </div>
  );
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
