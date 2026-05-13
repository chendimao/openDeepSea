# OpenClaw Room - 项目管理系统

基于 OpenClaw Gateway 构建的多智能体协作项目管理系统，通过聊天室模式让 OpenClaw 中的 Agent 协作完成开发任务。

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + TailwindCSS + shadcn/ui)         │
│  - 项目管理面板                                      │
│  - 聊天室界面 (实时消息)                              │
│  - 任务看板/进度追踪                                  │
└─────────────────────┬───────────────────────────────┘
                      │ WebSocket + REST
┌─────────────────────▼───────────────────────────────┐
│  Backend (Node.js + Express + WebSocket)            │
│  - 项目/聊天室/任务 CRUD                              │
│  - 消息路由 & 智能体调度                              │
│  - 任务分解 & 进度追踪                               │
│  - SQLite 持久化                                     │
└──────────┬──────────────────────┬───────────────────┘
           │ WebSocket (port 18789)│ ACP (stdio/acpx)
┌──────────▼──────────┐  ┌────────▼──────────────────┐
│  OpenClaw Gateway   │  │  Coding CLIs             │
│  - 多 Agent 会话    │  │  - Claude Code           │
│  - sessions_send    │  │  - OpenCode              │
│  - sessions_spawn   │  │  - Codex                 │
└─────────────────────┘  └───────────────────────────┘
```

## 技术栈

- **前端**: React 18 + TypeScript + TailwindCSS + shadcn/ui + Lucide Icons
- **后端**: Node.js + Express + ws (WebSocket) + better-sqlite3
- **数据库**: SQLite (本地优先，与 OpenClaw 哲学一致)
- **通信**: WebSocket 双向实时通信
- **集成**: OpenClaw Gateway WebSocket 协议 + ACP (acpx)

## 核心功能模块

### Phase 1: 基础框架搭建
1. 初始化 monorepo 结构 (`packages/frontend` + `packages/backend`)
2. 后端: Express + SQLite + WebSocket 服务
3. 前端: React + Vite + TailwindCSS + shadcn/ui
4. 数据库 Schema 设计 (projects, rooms, agents, tasks, messages)

### Phase 2: 项目管理
1. 项目 CRUD (添加本地目录作为项目，验证路径存在)
2. 项目列表/详情页面
3. 项目统计概览 (任务总数/完成/进行中/待办)

### Phase 3: 聊天室系统
1. 每个项目可创建多个聊天室
2. 聊天室实时消息 (用户 + 智能体消息流)
3. 聊天室成员管理 (拉入/移出 Agent)
4. 消息持久化 + 历史记录

### Phase 4: OpenClaw Agent 集成
1. 连接 OpenClaw Gateway (WebSocket ws://127.0.0.1:18789)
2. 列出可用 Agent (`openclaw agents list`)
3. 为每个聊天室中的 Agent 创建独立 session (`sessions_spawn`)
4. Agent 间通信: 通过 `sessions_send` 在 Agent session 间转发消息
5. Agent 消息回调: 监听 Agent 响应并推送到聊天室

### Phase 5: 任务管理 & 协作
1. 在聊天室中发布任务 (任务描述 + 分配 Agent)
2. 任务状态机: pending → in_progress → review → completed/failed
3. 任务分解: 主任务可拆分子任务给不同 Agent
4. Agent 协作流: Agent A 完成后通知 Agent B 继续
5. 任务进度可视化 (看板/甘特图/进度条)

### Phase 6: ACP 编码集成 (每个 profile 独立配置)

**核心模型**: 每个聊天室中的 profile 可以独立配置 ACP 后端。配置粒度: `(project, room, profile)` → `(acp_enabled, acp_backend, acp_session_id)`

#### 6.1 Profile ACP 配置面板
- 在聊天室中点击 profile 头像进入设置:
  - 开关: 是否启用 ACP
  - 后端选择: `claudecode` / `opencode` / `codex`
  - Session 选择器: 列出该 CLI 在当前项目下的所有历史 session, 可选 "新建" 或继续某个已有 session
  - 显示 session 摘要 (创建时间/最后活动/消息数/首条用户消息)

#### 6.2 各 CLI Session 读取适配器
- **ClaudeCodeAdapter**: `~/.claude/projects/<encoded-path>/*.jsonl`
  - 路径编码: `/Users/foo/bar` → `-Users-foo-bar`
  - 解析 jsonl 获取 summary/时间戳/消息数
- **CodexAdapter**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - 按日期目录扫描, 读取 meta 行匹配 `cwd === project.path`
  - 提取 sessionId(文件名 UUID) 和首条用户消息
- **OpenCodeAdapter**: `~/.local/share/opencode/opencode.db` + `storage/session_diff/ses_*.json`
  - 读取 SQLite 查询项目相关 session (只读连接)
  - 或解析 `session_diff/*.json` 元数据

#### 6.3 ACP 调用执行
- 启用 ACP 的 profile 收到任务消息时:
  1. 后端根据 `acp_backend` 调用对应 CLI:
     - Claude Code: `claude --resume <sessionId> --cwd <project.path> --print "<task>"`
     - Codex: `codex --resume <sessionId> --cwd <project.path> exec "<task>"`
     - OpenCode: `opencode run --session <sessionId> --cwd <project.path> "<task>"`
  2. 实时捕获 stdout/stderr 流, 通过 WebSocket 推送到聊天室作为该 profile 的消息
  3. CLI 执行完成后, 更新该 profile 在数据库中的 `current_session_id` (CLI 自动追加到原 session)
- 未启用 ACP 的 profile 走 OpenClaw Gateway 原生 session

#### 6.4 协作流转
- 任务可在多个 profile 间流转, 不同 profile 可使用不同的 ACP 后端
- 例: `architect` profile (无 ACP, 用 OpenClaw) 设计方案 → `coder` profile (ACP=claudecode) 实现代码 → `reviewer` profile (ACP=codex) 审查

## 数据库 Schema 设计 (SQLite)

```sql
-- 项目表
projects (id, name, path, description, created_at, updated_at)

-- 聊天室表
rooms (id, project_id, name, description, created_at)

-- 聊天室成员(智能体 profile), 包含每个 profile 的 ACP 配置
room_agents (
  id, room_id, agent_id, agent_name, agent_role, joined_at,
  acp_enabled BOOLEAN DEFAULT 0,
  acp_backend TEXT,           -- 'claudecode' | 'opencode' | 'codex' | NULL
  acp_session_id TEXT,        -- 选定的 CLI session ID, NULL 表示新建
  acp_session_label TEXT      -- session 显示名 (缓存)
)

-- 消息表
messages (id, room_id, sender_type[user|agent], sender_id, content, message_type[text|task|system], created_at)

-- 任务表
tasks (id, room_id, project_id, title, description, status, assigned_agent_id, parent_task_id, priority, created_at, updated_at, completed_at)
```

## OpenClaw 集成要点

- **Gateway 连接**: WebSocket 协议连接 `ws://127.0.0.1:18789`，使用 connect frame 认证
- **Agent 发现**: 通过 Gateway RPC `agents.list` 或 CLI `openclaw agents list --json`
- **Session 管理**: 每个聊天室中的 Agent 对应一个 OpenClaw session key (如 `agent:<agentId>:room-<roomId>`)
- **消息发送**: 通过 `sessions_send` tool 向 Agent session 发送消息
- **ACP 调用**: 通过子进程直接调用本地 CLI (`claude` / `codex` / `opencode`), 复用其 session 文件; 也支持通过 `acpx` 桥接

## CLI Session 存储位置 (本地实测)

| CLI | Session 路径 | 项目关联方式 |
|-----|-------------|--------------|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` | 路径编码直接对应项目 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 解析 jsonl meta 行的 `cwd` 字段 |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) + `storage/session_diff/ses_*.json` | 查询 db 中的 cwd/path 字段 |

## 设计系统 (Design System)

### 设计愿景: "Deep Ocean Command Center" 🦞

致敬 OpenClaw 龙虾(lobster)品牌。整体氛围: **深海指挥中心** —— 深邃、专业、富有生命力。区别于通用 SaaS 的紫渐变、Inter 字体, 走开发者工具 + 海洋质感融合路线, 让人记得住。

> 核心调性: 像 Linear 一样克制专业, 像 Raycast 一样精确锐利, 像 Discord 一样让"对话"成为主角, 但视觉上注入深海生命力。

### 视觉风格: Modern Developer Workspace + Subtle Bioluminescence

- **主题模式**: 默认 **深色** (开发者偏好), 同时支持浅色
- **氛围**: 暗调专业基底 + 微妙生物发光强调 (active 元素带柔和光晕)
- **拒绝**: 紫色渐变、过度玻璃拟态、卡通图标、emoji 装饰

### 配色 (Dark Mode 为主)

| 角色 | Hex | CSS 变量 | 用途 |
|------|-----|----------|------|
| Background | `#0A0E1A` | `--bg` | 深海主背景 |
| Surface | `#0F1623` | `--surface` | 卡片/侧栏 |
| Surface Raised | `#161E2E` | `--surface-raised` | 悬浮元素 |
| Border | `#1F2937` | `--border` | 分隔线 |
| Foreground | `#E5E7EB` | `--fg` | 主文本 |
| Muted | `#6B7280` | `--muted` | 次要文本 |
| Primary (Coral) | `#FF6B47` | `--primary` | 龙虾红, 主 CTA |
| Primary Hover | `#FF8466` | `--primary-hover` | |
| Accent (Aqua) | `#22D3EE` | `--accent` | 海洋青, 链接/active |
| Success | `#10B981` | `--success` | 任务完成 |
| Warning | `#F59E0B` | `--warning` | 进行中 |
| Danger | `#EF4444` | `--danger` | 错误/失败 |
| Glow Coral | `rgba(255,107,71,0.15)` | `--glow-primary` | 焦点光晕 |
| Glow Aqua | `rgba(34,211,238,0.12)` | `--glow-accent` | 链接光晕 |

### 字体系统

- **Display/Code**: `JetBrains Mono` — 标题、ID、代码、Agent 名称、命令
- **Body**: `Inter Tight` — 正文、按钮、说明文字 (拒绝普通 Inter, 用 Tight 变体更紧致)
- **Numerals**: 启用 `font-feature-settings: "tnum"` (任务进度/统计数字对齐)

```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter+Tight:wght@400;500;600;700&display=swap');
```

字号 scale: `12 / 13 / 14 / 16 / 20 / 24 / 32` (px)

### 间距/圆角/阴影

- **间距**: 4pt 基准 (4 / 8 / 12 / 16 / 24 / 32 / 48)
- **圆角**: `--r-sm:6px`, `--r-md:8px`, `--r-lg:12px`, `--r-xl:16px`
- **阴影 (低层级)**: `0 1px 2px rgba(0,0,0,0.4)`
- **阴影 (高层级)**: `0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)`
- **聚焦光晕**: `0 0 0 3px var(--glow-primary)` (主) / `var(--glow-accent)` (次)

### 布局模型: 三栏工作区 (受 Linear / Discord 启发)

```
┌──────────┬──────────────┬───────────────────┬──────────────┐
│ Sidebar  │  Project     │  Room Workspace   │  Right Panel │
│ 64px 收  │  Rail 240px  │  (Flex)           │  320px 可关  │
│ 缩       │              │                   │              │
│ - 项目  │  Rooms       │  ┌─Chat 流───┐   │  Agent 卡片  │
│   图标  │  Tasks       │  │ msg msg ..│   │  ACP 配置    │
│ - +新建 │  Members     │  └──────────┘   │  Session 选  │
│ - 设置  │              │  ┌─Composer──┐  │  Task 详情   │
│         │              │  │ @agent... │  │              │
│         │              │  └──────────┘   │              │
└──────────┴──────────────┴───────────────────┴──────────────┘
```

### 关键页面

#### 1. 项目工作区入口 (Dashboard)
- 顶部欢迎语 + 全局搜索 (`⌘K`)
- 项目卡片网格: 每张卡片显示项目名(JetBrains Mono)、本地路径、活跃聊天室数、任务进度环、最近活跃 agent 头像堆
- 卡片 hover: 微缩放 + 海洋青边框光晕
- 空状态: 大尺寸龙虾轮廓线条插画 + "Add your first project"

#### 2. 聊天室工作区 (核心页面)
- **顶部导航条**: 面包屑 (Project / Room) + 在线 agent 头像堆 + 任务计数 badge + 设置图标
- **左侧**: room 列表 (按项目分组, 可折叠)
- **主区(Chat)**:
  - 消息流: 用户消息右对齐, agent 消息左对齐 + 头像 + agent 名 (JetBrains Mono) + ACP backend 标签
  - 系统消息: 居中分隔线样式 (例 "ArchitectAgent 加入了聊天室")
  - 任务消息: 特殊卡片, 显示状态条 + 子任务进度 + 分配 agent
  - 代码块: 等宽字体 + 语法高亮 (Shiki) + 复制按钮 + 引用源 session
  - 流式响应: 字符级流入动画 (typewriter) + 终止按钮
- **底部 Composer**:
  - 输入框支持 `@agent` mention 唤起选择浮层
  - `/task` 斜杠命令快速创建任务
  - 附件: 引用项目内文件 (类似 Cursor 的 @ file)
  - 发送按钮: 龙虾红 + Enter 提示

#### 3. Agent ACP 配置面板 (右侧抽屉)
- 头像 + agent 名 + role 标签
- ACP 开关 (大号 toggle, 开启时配色变 coral)
- backend 三选一: 卡片选择器 (claude / opencode / codex), 选中卡片有边框光晕
- Session 选择器:
  - 列出当前项目下的历史 sessions
  - 每条显示: session ID 截断 + 首条用户消息 + 最后活跃时间 + 消息数 chip
  - "新建会话" 选项置顶, 高亮显示
  - 鼠标悬停可预览最近几条对话
- 底部 "应用" 按钮 (主色), 应用后该 agent 后续任务走 ACP

#### 4. 任务看板 (Task Board)
- 列: To Do / In Progress / Review / Done
- 任务卡: 标题 + assigned agent 头像 + 优先级标记 + 子任务进度环
- 拖拽流转 (react-dnd)
- 卡片点击侧滑面板查看详情/相关消息/代码差异

### 微交互/动效原则

- **统一时长**: 微交互 180ms, 面板切换 240ms, 模态出场 220ms
- **缓动**: `cubic-bezier(0.16, 1, 0.3, 1)` (类 Linear)
- **进入**: 元素从下方 8px 淡入 + 透明度 0→1
- **聚焦**: 输入框/按钮 ring 用 `--glow-primary` 平滑展开
- **Active agent 心跳**: 头像周围 1.2s 缓慢呼吸光晕(海洋青), 静止时停止
- **流式消息**: 字符逐个浮现 (12ms/char, 跳过短消息)
- **任务状态切换**: 状态色泛起波纹 (类 Material ripple, 但更克制)
- **Reduced motion**: 全部降级为透明度切换

### 图标体系

- **库**: [Lucide React](https://lucide.dev/) (统一 stroke 1.5)
- **常用**: `Folder` (项目), `MessageSquare` (聊天室), `Bot` (agent), `Terminal` (ACP), `CheckSquare` (任务), `Activity` (心跳), `Sparkles` (新建)
- **品牌点缀**: 自定义 SVG 龙虾轮廓 (loading 状态、空状态、品牌 logo), 仅 stroke 不填充
- **拒绝**: emoji、Heroicons solid 风格

### 组件库

基于 **shadcn/ui** + Tailwind v4, 自定义主题 token 注入。需要扩展:
- `<AgentAvatar>`: 头像 + 在线状态点 + 心跳动画
- `<ACPBackendBadge>`: 显示 claude/opencode/codex 的彩色标签
- `<SessionPicker>`: session 列表 + 预览弹层
- `<MessageBubble>`: 支持 text/code/task/system 多类型
- `<TaskCard>`: 拖拽任务卡
- `<ProjectCard>`: 项目网格卡
- `<CommandMenu>`: ⌘K 全局命令面板 (cmdk 库)

### 反 AI Slop 守则 (本项目特别注意)

1. **不用 Inter / Roboto**, 改用 Inter Tight + JetBrains Mono
2. **不用紫色渐变**, 用海洋青 + 龙虾红双主色
3. **不用 emoji 当图标**, 用 Lucide + 自定义 SVG
4. **不用通用大圆角玻璃卡片**, 用克制的 8-12px 圆角 + 微 1px 高光边
5. **不用居中堆叠的 SaaS landing 模板**, 用三栏工作区布局
6. **不用 "AI 智能助手" 紫光泛滥**, 用克制的功能化光晕仅在 active 状态出现

### 响应式策略

- **桌面 (≥1280px)**: 完整三栏 + 右侧详情
- **平板 (≥768px)**: 两栏 (项目 rail 折叠为图标条, 右侧详情按需弹出)
- **手机 (<768px)**: 单栏 + 抽屉式导航 + 底部 tab (项目/聊天/任务)
- **断点**: `375 / 768 / 1024 / 1280 / 1536`

### 无障碍

- 所有 icon-only 按钮带 `aria-label`
- 焦点可见 (3px 光晕)
- 键盘快捷键: `⌘K` 命令面板, `⌘/` 帮助, `⌘N` 新项目, `Esc` 关闭面板
- 颜色不作为唯一信息载体 (任务状态色 + 文本/icon 双标识)
- `prefers-reduced-motion` 全面适配

## 实施计划

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 | 框架搭建 | 基础结构 |
| Phase 2 | 项目管理 | CRUD + UI |
| Phase 3 | 聊天室 | 实时通信 |
| Phase 4 | Agent 集成 | OpenClaw 对接 |
| Phase 5 | 任务管理 | 协作逻辑 |
| Phase 6 | ACP 编码 | CLI 集成 |

每个 Phase 递增式开发，Phase 1-3 为 MVP 核心，Phase 4-6 为 OpenClaw 深度集成。
