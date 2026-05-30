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
import type { MessageIntent, MessageIntentResult } from '../lib/types';
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

const confirmationChoices: ReadonlyArray<{
  intent: string;
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
  const signals = (intentResult.signals ?? []).slice(0, 3);

  return (
    <article className="message-intent-card">
      <div className="message-intent-header">
        <div className="message-intent-icon" aria-hidden="true">
          <Sparkles className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <div className="message-intent-kicker">消息意图</div>
          <h3 className="message-intent-title" title={label}>
            {label}
          </h3>
        </div>
      </div>

      <div className="message-intent-metrics">
        <IntentMetric label="意图" value={label} />
        <IntentMetric label="置信度" value={formatConfidence(confidence)} />
      </div>

      <p className="message-intent-reason">{intentResult.reason}</p>

      {signals.length > 0 && (
        <div className="message-intent-signals">
          {signals.map((signal: string, index: number) => (
            <span key={`${signal}-${index}`}>{signal}</span>
          ))}
        </div>
      )}

      <div className="message-intent-footer">
        {isHighConfidence ? (
          <div className="message-intent-status is-auto">
            <BadgeCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>已自动识别</span>
          </div>
        ) : (
          <>
            <div className="message-intent-status is-confirm">
              <CircleHelp className="h-3.5 w-3.5" strokeWidth={1.8} />
              <span>需要确认</span>
            </div>
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
                    onClick={() => onChooseIntent(choice.intent as MessageIntent)}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                    {choice.label}
                  </Button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function IntentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="message-intent-metric">
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
