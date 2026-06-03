import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, ClipboardList, Eye, FileText, Reply, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import type { Agent, AgentRun, BrainstormingOption, Message, RoomAgent, Task, TaskActionKind, TaskActionState, TaskEventType, WorkflowRun } from '../../lib/types';
import { parseMessageMetadata } from '../../lib/messageMetadata';
import { useI18n } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { AgentAvatar } from '../AgentAvatar';
import { MessageContent, isMarkdownMessageContent } from '../MessageContent';
import {
  MessageActions as AiMessageActions,
  MessageBadge as AiMessageBadge,
  MessageBody as AiMessageBody,
  MessageHeader as AiMessageHeader,
  MessageMeta as AiMessageMeta,
  MessageRow as AiMessageRow,
} from '../ai-elements/Message';
import { MessageAttachments } from './MessageAttachments';
import { ChatActivityMessage } from './ChatActivityMessage';
import { ChatTaskCard } from './ChatTaskCard';
import { BrainstormingOptionsPanel } from './BrainstormingOptionsPanel';
import { getBrainstormingOptionsForMessage } from './brainstormingOptions';
import {
  getAgentMessageRunState,
  retryFailedAgentRun,
  shouldUseStreamingDisplayForMessage,
  type AgentMessageRunState,
} from './chatMessageModel';

export interface ChatMessageBubbleProps {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  roomAgents: RoomAgent[];
  globalAgents: Agent[];
  roomId: string;
  projectId: string;
  task?: Task;
  tasks?: Task[];
  workflow?: WorkflowRun;
  hasActiveExecution?: boolean;
  taskActionStates?: Partial<Record<TaskActionKind, TaskActionState>>;
  activeTaskId?: string | null;
  streaming: boolean;
  displayContent: string;
  displayMode: 'preview' | 'source';
  onDisplayModeChange: (mode: 'preview' | 'source') => void;
  messageRef: (node: HTMLElement | null) => void;
  highlighted: boolean;
  onReply: () => void;
  retrySourceMessage?: Message | null;
  onLocateReplyTarget: (messageId: string) => void;
  onSelectTask?: (task: Task) => void;
  onStartTaskAction?: (task: Task, action: TaskActionKind) => void;
  selectedBrainstormingOptionIds?: Set<string>;
  onSelectBrainstormingOption?: (message: Message, option: BrainstormingOption) => void;
}

export function ChatMessageBubble({
  message,
  agentMeta,
  run,
  roomAgents,
  globalAgents,
  roomId,
  projectId,
  task,
  tasks = [],
  workflow,
  hasActiveExecution,
  taskActionStates,
  activeTaskId,
  streaming,
  displayContent,
  displayMode,
  onDisplayModeChange,
  messageRef,
  highlighted,
  onReply,
  retrySourceMessage,
  onLocateReplyTarget,
  onSelectTask,
  onStartTaskAction,
  selectedBrainstormingOptionIds,
  onSelectBrainstormingOption,
}: ChatMessageBubbleProps): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const metadata = parseMessageMetadata(message.metadata);
  const saveAsMemory = useMutation({
    mutationFn: () =>
      api.createMemory(projectId, {
        scope: 'room',
        memory_type: 'fact',
        title: `${message.sender_name ?? message.sender_id}: ${(message.content ?? '').slice(0, 80)}`,
        content: message.content ?? '',
        room_id: roomId,
        source_type: 'message',
        source_id: message.id,
      }),
    onSuccess: () => {
      toast.success(t('memory.savedFromMessage'));
      queryClient.invalidateQueries({ queryKey: ['memories', projectId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const retryAgentRun = useMutation({
    mutationFn: () => retryFailedAgentRun({
      run,
      retrySourceMessage,
      retryAgentRun: (id) => api.retryAgentRun(id),
    }),
    onSuccess: () => {
      toast.success('已在原会话中重试');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const attachments = metadata.attachments;
  const agentRunState = getAgentMessageRunState(message, run, streaming);
  const agentRunStatus = agentRunState ? getAgentRunStatusPresentation(agentRunState) : null;
  const renderedContent = displayContent.trim() ? displayContent : '';
  const hasContent = Boolean(renderedContent.trim());
  const hasMarkdownDisplayMode = hasContent && isMarkdownMessageContent(renderedContent);
  const isStreaming = shouldUseStreamingDisplayForMessage(message, run, streaming);
  const showRunStatusNotice = !hasContent && Boolean(agentRunStatus) && message.message_type === 'agent_stream';
  const canReply = !isSystem && hasContent && !isStreaming;
  const canRetryAgentRun = !isUser && run?.status === 'failed';
  const showTaskExecutionSummary = !isUser && Boolean(metadata.task_execution);
  const showRecordOnlyBody = showTaskExecutionSummary && !hasContent;
  const brainstormingOptions = !isUser && !isStreaming
    ? getBrainstormingOptionsForMessage(message, metadata)
    : [];

  if (!isUser && run && !hasContent && !showTaskExecutionSummary && !agentRunStatus) {
    return <></>;
  }

  if (isSystem && shouldRenderInlineTaskCard(metadata.event_type, metadata.task_id)) {
    return (
      <AiMessageRow
        ref={messageRef}
        variant="event"
        data-message-id={message.id}
        className={cn('chat-task-card-row', highlighted && 'is-highlighted')}
      >
        <ChatTaskCard
          message={message}
          metadata={metadata}
          task={task}
          roomAgents={roomAgents}
          active={Boolean(task && activeTaskId === task.id)}
          workflow={workflow}
          hasActiveExecution={hasActiveExecution}
          taskActionStates={taskActionStates}
          onSelectTask={onSelectTask}
          onStartTaskAction={onStartTaskAction}
        />
      </AiMessageRow>
    );
  }

  if (isSystem) {
    const isActivityMessage = message.layer === 'activity';

    return (
      <AiMessageRow
        ref={messageRef}
        variant="system"
        data-message-id={message.id}
        className={cn(highlighted && 'is-highlighted')}
      >
        {isActivityMessage ? (
          <ChatActivityMessage content={message.content} loading={isLoadingActivityCopy(message.content)} />
        ) : (
          message.content
        )}
      </AiMessageRow>
    );
  }

  return (
    <AiMessageRow
      ref={messageRef}
      variant={isUser ? 'user' : 'agent'}
      data-message-id={message.id}
      className={cn('fade-up', highlighted && 'is-highlighted')}
    >
      {!isUser && (
        <AgentAvatar name={message.sender_name ?? message.sender_id} size={32} active={!!agentMeta?.acp_enabled} />
      )}
      <div className="ai-message-card group">
        <AiMessageHeader>
          <AiMessageMeta>
            <span className="ai-message-sender">
              {isUser ? t('room.currentUser') : message.sender_name ?? message.sender_id}
            </span>
            <span className="ai-message-time">
              {formatRelativeTime(message.created_at)}
            </span>
          </AiMessageMeta>
          {agentMeta?.acp_enabled && agentMeta.acp_backend && (
            <AiMessageBadge>ACP:{agentMeta.acp_backend}</AiMessageBadge>
          )}
          {agentRunStatus && (
            <span className={cn('ai-message-status-badge', `is-${agentRunStatus.tone}`, agentRunStatus.active && 'is-active')}>
              <span className="ai-message-status-dot" aria-hidden="true" />
              {agentRunStatus.label}
            </span>
          )}
          {(hasContent || canRetryAgentRun) && (
            <AiMessageActions>
              {hasMarkdownDisplayMode && (
                <>
                  <button
                    type="button"
                    className={cn('ai-message-action', displayMode === 'preview' && 'is-active')}
                    title={t('message.preview')}
                    aria-label={t('message.preview')}
                    aria-pressed={displayMode === 'preview'}
                    onClick={() => onDisplayModeChange('preview')}
                  >
                    <Eye className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={cn('ai-message-action', displayMode === 'source' && 'is-active')}
                    title={t('message.source')}
                    aria-label={t('message.source')}
                    aria-pressed={displayMode === 'source'}
                    onClick={() => onDisplayModeChange('source')}
                  >
                    <FileText className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </>
              )}
              {canReply && (
                <button
                  type="button"
                  className="ai-message-action"
                  title="回复此消息"
                  onClick={onReply}
                >
                  <Reply className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              {canRetryAgentRun && (
                <button
                  type="button"
                  className="ai-message-action"
                  title="重试此回复"
                  disabled={retryAgentRun.isPending}
                  onClick={() => retryAgentRun.mutate()}
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              {hasContent && (
                <button
                  type="button"
                  className="ai-message-action"
                  title={t('memory.saveAsMemory')}
                  disabled={saveAsMemory.isPending}
                  onClick={() => saveAsMemory.mutate()}
                >
                  <BookmarkPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
            </AiMessageActions>
          )}
        </AiMessageHeader>
        {!showRecordOnlyBody && (
          <AiMessageBody stream={isStreaming}>
            {metadata.reply_to && (
              <button
                type="button"
                className="message-reply-reference"
                onClick={() => onLocateReplyTarget(metadata.reply_to!.message_id)}
                title="跳转到引用消息"
              >
                <span>{metadata.reply_to.sender_name ?? metadata.reply_to.sender_id}</span>
                <small>{metadata.reply_to.excerpt}</small>
              </button>
            )}
            {hasContent ? (
              <MessageContent
                content={renderedContent}
                streaming={isStreaming}
                mode={displayMode}
                trace={metadata.trace}
                roomAgents={roomAgents}
                globalAgents={globalAgents}
                tasks={tasks}
                suppressTaskExecutionSummary={showTaskExecutionSummary}
                suppressWorkflowJsonBlocks={!isUser}
                suppressTraceEvents={!isUser}
                roomId={roomId}
              />
            ) : showRunStatusNotice && agentRunStatus ? (
              <AgentRunStatusNotice status={agentRunStatus} error={run?.error ?? run?.stderr ?? null} />
            ) : null}
            <MessageAttachments attachments={attachments} />
            {brainstormingOptions.length > 0 && (
              <BrainstormingOptionsPanel
                options={brainstormingOptions}
                selectedOptionIds={selectedBrainstormingOptionIds}
                disabled={!onSelectBrainstormingOption}
                onSelect={(option) => onSelectBrainstormingOption?.(message, option)}
              />
            )}
          </AiMessageBody>
        )}
        {showTaskExecutionSummary && metadata.task_execution && (
          <TaskRecordSummaryEntry
            label="任务执行"
            detail={`${metadata.task_execution.next_steps.length} 个后续步骤`}
            task={task}
            onSelectTask={onSelectTask}
          />
        )}
      </div>
    </AiMessageRow>
  );
}

type AgentRunStatusTone = 'pending' | 'running' | 'success' | 'danger' | 'muted';

interface AgentRunStatusPresentation {
  label: string;
  detail: string;
  tone: AgentRunStatusTone;
  active: boolean;
}

function getAgentRunStatusPresentation(state: AgentMessageRunState): AgentRunStatusPresentation {
  switch (state) {
    case 'queued':
      return { label: '等待运行', detail: '智能体已进入队列，等待开始回复。', tone: 'pending', active: true };
    case 'running':
    case 'streaming':
      return { label: '运行中', detail: '智能体正在生成回复。', tone: 'running', active: true };
    case 'retrying':
      return { label: '重试中', detail: '上次运行未完成，正在重新尝试。', tone: 'running', active: true };
    case 'completed':
      return { label: '已完成', detail: '智能体回复已完成。', tone: 'success', active: false };
    case 'failed':
      return { label: '运行失败', detail: '智能体运行失败，可重试上一条用户消息。', tone: 'danger', active: false };
    case 'cancelled':
      return { label: '已取消', detail: '本次智能体回复已取消。', tone: 'muted', active: false };
    case 'interrupted':
      return { label: '已中断', detail: '本次智能体回复被中断，可能需要重新发送。', tone: 'danger', active: false };
  }
}

function AgentRunStatusNotice({
  status,
  error,
}: {
  status: AgentRunStatusPresentation;
  error: string | null;
}): JSX.Element {
  const errorText = status.tone === 'danger' ? error?.trim() : '';
  return (
    <div className={cn('agent-run-status-notice', `is-${status.tone}`, status.active && 'is-active')}>
      <span className="agent-run-status-notice-dot" aria-hidden="true" />
      <div>
        <strong>{status.label}</strong>
        <span>{errorText ? errorText.slice(0, 180) : status.detail}</span>
      </div>
    </div>
  );
}

function TaskRecordSummaryEntry({
  label,
  detail,
  task,
  onSelectTask,
}: {
  label: string;
  detail: string;
  task?: Task;
  onSelectTask?: (task: Task) => void;
}): JSX.Element {
  if (!task || !onSelectTask) {
    return (
      <div className="message-task-record-summary">
        <ClipboardList className="h-3.5 w-3.5" />
        <span>{label}</span>
        <small>{detail}</small>
      </div>
    );
  }

  return (
    <button type="button" className="message-task-record-summary" onClick={() => onSelectTask(task)}>
      <ClipboardList className="h-3.5 w-3.5" />
      <span>{label}</span>
      <small>{detail}</small>
      <strong>查看任务记录</strong>
    </button>
  );
}


function shouldRenderInlineTaskCard(eventType: TaskEventType | undefined, taskId: string | undefined): boolean {
  if (!taskId || !eventType) return false;
  return eventType === 'task_created' ||
    eventType === 'task_updated' ||
    eventType === 'task_status_changed' ||
    eventType === 'task_deleted' ||
    eventType === 'message_routed' ||
    eventType.startsWith('workflow_');
}

function isLoadingActivityCopy(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  return [
    '正在',
    '生成中',
    '处理中',
    '执行中',
    '启动中',
    'running',
    'loading',
    'generating',
    'processing',
  ].some((token) => normalized.includes(token));
}
