import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, ClipboardList, Eye, FileText, Reply, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import type { Agent, AgentRun, Message, MessageIntent, RoomAgent, Task, TaskEventType } from '../../lib/types';
import { parseMessageMetadata } from '../../lib/messageMetadata';
import { useI18n } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { AgentAvatar } from '../AgentAvatar';
import { MessageContent, isMarkdownMessageContent } from '../MessageContent';
import { MessageIntentCard } from '../MessageIntentCard';
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
import { shouldUseStreamingDisplayForMessage } from './chatMessageModel';

export interface ChatMessageBubbleProps {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  roomAgents: RoomAgent[];
  globalAgents: Agent[];
  roomId: string;
  projectId: string;
  task?: Task;
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
    mutationFn: () => {
      const retryContent = retrySourceMessage?.content?.trim();
      if (!run || !retryContent) throw new Error('没有可重试的用户消息');
      return api.sendMessage(roomId, {
        content: retryContent,
        mentions: [run.agent_id],
      });
    },
    onSuccess: () => {
      toast.success('已重新发送给智能体');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const attachments = metadata.attachments;
  const renderedContent = displayContent || (message.message_type === 'agent_stream' ? '…' : '');
  const hasContent = Boolean(renderedContent.trim());
  const hasMarkdownDisplayMode = hasContent && isMarkdownMessageContent(renderedContent);
  const isStreaming = shouldUseStreamingDisplayForMessage(message, run, streaming);
  const canReply = !isSystem && hasContent && !isStreaming;
  const canRetryAgentRun = !isUser && run?.status === 'failed' && Boolean(retrySourceMessage?.content?.trim());
  const showPlannerDecisionPanel = !isUser && Boolean(metadata.planner_decision);
  const showRecordOnlyBody = !isUser && Boolean(run) && !hasContent;
  const chooseIntent = (intent: MessageIntent) => {
    const prefixByIntent: Record<MessageIntent, string> = {
      chat: '/chat ',
      light_task: '新建任务：',
      debugger: 'debugger：',
      brainstorming: '头脑风暴：',
      workflow: 'workflow：',
    };
    const content = `${prefixByIntent[intent]}${message.content}`.trim();
    void api.sendMessage(roomId, {
      content,
      activeTaskId: metadata.task_id,
    }).then(() => {
      toast.success('已按选择的消息类型重新发送');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', roomId] });
    }).catch((err) => toast.error((err as Error).message));
  };

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
          onSelectTask={onSelectTask}
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
                suppressPlannerDecisionSummary={showPlannerDecisionPanel}
                suppressTraceEvents={!isUser}
                roomId={roomId}
              />
            ) : message.message_type === 'agent_stream' ? (
              <MessageContent
                content="…"
                streaming={isStreaming}
                trace={metadata.trace}
                roomAgents={roomAgents}
                globalAgents={globalAgents}
                suppressTraceEvents={!isUser}
                roomId={roomId}
              />
            ) : null}
            <MessageAttachments attachments={attachments} />
            {isUser && metadata.intent_result && (
              <MessageIntentCard intentResult={metadata.intent_result} onChooseIntent={chooseIntent} />
            )}
          </AiMessageBody>
        )}
        {showPlannerDecisionPanel && metadata.planner_decision && (
          <TaskRecordSummaryEntry
            label="规划决策"
            detail={`${metadata.planner_decision.next_steps.length} 个后续步骤`}
            task={task}
            onSelectTask={onSelectTask}
          />
        )}
        {!isUser && run && (
          <TaskRecordSummaryEntry
            label="ACP 调用记录"
            detail={`ACP:${run.backend} · ${run.status}`}
            task={task}
            onSelectTask={onSelectTask}
          />
        )}
      </div>
    </AiMessageRow>
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
