# OpenClaw Room 🦞

> 基于 OpenClaw 的多智能体协作项目管理系统 — Deep Ocean Command Center

## 概述

OpenClaw Room 是一个本地优先的项目管理系统，让 OpenClaw 的多个智能体 (profiles) 在聊天室中协作完成开发任务。每个智能体可独立配置 ACP 后端 (Claude Code / OpenCode / Codex)，复用各 CLI 的本地 session 上下文继续开发。

## 核心功能

- 📁 **项目管理** — 添加本地项目，追踪任务进度
- 💬 **聊天室协作** — 拉入 OpenClaw agents 协作完成任务
- 🤖 **多 agent 调度** — 通过 OpenClaw Gateway 路由消息
- ⚙️ **ACP 编码** — 每个 profile 可绑定 Claude Code/OpenCode/Codex，继承本地 CLI session
- 📋 **任务看板** — Kanban 风格任务流转

## 技术栈

- **前端**: React 18 + TypeScript + Vite + TailwindCSS v4 + shadcn/ui
- **后端**: Node.js + Express + ws (WebSocket) + better-sqlite3
- **集成**: OpenClaw Gateway (ws://127.0.0.1:18789) + ACP CLI 子进程

## 前置要求

- Node.js >= 20
- 本地已安装并运行 OpenClaw Gateway
- 可选: Claude Code / OpenCode / Codex CLI (用于 ACP 功能)

### Optional: LangChain Planner

LangChain Planner is optional in phase A. When disabled, workflow planning falls back to the existing ACP planner stage.

```bash
LANGCHAIN_PLANNER_MODEL=gpt-4.1-mini
OPENAI_API_KEY=<your-api-key>
```

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
openclaw-room/
├── packages/
│   ├── backend/        # Express + SQLite + WS 服务
│   └── frontend/       # React + Vite Web 客户端
├── package.json        # workspace 根
└── README.md
```

## 设计系统

详见根目录设计文档。主色 **龙虾红 `#FF6B47`** + **海洋青 `#22D3EE`**，深色主题，JetBrains Mono + Inter Tight。
