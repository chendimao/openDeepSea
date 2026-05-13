# 仓库指南

## 项目结构与模块组织

本仓库是 OpenClaw Room 的私有 npm workspace，用于本地优先的多智能体项目管理。

- `packages/backend/`：Node.js、Express、WebSocket、SQLite 与 OpenClaw Gateway 集成。
- `packages/backend/src/repos/`：项目、房间、任务、消息等 SQLite 仓储模块。
- `packages/backend/src/acp/`：Codex、Claude Code、OpenCode 的 ACP provider 适配层。
- `packages/frontend/`：React 18、TypeScript、Vite Web 客户端。
- `packages/frontend/src/pages/`：路由级页面。
- `packages/frontend/src/components/`：可复用 UI 与业务组件。
- `packages/frontend/src/lib/`：共享 API、WebSocket、工具函数与类型辅助。
- `packages/frontend/public/`：静态资源，例如 `lobster.svg`。
- `packages/backend/data/`：本地 SQLite 文件；不要提交生成的数据库状态。

## 构建、测试与开发命令

除非特别说明，命令都在仓库根目录执行。

- `npm install`：安装 workspace 依赖。
- `npm run dev`：同时启动后端和前端开发服务。
- `npm run dev:backend`：启动后端，端口为 `PORT` 或默认 `7330`。
- `npm run dev:frontend`：启动 Vite，通常访问 `http://localhost:5173`。
- `npm run build`：编译后端 TypeScript，并构建前端产物。
- `npm run start`：运行 `packages/backend/dist/server.js` 中的已编译后端。

## 编码风格与命名约定

项目使用 TypeScript，并启用严格编译设置。优先使用 ES modules、命名导出，以及明确的 API/WebSocket 边界类型。保持现有风格：两个空格缩进、分号、单引号、React 组件使用 PascalCase，函数和变量使用 camelCase。

前端代码优先使用 React 函数组件、Tailwind 工具类、`components/ui` 中已有 UI primitives，以及 `src/lib` 中的共享辅助函数。

## 测试指南

当前尚未配置自动化测试 runner。现阶段以 `npm run build` 作为 TypeScript 和打包的最低验证门禁。新增测试时，优先与模块就近放置，或放在 `src/__tests__/` 下；测试文件命名使用 `*.test.ts` 或 `*.test.tsx`，并补充对应 package script，保证贡献者能统一运行。

## 提交与 Pull Request 规范

当前 checkout 不包含 Git 历史，因此无法推断项目既有提交格式。请使用简洁的 Conventional Commits，例如 `feat(frontend): add room filters` 或 `fix(backend): validate room subscriptions`。

Pull Request 应包含变更摘要、已执行的验证、关联 issue 或任务；涉及可见 UI 变化时附截图。若依赖本地服务，也要说明，尤其是 OpenClaw Gateway：`ws://127.0.0.1:18789`。

## 安全与配置提示

不要硬编码凭证、API Key 或本机绝对路径。不要提交 SQLite 数据、构建产物或本地环境文件。写入数据库或调用 ACP 子进程前，应先校验不可信请求体。
