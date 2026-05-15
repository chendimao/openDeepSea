# Vercel AI Elements 群聊界面重画设计

## 背景

当前 Room 群聊页已经具备完整业务能力：房间消息、WebSocket 流式更新、多智能体 Agent Run 绑定、附件、@mention、`/task` 命令、系统任务事件和任务/工作流侧栏。本次目标不是重做聊天 runtime，而是用 Vercel AI Elements 的组件理念重画群聊 UI，让聊天区更接近现代 AI 对话组件的结构，同时保留 OpenClaw Room 的多智能体工作台属性。

本设计基于用户确认的方向：

- 替换范围选择 A：UI 替换为主，业务逻辑保留。
- 替换深度选择 3：完整 UI 重画。
- 视觉方向选择 1：Operational Studio。
- 输入框方案选择 A：保留现有 `PromptArea` 内核，只重画外壳。

## 目标

在 `feat/vercel-ai-elements-chat` worktree 中，新增本地 AI Elements 风格组件，并替换当前 Room 群聊渲染层，使聊天列表、消息行、附件展示、Agent Run 嵌入区和输入框外壳形成统一的 Operational Studio 体验。

## 非目标

- 不改后端 API。
- 不改 WebSocket 协议。
- 不把聊天状态迁移到 Vercel AI SDK `useChat`。
- 不改变 `Message`、`AgentRun`、`RoomAgent` 等业务类型。
- 不改变 `/task` 命令语义。
- 不改变附件上传、校验和 metadata 解析行为。
- 不重构任务、工作流、记忆、设置等非聊天 UI 模块。

## 设计原则

### 保留业务模型

当前项目的核心价值在多智能体房间，而不是单 assistant 对话。Vercel AI Elements 只作为 UI 组件和结构参考，不接管数据流。现有的 `roomSocket`、React Query cache、`api.sendMessage`、`AgentRunStatusCard`、`MessageContent` 等仍是事实来源。

### Operational Studio 视觉方向

界面应像一个可长时间使用的协作工作台：密集、清晰、安静、可扫描。避免通用 AI 聊天产品的大圆角卡片、营销式空状态或过度装饰。视觉重点放在：

- 消息归属清晰。
- agent backend、时间和执行状态容易扫读。
- 流式 agent 输出保留工程化气质。
- 附件和 Agent Run 区域不与正文混在一起。
- 输入区像命令栏，而不是普通聊天输入框。

### 功能不倒退

`RichMessageComposer` 当前支持 @mention chips、图片粘贴、拖拽附件、附件数量/大小校验、附件预览、`/task` 限制和路由提示。本次只重画外壳，不替换 `PromptArea` 内核，确保这些能力不倒退。

## 组件设计

### `components/ai-elements/Conversation.tsx`

提供 AI Elements 风格聊天容器：

- `Conversation`：封装可滚动对话区域，使用 `use-stick-to-bottom` 实现自动贴底。
- `ConversationContent`：提供消息列表布局。
- `ConversationEmptyState`：提供空状态插槽。
- `ConversationScrollButton`：用户离开底部时显示回到底部按钮。

该组件只处理布局和滚动，不读取业务数据。

### `components/ai-elements/Message.tsx`

提供消息行基础结构：

- `MessageRow`：根据 `variant` 区分 `user`、`agent`、`system`、`event`。
- `MessageHeader`：展示发送者、时间、backend badge、动作按钮。
- `MessageBody`：承载 markdown/content。
- `MessageAttachments`：展示附件 tiles。
- `MessageRunPanel`：承载 `AgentRunStatusCard`。

该组件不解析 metadata，不保存记忆，不处理 retry；这些行为继续留在 `RoomPage` 的业务组件层。

### `components/ai-elements/PromptInput.tsx`

提供输入框外壳组件：

- `PromptInputShell`：统一输入区边框、背景、焦点态和布局。
- `PromptInputToolbar`：承载路由提示、附件按钮、发送按钮。
- `PromptInputAttachmentShelf`：承载待发送附件预览。

`RichMessageComposer` 继续管理 `PromptArea` 状态和提交逻辑，只把视觉结构迁移到这些外壳组件。

## 页面集成

### `RoomPage.tsx`

`ChatColumn` 保留现有数据和 mutation：

- `send` 仍调用 `api.sendMessage(roomId, input)`。
- `/task` 仍调用 `api.createTaskWithConversation`。
- `visibleMessages`、`runByMessageId`、agent map 逻辑保留。
- WebSocket cache 更新逻辑不变。

替换点：

- 当前 `chat-scroll` div 替换为 `Conversation` + `ConversationContent`。
- 空状态改用 `ConversationEmptyState` 承载现有 `WorkspaceEmptyState` 或等效内容。
- 当前 `MessageBubble` 重命名或改造为使用 `MessageRow` 系列组件。
- 保留 `AgentRunStatusCard`，但放入新的 `MessageRunPanel`。

### `RichMessageComposer.tsx`

保留提交逻辑、附件逻辑和 `PromptArea`：

- `segments`、`attachments`、`attachmentsRef` 保留。
- `addFiles`、`removeAttachment`、`handleSubmit` 保留。
- `PromptArea` props 保持现有行为。
- DOM 外层改为 `PromptInputShell`、`PromptInputAttachmentShelf`、`PromptInputToolbar`。

## 样式设计

主要在 `index.css` 中新增或替换聊天相关类：

- `.ai-conversation`
- `.ai-conversation-content`
- `.ai-scroll-button`
- `.ai-message-row`
- `.ai-message-header`
- `.ai-message-body`
- `.ai-message-attachments`
- `.ai-message-run-panel`
- `.ai-prompt-shell`
- `.ai-prompt-toolbar`
- `.ai-prompt-attachment-shelf`

现有主题变量继续使用 `--color-*`，保证极简主题和当前主题体系兼容。避免引入新的大面积色板，避免破坏现有页面整体气质。

## 依赖

Vercel AI Elements 的 Conversation 依赖 `use-stick-to-bottom`。本次允许在 `packages/frontend/package.json` 增加该依赖。其他 AI Elements 组件按本地源码方式落地，不引入完整 runtime。

## 错误处理与边界

- 如果滚动贴底组件异常，不应影响消息渲染和发送。
- 附件 URL、图片预览和下载行为保持现状。
- agent stream 空内容继续显示 `…`。
- 系统任务事件继续走独立 event row，避免被普通消息样式吞掉。
- 用户无 agent 时仍禁用输入，并显示现有邀请 agent 行为。

## 验证方式

最低验证：

- `npm run build`

人工 smoke check：

- 打开 Room 页面，确认消息列表可渲染。
- 发送普通消息。
- 输入 `@` 触发 agent mention。
- 选择或拖拽附件，确认附件预览出现。
- 输入 `/task xxx`，确认仍走任务创建路径。
- agent stream 消息更新时，滚动区域不会抖动或遮挡输入框。

## 交付标准

- 群聊 UI 使用本地 AI Elements 风格组件。
- 当前群聊功能无明显倒退。
- 构建通过。
- 完成代码审查。
- 提交符合仓库提交规范。
