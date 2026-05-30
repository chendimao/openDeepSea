import React from 'react';
import {
  BadgeCheck,
  Brain,
  Bug,
  CircleHelp,
  Lightbulb,
  MessageSquare,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  MessageIntent,
  MessageIntentResult,
  MessageIntentSource,
  MessageIntentSuggestedAction,
} from '../lib/types';
import { Button } from './ui/Button';

interface MessageIntentCardProps {
  intentResult: MessageIntentResult;
  onChooseIntent: (intent: MessageIntent) => void;
}

const intentLabels: Partial<Record<MessageIntent, string>> = {
  brainstorming: 'Brainstorming',
  chat: '普通聊天',
  light_task: '轻量任务',
  debugger: 'Debugger',
  workflow: 'Workflow',
};

const sourceLabels: Record<MessageIntentSource, string> = {
  rule: '规则',
  classifier: 'Classifier',
  user_override: '用户选择',
};

const actionLabels: Record<MessageIntentSuggestedAction, string> = {
  reply_in_chat: '留在聊天',
  create_light_task: '创建轻量任务',
  start_debugger: '启动 Debugger',
  start_brainstorming: '启动 Brainstorming',
  start_workflow: '启动 Workflow',
  ask_user: '询问确认',
};

const confirmationChoices: ReadonlyArray<{
  intent: MessageIntent;
  label: string;
  icon: LucideIcon;
}> = [
  { intent: 'brainstorming', label: '按 Brainstorming 继续', icon: Brain },
  { intent: 'chat', label: '改为普通聊天', icon: MessageSquare },
  { intent: 'light_task', label: '改为轻量任务', icon: Lightbulb },
  { intent: 'debugger', label: '进入 Debugger', icon: Bug },
  { intent: 'workflow', label: '进入 Workflow', icon: Workflow },
];

export function MessageIntentCard({ intentResult, onChooseIntent }: MessageIntentCardProps) {
  const confidence = normalizeConfidence(intentResult.confidence);
  const isHighConfidence = intentResult.suggestedAction !== 'ask_user' && confidence >= 0.85;
  const label = intentLabels[intentResult.intent] ?? intentResult.intent;
  const signals = (intentResult.signals ?? []).slice(0, 5);
  const source = intentResult.source ? sourceLabels[intentResult.source] : '未知';
  const action = actionLabels[intentResult.suggestedAction];

  return (
    <article className="message-intent-card">
      <div className="message-intent-header">
        <div className="message-intent-heading">
          <div className="message-intent-icon" aria-hidden="true">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <div className="message-intent-kicker">消息意图</div>
            <h3 className="message-intent-title" title={label}>
              {label}
            </h3>
          </div>
        </div>
        {isHighConfidence ? (
          <div className="message-intent-status is-auto">
            <BadgeCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>已自动识别</span>
          </div>
        ) : (
          <div className="message-intent-status is-confirm">
            <CircleHelp className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>需要确认</span>
          </div>
        )}
      </div>

      <div className="message-intent-summary">
        <IntentMetric label="意图" value={label} />
        <IntentMetric label="动作" value={action} />
        <IntentMetric label="来源" value={source} />
        <IntentMetric
          label="置信度"
          value={formatConfidence(confidence)}
          tone={confidence >= 0.85 ? 'strong' : 'warn'}
        />
      </div>

      <div className="message-intent-confidence" aria-hidden="true">
        <span style={{ width: `${Math.round(confidence * 100)}%` }} />
      </div>

      <div className="message-intent-reason">
        <span>依据</span>
        <p>{intentResult.reason}</p>
      </div>

      {signals.length > 0 && (
        <div className="message-intent-signals" aria-label="命中信号">
          {signals.map((signal: string, index: number) => (
            <span key={`${signal}-${index}`}>{signal}</span>
          ))}
        </div>
      )}

      {!isHighConfidence && (
        <div className="message-intent-footer">
          <div className="message-intent-kicker">选择消息类型</div>
          <div className="message-intent-actions">
            {confirmationChoices.map((choice) => {
              const Icon = choice.icon;
              return (
                <Button
                  key={choice.intent}
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="message-intent-action"
                  onClick={() => onChooseIntent(choice.intent)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                  {choice.label}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

function IntentMetric({ label, value, tone }: { label: string; value: string; tone?: 'strong' | 'warn' }) {
  return (
    <div className="message-intent-metric" data-tone={tone}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
