# OpenDeepSea 内置 Skills 设计

## 背景

OpenDeepSea 当前有两类模型执行路径：

1. ACP CLI backend：后端调用 Codex、Claude Code、OpenCode 等外部 CLI，由 CLI 自己负责会话、工具、权限和原生 skills。
2. OpenDeepSea 自有模型路径：LangChain planner、model chat fallback、workflow 节点、memory distill 等直接调用 OpenAI-compatible 模型配置。

外部 CLI 已经可以通过各自生态加载 skills，但 OpenDeepSea 自有模型路径目前只有固定 prompt 和少量系统上下文，缺少可安装、可版本化、可按场景启用的行为模块。本设计目标是引入 OpenDeepSea 自有 Skill Registry，让 planner、model chat、workflow 等内部模型节点也能使用 skills，同时避免和 Codex / Claude Code 原生 skills 重复触发。

## 目标

1. 支持 OpenDeepSea 安装、登记、启用和禁用自有 skills。
2. 让 LangChain planner、model chat fallback、workflow 节点和 memory/review 类内部模型路径按需注入 skills。
3. 明确 OpenDeepSea skills 与外部 ACP CLI skills 的职责边界。
4. 第一阶段采用受控 prompt 注入，不实现任意工具执行、shell 执行或 sandbox runtime。
5. 为后续 tool-capable skills、marketplace、项目级共享能力留下数据和接口扩展点。

## 非目标

1. 不重做 Codex CLI、Claude Code 或 OpenCode 的 skills runtime。
2. 不默认把 OpenDeepSea skills 注入到外部 ACP CLI 调用中。
3. 不在第一阶段执行 skill 中声明的脚本、命令、MCP tool 或任意 action。
4. 不做公开 marketplace、评分、远程自动更新或依赖解析。
5. 不把外部 CLI 的私有 skill 格式强行标准化为唯一格式；只做兼容导入和元数据提取。

## 核心原则

### 分层而不抢权

OpenDeepSea skills 服务于 OpenDeepSea 自己的模型与工作流运行时。外部 ACP CLI 调用仍交给对应 CLI 处理自己的 skills、工具和权限。除非用户或 agent 配置显式开启，否则 OpenDeepSea 不把同名 skill 内容再次注入外部 CLI prompt。

### 先声明，后执行

第一阶段 skill 是可管理的指令模块，不是可执行插件。系统只读取元数据和 Markdown 指令，经过触发、排序、裁剪后注入内部模型 prompt。等 prompt 型能力稳定后，再评估 tool/action runtime。

### 可追踪与可解释

每次内部模型调用命中的 skills 都应可记录：命中原因、注入顺序、裁剪状态和适用 scope。用户调试 planner 或 workflow 行为时，可以看到哪些 skills 影响了该次调用。

### 权限默认收紧

skill 安装可以读取本地文件或 Git 仓库，但第一阶段不执行其中代码。导入时只允许 OpenDeepSea 管理目录内的受控副本参与运行时注入，避免运行时直接引用任意可变路径。

## 系统边界

### 外部 ACP CLI skills

外部 CLI skills 的生命周期由 Codex、Claude Code、OpenCode 自己决定。OpenDeepSea 可以在后续作为管理界面辅助安装或查看，但不解释其完整运行时语义。

调用外部 CLI 时：

- 默认行为：只传用户 prompt、附件、权限参数和 session 参数。
- 不默认注入 OpenDeepSea active skills。
- 如果将来加入 `inject_open_deep_sea_skills_to_acp`，必须作为 agent 级或调用级显式开关，并在运行记录中标记。

### OpenDeepSea 内置 skills

OpenDeepSea skills 只影响以下内部路径：

- `planner`：LangChain 计划生成。
- `model_chat`：聊天室没有可用 agent 或 fallback 直接模型回复。
- `workflow`：LangGraph orchestration 中需要模型判断的节点。
- `memory`：记忆蒸馏、总结、候选提取。
- `review`：代码审查、验收、修复建议等评审型节点。

## 数据模型

新增 `skills` 表：

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL,
  source_uri TEXT,
  install_path TEXT NOT NULL,
  manifest_path TEXT,
  runtime_scopes TEXT NOT NULL,
  trigger_mode TEXT NOT NULL,
  trigger_keywords TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

字段说明：

- `source_type`：`local_directory`、`git_repo`、`manual`，后续可扩展 `marketplace`。
- `runtime_scopes`：JSON array，元素为 `planner`、`model_chat`、`workflow`、`memory`、`review`。
- `trigger_mode`：`manual`、`keyword`、`always_for_scope`。
- `trigger_keywords`：JSON array，保存显式关键词或短语。
- `install_path`：OpenDeepSea 管理目录内的副本路径，例如 `~/.opendeepsea/skills/<id>`。
- `manifest_path`：可为空；如果存在 `SKILL.md` 或 manifest，则记录相对路径。
- `checksum`：记录导入内容的摘要，用于检测本地副本变化。

新增 `skill_bindings` 表：

```sql
CREATE TABLE skill_bindings (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority_override INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id)
);
```

`scope` 支持：

- `system`：全局默认。
- `project`：项目级启用。
- `room`：聊天室级启用。
- `agent`：特定 agent 默认启用。

绑定优先级采用从窄到宽合并：`agent > room > project > system`。窄 scope 可以禁用宽 scope 启用的 skill。

## Skill 文件格式

第一阶段优先兼容 Markdown 型 skill：

```markdown
---
name: test-driven-development
description: Use when implementing high-risk behavior changes.
runtime_scopes:
  - planner
  - workflow
trigger_keywords:
  - TDD
  - test-driven
priority: 80
---

# Instructions

...
```

导入时解析 YAML frontmatter。若没有 frontmatter，则使用目录名或文件名作为 `name`，首段文本作为 `description` 候选，默认 `trigger_mode=manual`。

运行时实际注入的内容分为两段：

1. 摘要段：名称、描述、适用 scope、命中原因。
2. 指令段：从 `SKILL.md` 中抽取正文，按 token 上限裁剪。

## 后端模块设计

### `skills/repo.ts`

职责：

- CRUD `skills` 和 `skill_bindings`。
- 解析 JSON 字段。
- 处理 scope 合并和 enable/disable 结果。

### `skills/installer.ts`

职责：

- 从本地目录导入 skill。
- 从 Git repo clone 到临时目录后复制到管理目录。
- 校验目录中是否存在 `SKILL.md` 或可识别 manifest。
- 计算 checksum。
- 禁止安装路径逃逸到管理目录外。

第一阶段安装不执行任何 postinstall。

### `skills/loader.ts`

职责：

- 读取 `SKILL.md`。
- 解析 frontmatter。
- 提取运行时可注入内容。
- 对超长正文做裁剪。
- 返回结构化 `LoadedSkill`。

### `skills/selector.ts`

职责：

- 输入 runtime scope、project、room、agent、用户消息、当前任务上下文。
- 读取有效 bindings。
- 根据 trigger mode 和关键词选择候选。
- 按 priority、scope specificity、name 排序。
- 去重并应用数量/token 上限。

### `skills/prompt.ts`

职责：

- 把选中的 skills 格式化为内部模型 system context。
- 标记命中原因和优先级。
- 为调试日志返回注入摘要。

示例注入格式：

```text
OpenDeepSea active skills for this runtime:

Skill: test-driven-development
Reason: keyword match "TDD"; scope=workflow; priority=80
Instructions:
...
```

## API 设计

### Skills 管理

- `GET /api/skills`
- `POST /api/skills/import/local`
- `POST /api/skills/import/git`
- `GET /api/skills/:skillId`
- `PATCH /api/skills/:skillId`
- `DELETE /api/skills/:skillId`

删除采用软删除或禁用优先；如果物理删除，必须只删除 OpenDeepSea 管理目录内副本，不删除用户原始目录。

### 绑定管理

- `GET /api/skills/bindings?scope=project&scopeId=...`
- `PUT /api/skills/bindings`
- `DELETE /api/skills/bindings/:bindingId`

### 运行时调试

- `POST /api/skills/preview-selection`

输入 runtime scope、project/room/agent 和用户消息，返回会命中的 skills、命中原因、排序和裁剪状态。这个接口用于 UI 调试，不调用模型。

## Prompt 注入链路

### Planner

`buildPlannerMessages` 在 system message 中追加 `planner` scope 命中的 skill context。注入位置应在 OpenDeepSea planner 基础规则之后、用户输入之前。基础 schema 约束和 JSON 输出要求优先级高于 skill 指令。

### Model Chat

`buildModelChatMessages` 在 system message 中追加 `model_chat` scope 命中的 skill context。skill 可以改变回答风格、工作流建议、问题澄清方式，但不能声明已执行文件修改。

### Workflow

LangGraph 节点在需要模型判断时按节点类型选择 scope：

- 计划、拆分、调度：`workflow` + `planner`。
- 审查、验收：`workflow` + `review`。
- 记忆总结：`workflow` + `memory`。

同一调用中如果多个 scope 命中同一 skill，只注入一次，并记录所有命中原因。

### Memory

记忆蒸馏只允许注入 `memory` scope skills。为避免污染事实提取，memory skills 不能覆盖“不要编造、只从对话抽取”的基础规则。

## 冲突与优先级

内部模型路径的指令优先级：

1. 用户当前明确要求。
2. 仓库 `AGENTS.md`、项目级规则和当前任务约束。
3. OpenDeepSea runtime 固定安全规则和输出 schema。
4. OpenDeepSea active skills。
5. 历史记忆和默认风格偏好。

外部 ACP CLI 调用的优先级由外部 CLI 自己决定。OpenDeepSea 只负责传递用户 prompt 和必要上下文，不解释 CLI 内部 skill 优先级。

如果 OpenDeepSea skill 与 runtime 固定 schema 冲突，runtime 固定 schema 胜出。例如 planner skill 要求输出 Markdown，但 planner runtime 要求 fenced JSON，则必须输出 fenced JSON。

## 去重策略

第一阶段不主动扫描外部 CLI 已加载 skills。因此采用保守策略：

- OpenDeepSea skills 不默认注入外部 ACP CLI。
- OpenDeepSea 内部模型调用只使用 registry 中 `runtime_scopes` 匹配的 skills。
- 同名 skill 在多个 scope 命中时，只注入最高优先级版本。
- 同一 skill 的多个 bindings 合并为一个注入条目。

后续如果实现外部 CLI skill 管理，可以增加 `provider_owned` 或 `external_provider` 字段，用来标记某个 skill 仅由 Codex / Claude Code 消费。

## UI 设计

第一阶段新增设置页或设置分区“Skills”：

- Skills 列表：名称、描述、来源、启用状态、runtime scopes、priority、更新时间。
- 导入入口：本地目录、Git 仓库 URL。
- 详情页：查看 metadata、正文预览、checksum、绑定列表。
- 绑定配置：system/project/room/agent 级启用、禁用和 priority override。
- Preview：选择 runtime scope 和输入消息，查看命中的 skills。

UI 应清楚区分：

- “OpenDeepSea 内置 skills”：影响 planner/model chat/workflow。
- “外部 CLI skills”：由 Codex / Claude Code 自行加载，第一阶段不在此页管理或只作为说明入口。

## 安全设计

1. Git 导入只 clone 到临时目录，再复制允许文件到管理目录。
2. 第一阶段不执行 skill 内任何脚本或命令。
3. 读取文件时限制在 `install_path` 内，防止 symlink/path traversal 逃逸。
4. API 不返回本地绝对路径给非必要前端字段；详情页可显示脱敏路径或相对路径。
5. 删除只作用于 OpenDeepSea 管理副本。
6. prompt 注入有最大 skill 数和最大字符/token 上限。

## 配置建议

默认限制：

- 单次模型调用最多注入 3 个 skills。
- 单个 skill 正文最多 4000 字符。
- 全部 skills 注入最多 9000 字符。
- `always_for_scope` skill 每个 scope 默认最多 1 个，避免全局规则膨胀。

这些限制应可通过后端常量或系统设置调整，但第一阶段无需暴露高级 UI。

## 测试策略

### 单元测试

- frontmatter 解析：完整、缺失、非法 YAML。
- installer 路径校验：本地目录、Git 目录、路径逃逸、缺失 `SKILL.md`。
- selector：scope 合并、禁用覆盖、关键词命中、manual 不自动命中、priority 排序、去重。
- prompt formatter：裁剪、命中原因、schema 规则不被覆盖。

### 集成测试

- planner 调用构造消息时注入 `planner` skills。
- model chat 构造消息时注入 `model_chat` skills。
- workflow review 节点只注入 `review/workflow` 相关 skills。
- memory distill 不注入非 `memory` skills。

### 回归测试

- ACP CLI 参数构造保持不变，默认不注入 OpenDeepSea skills。
- 没有启用 skills 时，planner/model chat 输出消息结构保持兼容。
- skill 内容超长时不会导致请求构造失败。

## 分阶段实施

### 阶段 1：Registry 与 Prompt 注入

1. 新增 DB migration、repo、类型定义。
2. 实现本地目录导入和 Markdown loader。
3. 实现 selector 和 prompt formatter。
4. 接入 planner、model chat、workflow review/memory 的消息构造。
5. 增加 preview-selection API。
6. 增加基础 UI 列表、导入、绑定和预览。

### 阶段 2：Git 导入与调试可观测性

1. 支持 Git repo 导入。
2. 在 model/workflow run metadata 中记录命中的 skill 摘要。
3. 在运行详情 UI 展示 active skills。
4. 增加 checksum 变化提示和重新导入。

### 阶段 3：外部 CLI Skills 管理协同

1. 增加外部 CLI skill 安装状态查看。
2. 建立 `provider_owned` 标记，避免重复注入。
3. 可选支持 agent 级开关，将 OpenDeepSea skill 摘要注入外部 ACP CLI。

### 阶段 4：Tool-capable Skills 评估

只有在 prompt 型 skills 证明有稳定价值后，才评估工具执行能力。该阶段必须单独设计权限、审计、sandbox、工具 schema 和用户确认机制。

## 验收标准

1. 用户可以导入一个本地 Markdown skill，并在 Skills 页面看到 metadata。
2. 用户可以把 skill 绑定到 project 或 room，并限定 runtime scope。
3. `preview-selection` 能解释某条消息为什么命中或未命中 skill。
4. planner/model chat/workflow 内部模型调用能按 scope 注入命中的 skills。
5. 默认调用 Codex / Claude Code / OpenCode 时，命令参数和 prompt 不因为 OpenDeepSea skills 改变。
6. 未安装或未启用任何 skill 时，现有行为保持兼容。
7. 超长、非法或缺少 frontmatter 的 skill 不会导致服务崩溃，并能给出可诊断错误。

## 风险与缓解

### Prompt 膨胀

风险：全局启用过多 skills 导致模型上下文膨胀、成本上升和行为漂移。

缓解：限制数量和字符数；默认 manual/keyword 触发；提供 preview；记录注入摘要。

### 指令冲突

风险：skill 与 runtime schema 或用户要求冲突。

缓解：明确优先级；runtime 固定 schema 始终高于 skill；冲突时在调试摘要中标记。

### 与外部 CLI 重复

风险：同一工作流 skill 被 OpenDeepSea 和 Codex / Claude Code 各注入一次。

缓解：默认不向外部 CLI 注入 OpenDeepSea skills；后续用 `provider_owned` 标记协同。

### 安装来源不可信

风险：Git 或本地导入的 skill 包含恶意脚本或路径逃逸。

缓解：第一阶段不执行代码；复制到管理目录；限制 symlink 和路径访问；删除只删管理副本。

## 推荐结论

OpenDeepSea 有必要开发自有 skills，但应从 Registry + 受控 prompt 注入开始，而不是直接实现完整 plugin/runtime。这样可以补齐内部模型路径的可复用行为能力，同时把外部 ACP CLI skills 留在各自生态中，避免职责重叠和调试复杂度失控。
