# OpenDeepSea

> 本地优先的 ACP 多智能体协作项目管理系统

## 概述

OpenDeepSea 是一个本地优先的项目管理系统，让多个 ACP agent 在聊天室中协作完成开发任务。每个智能体可绑定 Claude Code、OpenCode 或 Codex 等 ACP 后端，复用各 CLI 的本地 session 上下文继续开发。

## 核心功能

- 📁 **项目管理** — 添加本地项目，追踪任务进度
- 💬 **聊天室协作** — 邀请 ACP agents 协作完成任务
- 🤖 **多 agent 调度** — 基于房间消息、@ 提及与任务流转调度 agent
- ⚙️ **ACP 编码** — 每个 agent 可绑定 Claude Code/OpenCode/Codex，继承本地 CLI session
- 📋 **任务看板** — Kanban 风格任务流转

## 技术栈

- **前端**: React 18 + TypeScript + Vite + TailwindCSS v4 + shadcn/ui
- **后端**: Node.js + Express + ws (WebSocket) + better-sqlite3
- **集成**: ACP CLI 子进程 + OpenAI-compatible 模型配置

## 前置要求

- Node.js >= 20
- 可选: Claude Code / OpenCode / Codex CLI (用于 ACP agent)

## 兼容说明

仓库内仍保留部分历史 package name、localStorage key、数据库字段和类型 union，用于迁移兼容；这些名称不代表当前需要外部编排服务运行时。

### Optional: LangChain Planner

LangChain Planner is optional in phase A. When disabled, workflow planning falls back to the existing ACP planner stage.

```bash
LANGCHAIN_PLANNER_MODEL=gpt-4.1-mini
OPENAI_API_KEY=<your-api-key>
```

### LangGraph Workflow Runtime

LangGraph runtime is enabled by default for task workflow and chat backfill. Disable it explicitly only when testing the legacy runtime:

```bash
LANGGRAPH_WORKFLOW_ENABLED=0
```

When disabled, the existing workflow orchestrator remains available for compatibility tests.

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发模式 (前后端并行)
npm run dev

# 前端: http://localhost:5173
# 后端: http://localhost:7330
```

## 目录结构

```
openDeepSea/
├── packages/
│   ├── backend/        # Express + SQLite + WS 服务
│   └── frontend/       # React + Vite Web 客户端
├── package.json        # workspace 根
└── README.md
```

## 设计系统

详见根目录设计文档。主色 **龙虾红 `#FF6B47`** + **海洋青 `#22D3EE`**，深色主题，JetBrains Mono + Inter Tight。
