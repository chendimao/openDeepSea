# Electron 可安装 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Electron 版本的 OpenDeepSea 可安装 MVP，复用现有 Web 前端与 Node 后端。

**Architecture:** Electron main process 作为本地桌面 runtime，启动现有后端 sidecar，并加载同一套 React 前端。后端新增数据目录与前端静态托管适配，桌面生产包使用 app data 写入本地状态。

**Tech Stack:** Electron 38.8.6、electron-builder、TypeScript、Node.js、Express、React、Vite、better-sqlite3 12.10.0、node-pty。

---

## 文件结构

- Create: `packages/desktop/package.json`
- Create: `packages/desktop/tsconfig.json`
- Create: `packages/desktop/src/main.ts`
- Create: `packages/desktop/src/preload.ts`
- Create: `electron-builder.json`
- Create: `packages/backend/src/data-dir.ts`
- Create: `packages/backend/src/data-dir.test.ts`
- Create: `packages/backend/src/frontend-static.ts`
- Create: `packages/backend/src/frontend-static.test.ts`
- Create: `packages/backend/tsconfig.build.json`
- Create: `packages/frontend/tsconfig.build.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `packages/backend/package.json`
- Modify: `packages/frontend/package.json`
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/uploads.ts`
- Modify: `packages/backend/src/server.ts`

### Task 1: 后端统一数据目录

**Files:**
- Create: `packages/backend/src/data-dir.ts`
- Create: `packages/backend/src/data-dir.test.ts`
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/uploads.ts`

- [x] **Step 1: Create data-dir helper**

创建 `packages/backend/src/data-dir.ts`：

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = join(__dirname, '..', 'data');

export function getOpenDeepSeaDataDir(): string {
  const configured = process.env.OPENDEEPSEA_DATA_DIR?.trim();
  return configured ? resolve(configured) : defaultDataDir;
}

export function ensureOpenDeepSeaDataDir(): string {
  const dataDir = getOpenDeepSeaDataDir();
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}
```

- [x] **Step 2: Add tests**

创建 `packages/backend/src/data-dir.test.ts`，验证默认目录与环境变量目录。

- [x] **Step 3: Wire db and uploads**

`db.ts` 使用 `ensureOpenDeepSeaDataDir()`；`uploads.ts` 使用 `getOpenDeepSeaDataDir()` 生成 messages/files 上传目录。

- [x] **Step 4: Verify**

Run: `cd packages/backend && node --import tsx --test src/data-dir.test.ts src/frontend-static.test.ts`

### Task 2: 后端生产静态前端托管

**Files:**
- Create: `packages/backend/src/frontend-static.ts`
- Create: `packages/backend/src/frontend-static.test.ts`
- Modify: `packages/backend/src/server.ts`

- [x] **Step 1: Create static helper**

新增 `mountFrontendStatic(app)`，当 `OPENDEEPSEA_FRONTEND_DIST` 存在时挂载 `express.static`，并让非 `/api`、`/uploads`、`/ws` 的路径回退到 `index.html`。

- [x] **Step 2: Add tests**

测试 `shouldServeFrontendFallback('/')` 为 `true`，`/projects/a/sessions/b` 为 `true`，`/api/health`、`/uploads/files/x`、`/ws` 为 `false`。

- [x] **Step 3: Wire server**

`server.ts` 在 `app.use('/api', router)` 后调用 `mountFrontendStatic(app)`，并支持 `OPENDEEPSEA_HOST` 绑定本地 host。

- [x] **Step 4: Verify**

Run: `cd packages/backend && node --import tsx --test src/data-dir.test.ts src/frontend-static.test.ts`

### Task 3: Electron desktop workspace

**Files:**
- Create: `packages/desktop/package.json`
- Create: `packages/desktop/tsconfig.json`
- Create: `packages/desktop/src/main.ts`
- Create: `packages/desktop/src/preload.ts`

- [x] **Step 1: Create package**

新增 workspace package `@openclaw-room/desktop`，脚本包含 `build` 与 `dev`。

- [x] **Step 2: Implement preload**

preload 从 Electron additional arguments 读取 local token，并写入 `localStorage['opendeepsea.localToken']`。

- [x] **Step 3: Implement main process**

main process 分配端口、生成 token、启动后端、等待 `/api/health`、创建窗口、退出时清理子进程。

- [x] **Step 4: Verify**

Run: `npm run build -w @openclaw-room/desktop`

### Task 4: 根脚本与打包配置

**Files:**
- Create: `electron-builder.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Add scripts**

新增 `dev:desktop`、`build:desktop`、`pack:desktop`、`package:desktop`。

- [x] **Step 2: Add builder config**

配置 app id、product name、输出目录、打包文件、native dependency asar unpack、mac/windows/linux target。

- [x] **Step 3: Install dependencies**

Run: `npm install --save-dev electron electron-builder`

补充：Electron 42 与当前 sqlite native addon 编译不兼容，最终固定 `electron@^38.8.6`，升级 `better-sqlite3@^12.10.0`，并在 root `dependencies` 声明后端运行时依赖，确保 electron-builder 能复制并重建 `better-sqlite3`、`node-pty`。

- [x] **Step 4: Verify packaging**

Run: `npm run pack:desktop`

### Task 5: 收尾验证与审查

**Files:**
- Modify: `docs/superpowers/plans/2026-06-08-Electron可安装MVP实施计划.md`

- [x] **Step 1: Run full targeted verification**

Run:

```bash
cd packages/backend && node --import tsx --test src/data-dir.test.ts src/frontend-static.test.ts
npm run build:prod -w @openclaw-room/backend
npm run build:prod -w @openclaw-room/frontend
npm run build -w @openclaw-room/desktop
npm run pack:desktop
npm run package:desktop
```

- [x] **Step 2: Inspect git diff**

Run: `git diff --stat && git diff -- package.json packages/backend/src packages/desktop electron-builder.json`

- [x] **Step 3: Request code review**

对 Electron MVP 改动做一次代码审查，修复 Critical 与 Important 问题。

审查记录：2026-06-09 主会话审查覆盖后端数据目录、上传路径迁移、生产静态托管、Electron sidecar 启动、local token 注入、electron-builder 文件包含范围和 release 产物忽略；未发现 Critical/Important 阻断项。

- [x] **Step 4: Commit**

Commit message:

```bash
git commit -m "feat(desktop): 生成Electron可安装MVP"
```
