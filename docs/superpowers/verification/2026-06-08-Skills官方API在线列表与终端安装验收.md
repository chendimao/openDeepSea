# Skills 官方 API 在线列表与终端安装验收

## 范围

- `/skills` 默认通过后端代理加载 `skills.sh` 官方在线 skills 列表。
- 后端读取 `SKILLS_SH_API_TOKEN`，无显式 token 时回退到 `VERCEL_OIDC_TOKEN`。
- token 只存在于后端请求链路，不进入前端、localStorage、终端环境、日志或 UI。
- 安装入口使用 `skills_install` 受限终端，并通过 `initialInput` 预填命令，不自动追加回车。
- 在线 skill 叠加本地 Codex、Claude Code、OpenCode 安装状态。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `cd packages/backend && node --import tsx --test src/online-skills/cache.test.ts src/online-skills/client.test.ts src/online-skills/service.test.ts src/online-skills/routes.test.ts src/terminal/restricted-skills-shell.test.ts` | PASS，21 tests |
| `node --import tsx --test packages/frontend/src/lib/api.test.ts packages/frontend/src/components/TerminalPanel.test.tsx packages/frontend/src/pages/SkillsPage.test.tsx` | PASS，24 tests |
| `npm run build` | PASS |

## 浏览器 Smoke

- `http://localhost:5173/skills` 已在桌面视口和 390px 移动视口截图验证。
- 当前本机未配置 `SKILLS_SH_API_TOKEN` 或 `VERCEL_OIDC_TOKEN`，后端 `/api/online-skills?limit=1` 返回 `503`，页面显示 `skills.sh API token is not configured or has expired`。
- 窄屏下 Skills 页面降级为侧栏和列表上下堆叠，详情面板隐藏，避免三栏固定布局裁切主内容。

## 关键安全点

- 安装命令格式为 `npx skills add <installUrl> --skill <slug>`。
- `restricted-skills-shell` 只允许 `skills` / `npx skills` 的 `find/add/check/update` 命令，不允许 shell 运算符、管道、重定向或命令替换。
- `TerminalPanel.initialInput` 只发送命令文本，不发送 `\n` 或 `\r`，需要用户在终端中确认执行。

## 备注

真实在线列表需要在后端环境中配置 `SKILLS_SH_API_TOKEN` 或 `VERCEL_OIDC_TOKEN`。未配置 token 时，页面保持在线列表模式并显示配置错误，不回退到网页爬取或无 token 社区源。
