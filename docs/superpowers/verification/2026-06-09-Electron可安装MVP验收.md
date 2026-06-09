# Electron 可安装 MVP 验收记录

## 范围

本次验收覆盖 Electron 可安装 MVP：

- 后端支持 `OPENDEEPSEA_DATA_DIR` 写入桌面用户数据目录。
- 后端支持 `OPENDEEPSEA_FRONTEND_DIST` 托管前端生产产物。
- 新增 `packages/desktop` Electron main/preload。
- 新增 `electron-builder` 打包配置。
- root `dependencies` 显式声明后端运行时依赖，供 electron-builder 复制并重建 native modules。
- 生成 macOS 未签名 DMG/ZIP 安装产物。

## 验证命令

### 后端定向测试

```bash
cd packages/backend && node --import tsx --test src/data-dir.test.ts src/frontend-static.test.ts
```

结果：5 个测试通过，0 失败。

### 桌面生产构建

```bash
npm run build:desktop
```

结果：通过。Vite 有 chunk size warning，无构建错误。

包含：

- `npm run build:prod -w @openclaw-room/backend`
- `npm run build:prod -w @openclaw-room/frontend`
- `npm run build -w @openclaw-room/desktop`

### 未压缩桌面包

```bash
npm run pack:desktop
```

结果：通过，生成 `release/desktop/mac/OpenDeepSea.app`。

关键日志：

- `electronVersion=38.8.6`
- `finished moduleName=better-sqlite3 arch=x64`
- `finished moduleName=node-pty arch=x64`

### 安装包

```bash
npm run package:desktop
```

结果：通过，生成：

- `release/desktop/OpenDeepSea-0.1.0.dmg`
- `release/desktop/OpenDeepSea-0.1.0-mac.zip`

### 产物结构检查

```bash
npx asar list release/desktop/mac/OpenDeepSea.app/Contents/Resources/app.asar | rg "packages/(desktop/dist/main.js|desktop/dist/preload.js|backend/dist/server.js)|packages/backend/package.json"
test -f release/desktop/mac/OpenDeepSea.app/Contents/Resources/frontend-dist/index.html
```

结果：确认 app.asar 包含：

- `/packages/backend/dist/server.js`
- `/packages/backend/package.json`
- `/packages/desktop/dist/main.js`
- `/packages/desktop/dist/preload.js`
- `/node_modules/better-sqlite3/package.json`
- `/node_modules/node-pty/package.json`
- `/node_modules/express/package.json`

前端生产产物确认：

- `release/desktop/mac/OpenDeepSea.app/Contents/Resources/frontend-dist/index.html`

native unpack 确认：

- `app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
- `app.asar.unpacked/node_modules/node-pty/build/Release/pty.node`

### 打包后端运行时 smoke

```bash
ELECTRON_RUN_AS_NODE=1 release/desktop/mac/OpenDeepSea.app/Contents/MacOS/OpenDeepSea \
  release/desktop/mac/OpenDeepSea.app/Contents/Resources/app.asar/packages/backend/dist/server.js
```

使用临时 `OPENDEEPSEA_DATA_DIR`、`OPENCLAW_ROOM_DB`、`OPENDEEPSEA_FRONTEND_DIST`、`OPENDEEPSEA_LOCAL_TOKEN`、`PORT=17330` 启动包内 backend。

结果：

- `GET /api/health` 返回 `{"ok":true,...}`。
- `GET /` 返回前端 `index.html`。
- backend 日志显示 `[server] backend listening on 127.0.0.1:17330`。
- 日志存在 `DEP0180` deprecation warning，不影响本次 smoke。

### 代码审查修复回归

本轮针对 Electron MVP 代码审查发现项执行修复，覆盖：

- WebSocket 访问必须携带有效 `OPENDEEPSEA_LOCAL_TOKEN`，仅可信 `Origin` 不再足够。
- 前端 WebSocket URL 从 `opendeepsea.localToken` 注入 `localToken` 查询参数；Vite dev 仅在 `serve` 模式暴露本地 token fallback。
- Electron preload 通过同步 IPC 获取 local token，不再通过 renderer argv 传递。
- Electron sidecar 启动失败时清理 child，退出时按平台清理 backend 进程树，并限制 `shell.openExternal` 协议。
- backend 收到 `SIGTERM` / `SIGINT` 时主动关闭 terminal sessions 和 HTTP/WebSocket server。
- 前端 `index.html` fallback 使用 `Cache-Control: no-store`，静态 hashed 资源继续使用 immutable cache。
- 桌面打包脚本在打包前强制 `electron-rebuild --build-from-source`，打包后恢复 root `better-sqlite3` / `node-pty` 的普通 Node ABI。

验证命令：

```bash
cd packages/backend && node --import tsx --test \
  src/websocket-access.test.ts \
  src/frontend-static.test.ts \
  src/local-access.test.ts \
  src/terminal/routes.test.ts \
  src/platform-skills/routes.test.ts \
  src/online-skills/routes.test.ts \
  src/data-dir.test.ts
```

结果：26 个测试通过，0 失败。

```bash
cd packages/frontend && node --import tsx --test src/lib/ws.test.ts src/lib/api.test.ts
```

结果：26 个测试通过，0 失败。

```bash
npm run build:desktop
npm run package:desktop
```

结果：均通过；`package:desktop` 日志包含 `electron-rebuild --build-from-source` 的 `Rebuild Complete`，并在结尾恢复 root native ABI：`rebuilt dependencies successfully`。

包内 smoke 结果：

- `GET /api/health` 返回 `{"ok":true,...}`。
- `GET /` 返回前端 `index.html`，响应头包含 `Cache-Control: no-store`。
- `ws://127.0.0.1:17330/ws` 返回 `403`。
- `ws://127.0.0.1:17330/ws?localToken=smoke-token` 可连接。
- 打包后 root `better-sqlite3` 可在普通 Node 下打开 `:memory:` 数据库，root `node-pty` 可在普通 Node 下加载 `spawn`。

### Electron 数据目录设置与清除数据回归

本轮新增 Electron 桌面数据目录设置与清除数据能力，覆盖：

- Electron main 使用 `desktop-settings.json` 管理自定义数据目录。
- backend sidecar 启动时注入 `OPENDEEPSEA_DATA_DIR` 和 `OPENCLAW_ROOM_DB`。
- 文件上传目录统一落在 `OPENDEEPSEA_DATA_DIR/uploads/messages` 与 `OPENDEEPSEA_DATA_DIR/uploads/files`。
- 自定义目录必须为空或已有 `.opendeepsea-data-dir.json` marker。
- 清除桌面数据前停止 backend，并且只清除带有效 marker 的当前数据目录内容。
- Web 端没有 `window.openDeepSeaDesktop` 时不显示桌面数据设置。

说明：主工作区存在与本次任务无关的 `packages/frontend/src/pages/SkillsPage.tsx` 脏改动，会使 `npm run build:prod -w @openclaw-room/frontend` 因缺少 `tokenSourceDescription`、`SkillsMpTokenSettingsPanel`、`tokenSourceLabel` 失败。完整安装包验证在隔离 worktree `.worktrees/electron-data-dir-package-verify` 中执行，该 worktree 只应用本次 staged patch；验证通过后将 ignored 的 `release/desktop` 产物同步回主工作区。

验证命令：

```bash
cd packages/desktop && node --import tsx --test src/desktop-data.test.ts
```

结果：6 个测试通过，0 失败。

```bash
cd packages/frontend && node --import tsx --test src/components/SettingsDialogs.test.tsx
```

结果：5 个测试通过，0 失败。

```bash
npm run build:desktop
npm run package:desktop
```

结果：均通过；`build:desktop` 仍只有 Vite chunk size warning；`package:desktop` 生成：

- `release/desktop/OpenDeepSea-0.1.0.dmg`
- `release/desktop/OpenDeepSea-0.1.0-mac.zip`

包内结构检查：

```bash
npx asar list release/desktop/mac/OpenDeepSea.app/Contents/Resources/app.asar | rg "packages/(desktop/dist/(main|preload|desktop-data)\\.js|backend/dist/server\\.js)|node_modules/(better-sqlite3|node-pty)/package\\.json"
test -f release/desktop/mac/OpenDeepSea.app/Contents/Resources/frontend-dist/index.html
```

结果：确认 app.asar 包含 `desktop-data.js`、Electron main/preload、backend server，以及 `better-sqlite3` / `node-pty` 依赖；前端生产入口位于 `Contents/Resources/frontend-dist/index.html`。

包内 smoke 结果：

- 使用打包后的 `release/desktop/mac/OpenDeepSea.app/Contents/MacOS/OpenDeepSea` 以 `ELECTRON_RUN_AS_NODE=1` 启动 asar 内 backend。
- 使用临时 `OPENDEEPSEA_DATA_DIR`、`OPENCLAW_ROOM_DB`、`OPENDEEPSEA_FRONTEND_DIST`、`OPENDEEPSEA_LOCAL_TOKEN` 和随机空闲端口。
- `GET /api/health` 返回 ok。
- `GET /` 返回前端 HTML，响应头 `Cache-Control: no-store`。
- `ws://127.0.0.1:<port>/ws` 返回 `403`。
- `ws://127.0.0.1:<port>/ws?localToken=smoke-token` 可连接。

root ABI 检查：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1 as ok').get(); db.close(); console.log('better-sqlite3 node abi ok')"
node -e "const pty=require('node-pty'); console.log(typeof pty.spawn === 'function' ? 'node-pty node abi ok' : 'node-pty missing spawn')"
```

结果：`better-sqlite3 node abi ok`，`node-pty node abi ok`。

## 兼容性修复记录

- 最初使用 `electron@42.3.3` 时，包内 backend smoke 暴露 native ABI 问题：`better-sqlite3` 回退到仓库根依赖或在 Electron 42 / Node 24 ABI 下无法编译。
- 调整为 `electron@38.8.6`、`better-sqlite3@12.10.0`，并将 backend runtime dependencies 提升到 root `dependencies` 后，electron-builder 能复制依赖并完成 `better-sqlite3`、`node-pty` 的 Electron ABI 重建。
- 后续复查发现 electron-builder 内置 rebuild 不足以稳定切换 root native modules 到 Electron ABI；`scripts/package-desktop.mjs` 现在在打包前显式执行强制 source rebuild，打包后再恢复 root Node ABI，避免安装产物和本地开发环境互相污染。

## 代码审查记录

- 主会话审查覆盖：`OPENDEEPSEA_DATA_DIR` 数据目录、上传路径迁移、`OPENDEEPSEA_FRONTEND_DIST` 静态托管、Electron main/preload、后端 sidecar 启停、local token 注入、dev 模式端口/token 与 Vite proxy 对齐、electron-builder 文件包含范围、root runtime dependencies、native module rebuild 和 release 产物忽略。
- 审查结论：未发现 Critical/Important 阻断项。
- 提交边界：`release/` 已加入 `.gitignore`，安装产物仅作为本地验收输出，不纳入提交。

## 已知限制

- 当前 macOS 包未签名、未公证，electron-builder 日志显示 `skipped macOS code signing`。
- 当前使用默认 Electron 图标。
- `npm install` 报告 11 个 vulnerability（10 moderate，1 high），本次未执行 `npm audit fix --force`，避免破坏性升级。
- Electron 打包链路使用 `build:prod` 排除测试文件；普通 workspace `build` 仍保留给 Web/后端开发验证。

## 2026-06-09 无边框窗口与内嵌窗口控制

本轮新增 Electron 无边框窗口与应用内窗口控制，覆盖：

- Electron 主窗口启用 `frame: false`，去掉系统原生标题栏。
- Electron main 进程新增最小化、最大化/还原、关闭、窗口状态查询和状态广播 IPC。
- preload 在 `window.openDeepSeaDesktop` 暴露 `platform`、窗口控制方法和窗口状态订阅。
- AppShell 仅在 Electron 窗口控制 API 存在时渲染窗口按钮。
- macOS 窗口按钮位于顶部栏左侧品牌前，Windows/Linux 位于右侧 actions 后。
- 顶部栏声明 `-webkit-app-region: drag`，顶部栏交互元素和窗口按钮声明 `no-drag`。

验证命令：

```bash
cd packages/frontend && node --import tsx --test src/components/AppShell.test.tsx
npm run build -w @openclaw-room/frontend
npm run build -w @openclaw-room/desktop
```

结果：三条命令均通过。`AppShell.test.tsx` 共 13 个测试通过，0 失败；Vite build 仍只有 chunk size warning。

桌面启动 smoke：

```bash
npm run dev:desktop
```

结果：Vite 和 Electron 启动链路可进入运行态，但本机 5173 已被已有服务占用，Vite 自动切换到 5174，因此该命令不能证明 Electron 加载的是本轮新前端。

随后使用固定空闲端口复测：

```bash
OPENDEEPSEA_LOCAL_TOKEN=openclaw-room-dev-token \
OPENDEEPSEA_DESKTOP_FRONTEND_URL=http://localhost:5178 \
OPENDEEPSEA_DESKTOP_BACKEND_PORT=7339 \
VITE_BACKEND_URL=http://localhost:7339 \
./node_modules/.bin/concurrently -n frontend,desktop -c magenta,cyan \
  "npm run dev -w @openclaw-room/frontend -- --host 127.0.0.1 --port 5178 --strictPort" \
  "npm run dev -w @openclaw-room/desktop"
```

结果：

- Vite 监听 `127.0.0.1:5178`。
- Electron desktop 构建完成并启动，60 秒内无启动错误。
- Electron backend sidecar 监听 `localhost:7339`。
- smoke 结束后已停止本轮启动的 Vite、Electron 和 7339 backend 进程。

说明：当前自动化流程未逐项手动确认窗口拖动、最小化、最大化/还原、关闭按钮点击；这些交互由源码实现、类型构建和 AppShell/CSS 结构测试覆盖，仍建议在最终安装包验收时做一次真实 GUI 点击验收。
