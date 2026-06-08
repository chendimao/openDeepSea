# Skills 官方 API 在线列表与终端安装设计

## 背景

当前 `/skills` 页面已经具备两类基础能力：

1. 扫描本机 Codex、Claude Code、OpenCode 的原生 skills 目录，并聚合展示本地安装状态。
2. 通过 `skills_install` 受限终端运行 `npx skills find/add/check/update` 等安装相关命令，处理安装过程中的交互式问题。

前期讨论过无 token 社区数据源和网页抓取方案。社区公开 API 可作为补充，但网页抓取存在 Cloudflare 风控、页面结构变更、限流不可控和长期维护成本。因此本轮收敛为：使用 `skills.sh` 官方 token API 作为在线 skills 列表主数据源，前端默认展示在线列表，安装仍通过现有受限终端完成。

## 目标

1. `/skills` 页面默认展示在线 skills 列表，而不是只展示本地已安装矩阵。
2. 在线列表由后端代理调用 `skills.sh` 官方 API 获取，前端不接触 token。
3. 支持列表、搜索、筛选、详情和可选 audit 信息。
4. 在线 skill 的安装入口复用现有 `skills_install` 受限终端，保留安装过程中的交互能力。
5. 在线列表叠加本地安装状态，显示该 skill 是否已安装到 Codex、Claude Code、OpenCode。
6. 后端缓存官方 API 响应，降低 token 请求频率并提升页面稳定性。

## 非目标

1. 不再使用网页爬取作为主数据源。
2. 不在 Skills 页面开放完整 shell。
3. 不实现静默下载、解压、复制安装器；第一版仍以终端安装为准。
4. 不把官方 token 暴露给浏览器、localStorage、日志或终端环境。
5. 不要求第一版把所有社区目录统一聚合进来。
6. 不在安装按钮中自动回答第三方安装器的交互问题。

## 已确认产品决策

1. 使用 `skills.sh` 官方 token API 作为在线列表主数据源。
2. 后端负责 token 获取、外部 API 调用、缓存和错误兜底。
3. `/skills` 默认视图切为在线 skills 列表。
4. 本地三平台安装状态继续保留，用于在线列表状态叠加和本地管理视图。
5. 安装通过页面内受限终端执行，交互问题由用户在终端里回答。
6. Skills 页面仍只能使用 `skills_install` profile，不能使用 `project_shell`。

## 官方 API 接入

后端新增 `online-skills` 子系统，封装对 `https://skills.sh/api/v1` 的访问。

计划使用的官方接口：

- `GET /api/v1/skills`：在线 skills 列表，支持 all-time、trending、hot 等视图。
- `GET /api/v1/skills/search?q=...`：关键词搜索。
- `GET /api/v1/skills/{id}`：skill 详情。
- `GET /api/v1/skills/audit/{id}`：audit 信息，404 表示暂无审计结果。
- `GET /api/v1/skills/curated`：可选精选列表，用于后续推荐区。

认证方式：

- 后端从运行环境读取 `VERCEL_OIDC_TOKEN`，或通过官方 OIDC 获取方式生成 Bearer token。
- 所有外部请求统一附带 `Authorization: Bearer <token>`。
- 如果 token 缺失，后端返回明确的配置错误，不让前端直接访问官方 API。

## 后端架构

新增模块建议：

- `packages/backend/src/online-skills/types.ts`
- `packages/backend/src/online-skills/client.ts`
- `packages/backend/src/online-skills/service.ts`
- `packages/backend/src/online-skills/routes.ts`
- `packages/backend/src/online-skills/cache.ts`

职责划分：

1. `client.ts`：只负责拼接官方 API 请求、设置认证头、解析响应和统一错误。
2. `cache.ts`：提供内存 TTL 缓存，按请求类型和参数生成 key。
3. `service.ts`：把官方响应规范化为 OpenDeepSea 内部 `OnlineSkill` 结构，并叠加本地安装状态。
4. `routes.ts`：暴露前端所需的本地 API。

本地 API：

```http
GET /api/online-skills?view=all-time&page=1&limit=30
GET /api/online-skills/search?q=browser&page=1&limit=30
GET /api/online-skills/:id
GET /api/online-skills/:id/audit
```

响应中的核心对象：

```ts
type OnlineSkill = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skills_sh';
  sourceUrl: string;
  installUrl: string | null;
  installCommand: string;
  tags: string[];
  author: string | null;
  stars: number | null;
  installs: number | null;
  updatedAt: number | null;
  auditStatus: 'unknown' | 'none' | 'available';
  installedProviders: Array<'codex' | 'claudecode' | 'opencode'>;
};
```

## 缓存策略

后端缓存官方 API 响应，避免每次页面刷新都打到官方服务。

建议 TTL：

- 列表和搜索：60 秒。
- 详情：5 分钟。
- audit：5 分钟；404 也缓存 5 分钟。
- token 获取结果：按 token 自身有效期或较短安全 TTL 缓存。

缓存只保存在后端内存中，重启后自然失效。第一版不需要持久化远程列表。

## 安装命令生成

在线 skill 卡片的安装按钮打开现有 `skills_install` 终端，并传入建议命令。

命令生成规则：

```bash
npx skills add <installUrl> --skill <name>
```

如果官方详情已经返回更准确的安装命令，则优先使用官方安装命令；但命令必须通过 `skills_install` 白名单校验。

受限终端需要继续保持以下原则：

1. 只允许 `npx skills` 或 `skills` 的安装相关子命令。
2. 禁止 shell 运算符、管道、重定向、命令替换和环境变量前缀。
3. 终端中的安装交互直接交给用户处理。
4. 命令结束后触发本地三平台 skills 重新扫描。

## 前端体验

`/skills` 页面调整为三层信息结构：

1. 顶部统计：在线数量、已安装数量、Codex/Claude Code/OpenCode 覆盖情况、最近更新时间。
2. 主区域默认展示在线 skills 列表，支持搜索、view 切换、标签筛选和安装状态筛选。
3. 侧边或标签页保留本地管理视图，用于查看本地已安装矩阵、无效 skill、刷新扫描和终端入口。

在线 skill 卡片展示：

- 名称、作者、描述、标签。
- stars、installs、更新时间。
- `已安装到 Codex / Claude Code / OpenCode` 状态徽标。
- `安装` 按钮。
- `详情` 和 `审计` 入口。

点击安装：

1. 打开安装终端抽屉。
2. 显示目标 skill 的名称、来源和建议命令。
3. 默认预填命令并等待用户按 Enter，避免误触后立即执行远程安装。
4. 用户也可以手动编辑命令，只要仍满足受限终端白名单。
5. 命令结束后刷新本地安装状态。

## 错误处理

后端错误分为四类：

1. `token_missing`：未配置 token，前端显示“需要配置 skills.sh API token”。
2. `upstream_unavailable`：官方 API 不可用，前端保留上一次缓存结果，提示稍后重试。
3. `upstream_rate_limited`：官方 API 限流，前端提示当前在线列表暂不可刷新。
4. `audit_not_found`：暂无 audit，详情页显示“暂无审计结果”。

如果列表请求失败但存在缓存，后端返回缓存并附带 `stale: true`。如果无缓存，前端显示空状态和配置/重试操作。

## 安全边界

1. token 只存在后端环境和后端请求头中。
2. 后端日志不得输出 token、完整 Authorization header 或带敏感信息的错误对象。
3. 前端只调用 OpenDeepSea 本地 API。
4. 安装命令只进入 `skills_install` 受限终端。
5. `project_shell` 不出现在 Skills 页面。
6. 安装成功与否以本地三平台扫描结果为准，不以终端输出文案为准。

## 测试与验证

后端测试：

1. `online-skills/client` 正确拼接 Authorization header，但日志和响应不会泄漏 token。
2. 列表、搜索、详情、audit 404 都能规范化为稳定响应。
3. token 缺失时返回配置错误。
4. 缓存命中、缓存过期、stale fallback 行为正确。
5. 安装命令生成不允许越过 `skills_install` 白名单。

前端测试：

1. `/skills` 默认请求在线列表。
2. 在线列表失败时显示配置错误或 stale 提示。
3. 已安装 providers 能正确叠加到在线 skill 卡片。
4. 点击安装打开受限终端，并预填对应安装命令。
5. 终端退出后触发本地 skills 重新扫描。

验收命令：

```bash
npm run build
```

可选浏览器验收：

1. 打开 `http://localhost:5173/skills`。
2. 确认默认展示在线 skills 列表。
3. 搜索一个 skill。
4. 点击安装，确认打开的是 Skills 安装终端。
5. 完成或退出终端后，本地安装状态刷新。

## 后续扩展

1. 在官方 API 不可用时，可把 SkillsMD 或 VoltAgent awesome-agent-skills 作为显式开启的备用源。
2. 增加“官方精选”区，来源为 curated endpoint。
3. 支持离线缓存最近一次在线列表。
4. 支持安装历史记录，但仍不保存完整终端日志。
5. 增加 token 配置状态页，提示当前 API 可用性和最近刷新时间。
