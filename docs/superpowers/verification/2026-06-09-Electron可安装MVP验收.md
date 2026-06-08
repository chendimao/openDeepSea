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
npx asar list release/desktop/mac/OpenDeepSea.app/Contents/Resources/app.asar | rg "packages/(desktop/dist/main.js|desktop/dist/preload.js|backend/dist/server.js|frontend/dist/index.html)|packages/backend/package.json"
```

结果：确认 app.asar 包含：

- `/packages/backend/dist/server.js`
- `/packages/backend/package.json`
- `/packages/desktop/dist/main.js`
- `/packages/desktop/dist/preload.js`
- `/packages/frontend/dist/index.html`
- `/node_modules/better-sqlite3/package.json`
- `/node_modules/node-pty/package.json`
- `/node_modules/express/package.json`

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

## 兼容性修复记录

- 最初使用 `electron@42.3.3` 时，包内 backend smoke 暴露 native ABI 问题：`better-sqlite3` 回退到仓库根依赖或在 Electron 42 / Node 24 ABI 下无法编译。
- 调整为 `electron@38.8.6`、`better-sqlite3@12.10.0`，并将 backend runtime dependencies 提升到 root `dependencies` 后，electron-builder 能复制依赖并完成 `better-sqlite3`、`node-pty` 的 Electron ABI 重建。

## 代码审查记录

- 主会话审查覆盖：`OPENDEEPSEA_DATA_DIR` 数据目录、上传路径迁移、`OPENDEEPSEA_FRONTEND_DIST` 静态托管、Electron main/preload、后端 sidecar 启停、local token 注入、dev 模式端口/token 与 Vite proxy 对齐、electron-builder 文件包含范围、root runtime dependencies、native module rebuild 和 release 产物忽略。
- 审查结论：未发现 Critical/Important 阻断项。
- 提交边界：`release/` 已加入 `.gitignore`，安装产物仅作为本地验收输出，不纳入提交。

## 已知限制

- 当前 macOS 包未签名、未公证，electron-builder 日志显示 `skipped macOS code signing`。
- 当前使用默认 Electron 图标。
- `npm install` 报告 11 个 vulnerability（10 moderate，1 high），本次未执行 `npm audit fix --force`，避免破坏性升级。
- Electron 打包链路使用 `build:prod` 排除测试文件；普通 workspace `build` 仍保留给 Web/后端开发验证。
