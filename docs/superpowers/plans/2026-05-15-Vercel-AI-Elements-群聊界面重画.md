# Vercel AI Elements 群聊界面重画 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Vercel AI Elements 风格重画 Room 群聊 UI，同时保留现有多智能体业务逻辑。

**Architecture:** 新增本地 `components/ai-elements` 组件作为纯 UI 层，`RoomPage` 继续负责业务数据、消息发送、Agent Run 绑定和记忆保存。`RichMessageComposer` 保留 `PromptArea` 内核，只改用 AI Elements 风格输入框外壳。

**Tech Stack:** React 18、TypeScript、Tailwind、Radix/shadcn 风格 primitives、lucide-react、use-stick-to-bottom。

---

## 文件结构

- Create: `packages/frontend/src/components/ai-elements/Conversation.tsx`
  - 聊天滚动容器、内容区、空状态、回到底部按钮。
- Create: `packages/frontend/src/components/ai-elements/Message.tsx`
  - 消息行、消息头、消息主体、附件容器、Agent Run 容器。
- Create: `packages/frontend/src/components/ai-elements/PromptInput.tsx`
  - 输入框外壳、附件 shelf、底部工具栏。
- Modify: `packages/frontend/src/pages/RoomPage.tsx`
  - 将 `ChatColumn` 和 `MessageBubble` 接入新 UI 组件。
- Modify: `packages/frontend/src/components/RichMessageComposer.tsx`
  - 保留逻辑，改用 `PromptInput` 外壳组件。
- Modify: `packages/frontend/src/index.css`
  - 新增 `.ai-*` 聊天样式，兼容现有主题变量。
- Modify: `packages/frontend/package.json`
  - 增加 `use-stick-to-bottom` 依赖。

## Task 1: 安装滚动依赖并新增 Conversation 组件

**Files:**
- Modify: `packages/frontend/package.json`
- Create: `packages/frontend/src/components/ai-elements/Conversation.tsx`

- [ ] **Step 1: 安装依赖**

Run:

```bash
npm install use-stick-to-bottom -w @openclaw-room/frontend
```

Expected: `packages/frontend/package.json` 和根 `package-lock.json` 更新。

- [ ] **Step 2: 创建 Conversation 组件**

Create `packages/frontend/src/components/ai-elements/Conversation.tsx`:

```tsx
import { ArrowDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps): JSX.Element {
  return (
    <StickToBottom
      className={cn('ai-conversation', className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({ className, ...props }: ConversationContentProps): JSX.Element {
  return <StickToBottom.Content className={cn('ai-conversation-content', className)} {...props} />;
}

export function ConversationEmptyState({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-conversation-empty', className)}>{children}</div>;
}

export function ConversationScrollButton({
  className,
  label,
}: {
  className?: string;
  label: string;
}): JSX.Element | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => scrollToBottom(), [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={cn('ai-scroll-button', className)}
      onClick={handleScrollToBottom}
      aria-label={label}
      title={label}
    >
      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.9} />
    </Button>
  );
}
```

- [ ] **Step 3: 运行构建检查**

Run:

```bash
npm run build
```

Expected: Build passes.

- [ ] **Step 4: 提交**

```bash
git add package.json packages/frontend/package.json package-lock.json packages/frontend/src/components/ai-elements/Conversation.tsx
git commit -m "feat(frontend): 增加AI对话滚动容器"
```

## Task 2: 新增 Message 和 PromptInput UI 组件

**Files:**
- Create: `packages/frontend/src/components/ai-elements/Message.tsx`
- Create: `packages/frontend/src/components/ai-elements/PromptInput.tsx`

- [ ] **Step 1: 创建 Message 组件**

Create `packages/frontend/src/components/ai-elements/Message.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type MessageVariant = 'user' | 'agent' | 'system' | 'event';

export function MessageRow({
  variant,
  className,
  children,
}: {
  variant: MessageVariant;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <article className={cn('ai-message-row', `ai-message-row--${variant}`, className)}>{children}</article>;
}

export function MessageHeader({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-header', className)}>{children}</div>;
}

export function MessageBody({
  stream,
  className,
  children,
}: {
  stream?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-body', stream && 'ai-message-body--stream', className)}>{children}</div>;
}

export function MessageMeta({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-meta', className)}>{children}</div>;
}

export function MessageBadge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <span className={cn('ai-message-badge', className)}>{children}</span>;
}

export function MessageActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-actions', className)}>{children}</div>;
}

export function MessageAttachments({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-attachments', className)}>{children}</div>;
}

export function MessageRunPanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-run-panel', className)}>{children}</div>;
}
```

- [ ] **Step 2: 创建 PromptInput 组件**

Create `packages/frontend/src/components/ai-elements/PromptInput.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function PromptInputShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-shell', className)}>{children}</div>;
}

export function PromptInputAttachmentShelf({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-attachment-shelf', className)}>{children}</div>;
}

export function PromptInputToolbar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-toolbar', className)}>{children}</div>;
}

export function PromptInputHint({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-hint', className)}>{children}</div>;
}

export function PromptInputActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-actions', className)}>{children}</div>;
}
```

- [ ] **Step 3: 运行构建检查**

Run:

```bash
npm run build
```

Expected: Build passes.

- [ ] **Step 4: 提交**

```bash
git add packages/frontend/src/components/ai-elements/Message.tsx packages/frontend/src/components/ai-elements/PromptInput.tsx
git commit -m "feat(frontend): 增加AI消息与输入框组件"
```

## Task 3: 接入 Room 群聊消息区

**Files:**
- Modify: `packages/frontend/src/pages/RoomPage.tsx`

- [ ] **Step 1: 更新 imports**

Add imports:

```tsx
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../components/ai-elements/Conversation';
import {
  MessageActions as AiMessageActions,
  MessageBadge as AiMessageBadge,
  MessageBody as AiMessageBody,
  MessageHeader as AiMessageHeader,
  MessageMeta as AiMessageMeta,
  MessageRow as AiMessageRow,
  MessageRunPanel as AiMessageRunPanel,
} from '../components/ai-elements/Message';
```

- [ ] **Step 2: 替换 ChatColumn 滚动区域**

Replace the current `chat-scroll` block with:

```tsx
<Conversation className="flex-1">
  <ConversationContent>
    {messages.length === 0 ? (
      <ConversationEmptyState>
        <WorkspaceEmptyState
          icon={<MessageSquare className="h-9 w-9" strokeWidth={1.75} />}
          title={t('room.emptyMessagesTitle')}
          description={
            agents.length === 0
              ? t('room.emptyMessagesNoAgents')
              : t('room.emptyMessagesWithAgents')
          }
          action={agents.length === 0 ? <AddAgentDialog roomId={roomId} /> : undefined}
        />
      </ConversationEmptyState>
    ) : (
      visibleMessages.map((m) => {
        const run = runByMessageId.get(m.id);
        return (
          <MessageBubble
            key={m.id}
            message={m}
            agentMeta={agentMap.get(m.sender_id)}
            run={run}
            runAgent={run ? agentByRoomId.get(run.room_agent_id) : undefined}
            roomId={roomId}
            projectId={projectId}
            onRetryWorkflow={onRetryWorkflow}
            retryingWorkflowId={retryingWorkflowId}
          />
        );
      })
    )}
  </ConversationContent>
  <ConversationScrollButton label={t('room.scrollToBottom', { defaultValue: 'Scroll to bottom' })} />
</Conversation>
```

Then remove `scrollRef` and the `useEffect` that calls `scrollTo`.

- [ ] **Step 3: 重画 MessageBubble**

Update `MessageBubble` to use `AiMessageRow`, `AiMessageHeader`, `AiMessageMeta`, `AiMessageBadge`, `AiMessageActions`, `AiMessageBody`, and `AiMessageRunPanel` while preserving:

- system task event rendering
- plain system message rendering
- `saveAsMemory`
- `AgentAvatar`
- `AgentRunStatusCard`
- `MessageContent`
- `MessageAttachments`

- [ ] **Step 4: 运行构建检查**

Run:

```bash
npm run build
```

Expected: Build passes.

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/pages/RoomPage.tsx
git commit -m "feat(frontend): 接入AI群聊消息区"
```

## Task 4: 接入 RichMessageComposer 输入框外壳

**Files:**
- Modify: `packages/frontend/src/components/RichMessageComposer.tsx`

- [ ] **Step 1: 更新 imports**

Add imports:

```tsx
import {
  PromptInputActions,
  PromptInputAttachmentShelf,
  PromptInputHint,
  PromptInputShell,
  PromptInputToolbar,
} from './ai-elements/PromptInput';
```

- [ ] **Step 2: 替换 form 内部结构**

Keep the `<form>` and all handlers. Inside it:

- Wrap `PromptArea` with `PromptInputShell`.
- Render attachment previews inside `PromptInputAttachmentShelf`.
- Render routing hint and buttons inside `PromptInputToolbar`.
- Keep the existing hidden file input and button callbacks.

- [ ] **Step 3: 运行构建检查**

Run:

```bash
npm run build
```

Expected: Build passes.

- [ ] **Step 4: 提交**

```bash
git add packages/frontend/src/components/RichMessageComposer.tsx
git commit -m "feat(frontend): 重画群聊输入框外壳"
```

## Task 5: 添加 Operational Studio 样式并最终验证

**Files:**
- Modify: `packages/frontend/src/index.css`

- [ ] **Step 1: 新增 `.ai-*` 样式**

Add CSS near existing chat styles:

```css
.ai-conversation {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(rgba(255,255,255,0.14) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px);
  background-size: 24px 24px;
}
```

Continue with styles for message rows, run panel, attachment cards, prompt shell, toolbar, and responsive behavior.

- [ ] **Step 2: 清理旧类依赖**

After styles are added, search:

```bash
rg -n "chat-scroll|message-bubble|run-box-wrap|composer-box|composer-shell" packages/frontend/src
```

Expected: Only intentionally retained compatibility classes remain.

- [ ] **Step 3: 最终构建验证**

Run:

```bash
npm run build
```

Expected: Build passes. Vite chunk warning is acceptable if unchanged from baseline.

- [ ] **Step 4: 代码审查**

Review:

```bash
git diff --stat master...HEAD
git diff master...HEAD -- packages/frontend/src/pages/RoomPage.tsx packages/frontend/src/components/RichMessageComposer.tsx packages/frontend/src/components/ai-elements packages/frontend/src/index.css
```

Check:

- No backend/API/WS behavior changed.
- No `/task` behavior changed.
- No attachment cleanup regression.
- No untracked brainstorm files are staged.
- `packages/frontend/tsconfig.tsbuildinfo` is not committed.

- [ ] **Step 5: 提交最终样式**

```bash
git add packages/frontend/src/index.css
git commit -m "feat(frontend): 完成群聊界面视觉重画"
```

## Self-Review

- Spec coverage: 计划覆盖 Conversation、Message、PromptInput、本地样式、RoomPage 集成、RichMessageComposer 集成、依赖和验证。
- Placeholder scan: 无 `TBD`、`TODO` 或未定义占位任务。
- Type consistency: 组件命名和 import 路径与任务中的创建文件一致。
