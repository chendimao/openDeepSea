# 群聊工作台 1:1 像素还原 — 设计文档

- 日期：2026-05-31
- 分支：feat/ai-task-os-architecture
- 状态：待用户审阅
- 使用技能：brainstorming（→ 后续 writing-plans）

## 1. 目标与范围

在项目真实技术栈（Vite + React 18 + Tailwind + CSS Variables + Framer Motion + lucide-react）中，新建一套**独立的纯展示组件**，对设计稿做**像素级（Pixel Perfect）100% 还原**，包括布局、间距、圆角、阴影、描边、字号、视觉层级、视觉密度、hover 与 loading 动效。

设计稿描述的是一个 **AI 多任务协作工作台**：顶部导航 + 左侧聊天区（40%） + 右侧任务工作区（60%）。

### 范围内
- 新增独立预览路由 `/projects/:projectId/rooms/:roomId/preview`，渲染像素复刻页 `RoomPreviewPage`。
- 复刻 AppShell 右侧内容区的三大块：顶部导航、左聊天区、右任务工作区。
- 逐字写死设计稿文案（fixtures），不依赖后端数据。
- 1440px 断点像素级还原（唯一有设计稿的断点）。

### 范围外
- 不改动现有 `RoomPage.tsx` 及其真实数据 / WebSocket 逻辑。
- 不重做 AppShell 左侧「深海指挥中心」侧边栏（已与设计稿一致，直接复用）。
- 不往后端数据库注入数据。
- ≤1200px / ≤768px 响应式仅做到「基本不错位」，不要求像素级。

## 2. 关键决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 实现方式 | 新建一套独立纯展示组件 |
| 比对数据 | fixtures 写死（逐字还原设计稿文案），不灌真实房间 |
| 文案还原度 | 逐字精确 100% 还原 |
| 路由接入 | 新增独立预览路由，挂在 AppShell 内，复用现有左侧栏 |
| 响应式 | 1440px 像素级优先，小屏基本不错位 |

## 3. 事实校正

- 设计 token 已 100% 命中设计稿：`--color-bg: #F5F7FB`、`--color-primary: #2563EB`、`--color-surface-raised: rgba(255,255,255,0.85)`、`--color-border: rgba(0,0,0,0.06)`。直接复用，无需新建配色。
- 技术栈是 Vite SPA（react-router），非 Next.js App Router。prompt 中的 "App Router" 不适用。
- 当前目标房间 `UXJNgFCaj_SI` 为空房间，渲染为空状态，因此用 fixtures 驱动复刻页做像素基准。

## 4. 路由与挂载

新增路由（在 `main.tsx` 的 `<Routes>` 内）：

```
/projects/:projectId/rooms/:roomId/preview  →  <RoomPreviewPage />
```

渲染在 AppShell 内容区，复用现有左侧栏。访问 `…/UXJNgFCaj_SI/preview` 查看复刻页。不影响现有 `…/rooms/:roomId`。

## 5. 文件结构（组件化，每文件 < 300 行，函数 ≤ 50 行）

```
src/pages/RoomPreviewPage.tsx              # 1440 栅格容器，装配三大区
src/components/room-preview/
  fixtures.ts                              # 逐字 mock：消息流/任务/计划/时间线/工具调用
  preview.css                              # 预览页专用样式细化（间距/圆角/阴影 token）
  layout/PreviewTopNav.tsx                 # 64px 顶部导航
  chat/ChatPanel.tsx                       # 左 40% 容器
  chat/ChatHeader.tsx                      # 72px「聊天」+ 全部下拉 + 右上操作
  chat/ConversationFlow.tsx                # 消息滚动流
  chat/UserMessage.tsx                     # 用户消息：右对齐、浅灰、圆角20px、≤75%宽
  chat/AgentMessage.tsx                    # AI 消息：左对齐、无强背景、强留白
  chat/TaskCardMessage.tsx                 # #PJKIBO 任务卡（聊天内）
  chat/BrainstormResultMessage.tsx         # 头脑风暴结果有序列表
  chat/SampleBubbles.tsx                   # 3 个示例气泡卡（AI/用户/任务状态）
  chat/ActivityMessage.tsx                 # 「正在生成 UI 预览…」loading
  chat/Composer.tsx                        # 底部毛玻璃输入区，圆角24px、内阴影、柔和边框
  task/TaskWorkspace.tsx                   # 右 60% 容器
  task/TaskInspectorHeader.tsx             # 面包屑 + 标题 + meta行 + 进度100%
  task/TaskListRail.tsx                    # 任务列表（全部6/进行中3/待处理1/已完成2/失败0）
  task/TaskQueueCard.tsx                   # 单任务卡 + 进度条
  task/WorkspaceTabs.tsx                   # 概览/执行计划/文件变更/日志/关联信息
  task/ExecutionPlanCard.tsx               # 5 步带 connector 的步骤列表
  task/RealtimeStatusCard.tsx              # 当前 Agent + Tokens/工具调用/文件读取 统计
  task/TimelineCard.tsx                    # 执行过程时间线
  task/FileChangesCard.tsx                 # git diff 风格文件变更（+新增/-删除）
  task/ToolCallsRow.tsx                    # 底部 4 个工具调用卡
  ui/ProgressBar.tsx                       # 蓝色进度条
  ui/StatusPill.tsx                        # 状态徽章（进行中/已完成/待处理/失败/待开始/进行中）
  ui/Avatar.tsx                            # 头像/智能体头像
```

图标统一用 `lucide-react`；类名用 `clsx` + `tailwind-merge`（项目已有）。

## 6. 布局栅格（1440px 基准）

```
AppShell 侧栏(固定) │ 内容区
                    │ ┌─ PreviewTopNav (h:64px, 毛玻璃, border-bottom) ───────────────┐
                    │ ├──────────────────────┬──────────────────────────────────────┤
                    │ │ ChatPanel (40%)      │ TaskWorkspace (60%)                  │
                    │ │ ┌ ChatHeader 72px ┐  │ ┌ TaskInspectorHeader(标题+meta+进度)┐│
                    │ │ │ ConversationFlow│  │ ├──────────┬─────────────────────────┤│
                    │ │ │   (可滚动)       │  │ │TaskList  │ WorkspaceTabs           ││
                    │ │ │                 │  │ │Rail      │ ┌Plan────┬─Realtime────┐ ││
                    │ │ │                 │  │ │(全部6…)  │ ├Timeline┼─FileChanges─┤ ││
                    │ │ └ Composer ───────┘  │ │          │ └ToolCalls(横向4卡)────┘ ││
                    │ └──────────────────────┴──────────────────────────────────────┘
```

- 顶栏高度 64px；ChatHeader 高度 72px。
- 左右分栏 40% / 60%。
- 右侧 Tabs 下方中间区为**双列 Grid**：左列 执行计划 → 执行过程(时间线)；右列 实时状态 → 文件变更；底部「工具调用」横跨整行（4 个卡）。

## 7. 组件内容映射（逐字文案，节选 fixtures）

- 顶栏：Logo「深海指挥中心 / 本地智能体控制台」、当前工作区「复测验证项目」、搜索框「搜索任务、文件、消息… ⌘K」、设置 / 记忆 / 邀请 / 用户头像「规划师」。
- ChatHeader：标题「聊天 / Conversation Flow」、「全部」下拉、右上两个图标按钮。
- 消息流（逐字）：
  - 规划师 21:42 —「我要验证一下任务消息的气泡样式，不需要执行代码，只做 UI 验证。」
  - AI 助手 21:42 —「已理解你的需求，已创建任务并开始头脑风暴。」
  - TaskCardMessage：`#PJKIBO 头脑风暴: light_task`，描述、负责人「规划师」、优先级「中」、预计耗时「15m」、创建时间「21:42」、进度 100%。
  - AI 头脑风暴结果有序列表 4 条 + 「需要我生成 UI 方案预览吗？」
  - 规划师 21:43 —「好的，生成预览图看看效果。」
  - AI 21:43 —「正在生成 UI 预览…」+ 3 个示例气泡卡（AI 消息气泡示例 / 用户消息气泡示例 / 任务状态示例：发送中/已完成/失败）。
- Composer：占位「发送消息，或 @AI、@任务、/命令」、附件/图片/代码/分支 按钮、发送按钮、「收起侧栏」、策略提示「当前策略：只有被 @ 的智能体会回复；无 …」。
- 右侧 InspectorHeader：面包屑「‹ 任务 / #PJKIBO」、「分享」「更多」「×」、标题「头脑风暴: light_task ✎」、meta「进行中 / 负责人 规划师 / 优先级 中 / 预计耗时 15m / 创建时间 21:42」、进度「100%」。
- TaskListRail：过滤「全部6 进行中3 待处理1 已完成2 失败0」+「新建任务」；卡片：#PJKIBO(100%)、#RK39F2 用户认证流程优化(66%)、#FL9D21 支付模块重构(40%)、待处理 #AQ7GHI 数据导出功能、已完成 #BX8K90 修复 UI 显示问题、#MN5JE7 接口文档更新。
- WorkspaceTabs：概览 / 执行计划 / 文件变更 / 日志 / 关联信息。
- ExecutionPlanCard（5 步）：1 分析需求和目标(已完成) 2 收集相关参考资料(已完成) 3 头脑风暴和方案设计(进行中) 4 生成 UI 预览(待开始) 5 整理输出结果(待开始)。
- RealtimeStatusCard：当前步骤「头脑风暴和方案设计」、AI 助手「正在生成 UI 预览…」spinner；资源使用 Tokens 12,456 / 工具调用 8 / 文件读取 3。
- TimelineCard（执行过程）：21:42:13 任务启动 / 21:42:18 分析需求 / 21:42:25 参考资料收集 / 21:42:31 头脑风暴 / 21:42:38 生成预览中…。
- FileChangesCard：「3 个文件变更」message-bubble.tsx(+120 -8) / chat-preview.html(+89) / bubble-style.css(+56 -2)，「查看更多」。
- ToolCallsRow（4 卡）：search_files(成功 21:42:20) / read_file(成功 21:42:23) / list_components(成功 21:42:25) / generate_preview(进行中 21:43:01)。

## 8. 设计令牌

| 类别 | 值 |
|---|---|
| 主色 | `#2563EB` |
| 背景 | `#F5F7FB` |
| 卡片 | `rgba(255,255,255,0.85)` |
| 描边 | `rgba(0,0,0,0.06)` |
| 圆角 | 16px(Task Card) / 20px(用户气泡) / 24px(Composer) |
| 阴影 | 复用 `--shadow-raised`（超浅，微浮起） |
| 状态色 | 完成 `#0f9f6e` / 进行中 `#2563EB` / 等待 `#8190a1` / 失败 `#d94435` |
| 字体 | sans: Inter Tight；mono: JetBrains Mono（ID/数字/时间用 mono） |

## 9. 动效（Framer Motion，克制）

- 进场：`opacity 0→1 + y 8→0`，stagger 30ms。
- 卡片 hover：`y:-2`、阴影微增，160ms ease-out。
- 进度条：宽度 `0→target`，600ms ease-out。
- Loading：圆点 pulse / spinner 旋转。
- 禁止大位移、弹跳、重型动画。

## 10. 验证方式

1. `pnpm --filter frontend build`（或等效 tsc/vite build）通过。
2. Playwright 在 1440×900 打开 `…/UXJNgFCaj_SI/preview` 截图，与设计稿叠合核对：顶栏64px、ChatHeader72px、40/60 分栏、气泡圆角与对齐、任务卡内容与进度、双列 Grid、工具调用行、配色与阴影、逐字文案。
3. 清理验证产生的临时文件（如截图）。

## 11. 风险与权衡

- fixtures 写死可保证 100% 逐字与不依赖后端，代价是与真实数据解耦（仅作设计基准/演示页）。
- 新建组件与现有 RoomPage 存在视觉重复，但隔离清晰、零回归风险，符合用户「新建一套独立组件」的选择。
- 小屏未做像素级，超出 1440 的断点仅保证不错位。
