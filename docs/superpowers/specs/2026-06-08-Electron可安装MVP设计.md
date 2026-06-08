# Electron 可安装 MVP 设计

## 目标

将 OpenDeepSea 扩展为 Web 与桌面端复用同一套前端和后端业务逻辑的跨平台项目，第一阶段交付 Electron 版本的可安装 MVP。

桌面端定位为纯本地开发工具：启动本机后端、使用本机 SQLite 数据、访问本机项目目录、复用本机 ACP CLI、提供本机终端能力。Web 端保持现有浏览器访问方式，并为未来连接远程后端保留 API/WS 边界。

## 非目标

- 不实现远程账号、团队协作、多租户和远程权限模型。
- 不重写现有 React 页面和业务交互。
- 不引入 Tauri、Rust sidecar 或后端语言迁移。
- 不默认启用自动更新、代码签名、公证和安装器品牌素材完善。

## 推荐方案

采用 Electron main process 管理现有 Node 后端 sidecar。

Electron main process 负责：

- 生成本次桌面运行的本地访问 token。
- 分配 `127.0.0.1` 空闲端口。
- 启动 `packages/backend` 后端进程。
- 将桌面数据目录注入为后端 `OPENDEEPSEA_DATA_DIR` 与 `OPENCLAW_ROOM_DB`。
- 在生产桌面包中让后端托管 `packages/frontend/dist`。
- 通过 preload 在 renderer 的 localStorage 中写入 `opendeepsea.localToken`。
- 在应用退出时终止后端子进程。

后端保持 Express + WebSocket 架构，只增加两个桌面适配点：

- 数据目录不再只依赖源码相对路径，支持 `OPENDEEPSEA_DATA_DIR`。
- 当 `OPENDEEPSEA_FRONTEND_DIST` 存在时，后端托管前端静态资源，并对 SPA 路由返回 `index.html`。

## 运行模式

### Web 开发模式

现有 `npm run dev` 保持不变：

- Vite 运行在 `localhost:5173`。
- 后端运行在 `localhost:7330`。
- Vite 代理 `/api`、`/ws`、`/uploads`。

### Electron 开发模式

新增 `npm run dev:desktop`：

- 启动 Vite 前端。
- Electron main 启动后端开发进程。
- Electron 窗口加载 Vite URL。
- preload 写入 local token，使本地敏感接口可用。

### Electron 生产打包模式

新增 `npm run package:desktop`：

- 构建后端、前端与桌面 main/preload。
- Electron builder 生成当前平台安装包。
- 打包后的 Electron 应用使用 `ELECTRON_RUN_AS_NODE=1` 启动后端 JS。
- 后端从应用资源中托管前端 build。
- 用户数据写入系统 app data 目录，不写入源码或只读安装目录。

## 数据与安全边界

桌面端所有数据库、上传文件、日志都进入 Electron `app.getPath('userData')` 下的子目录。

本地后端只绑定 `127.0.0.1`。Electron main 为每次运行生成随机 token，并通过 preload 注入给 renderer。Workspace 文件访问、终端、skills、provider config 等已有 protected API 继续要求 `X-OpenDeepSea-Local-Token`。

未来 Web 远程化时，浏览器客户端通过远程 origin 连接后端，远程后端应通过 capability 声明隐藏本地专属能力。本 MVP 不实现远程后端，只避免把前端进一步写死为桌面专属。

## 文件结构

新增：

- `packages/desktop/`：Electron main、preload、TypeScript 配置和 workspace package。
- `electron-builder.json`：根级桌面打包配置。
- `docs/superpowers/plans/2026-06-08-Electron可安装MVP实施计划.md`：实施计划。

修改：

- `package.json`：新增桌面开发、构建和打包脚本。
- `package-lock.json`：记录 Electron 相关依赖。
- `packages/backend/src/db.ts`：读取统一数据目录。
- `packages/backend/src/uploads.ts`：上传根目录读取统一数据目录。
- `packages/backend/src/server.ts`：支持 host 绑定和前端静态托管。

## 验证方式

最低验证门禁：

- `npm run build -w @openclaw-room/backend`
- `npm run build -w @openclaw-room/frontend`
- `npm run build -w @openclaw-room/desktop`
- `npm run pack:desktop`

补充验证：

- 后端 data-dir 单元测试。
- 前端静态托管路由辅助测试。
- 检查 Electron 打包产物目录存在。

## 风险

- `better-sqlite3` 和 `node-pty` 是 native dependencies，生产打包需要 Electron ABI rebuild。
- 首个 MVP 不做签名和公证，macOS 首次运行可能需要用户手动信任。
- 包含 Node 后端与 native deps 后，安装包体积会明显大于 Tauri 方案。
- 远程 Web 模式仅保留架构边界，不在本阶段交付。
