# Product

## Register

product

## Users

OpenDeepSea 面向在本机开发环境中协调多个 ACP agent 的开发者和项目维护者。用户在聊天室、任务面板和会话工作区中查看上下文、派发任务、跟踪 agent 运行状态，并复用本地 CLI session 继续开发。

## Product Purpose

OpenDeepSea 是本地优先的 ACP 多智能体协作项目管理系统。它让 Claude Code、OpenCode、Codex 等 ACP 后端以房间 agent 的形式协作，围绕项目、聊天室、任务、资源和运行记录完成开发工作。成功体验是：用户能快速理解当前会话状态，可靠地派发任务，并清楚看到 agent 输出、思考记录、工具事件和可执行后续动作。

## Brand Personality

精确、克制、工作流导向。界面应像深海指挥中心一样提供高密度信息，但保持清晰层级和稳定控件，不用装饰性视觉干扰任务判断。

## Anti-references

避免营销式 landing page、过度玻璃拟态、装饰性动效、低对比灰字、过大的英雄标题、卡片套卡片，以及把兼容名称或内部迁移字段包装成用户可见运行时依赖。

## Design Principles

1. 信息优先：消息正文、任务状态和运行证据必须比装饰更突出。
2. 本地可信：权限、路径、agent 后端和 session 复用状态要清楚可追踪。
3. 高密度但可扫读：使用稳定字号、紧凑间距、明确分隔和单一控件语言。
4. 行为可回放：关键运行状态、思考耗时、工具事件和任务流转要在界面中留下证据。
5. 局部改进：UI 调整优先贴合现有 React、Tailwind、CSS token 和 ai-elements 组件边界。

## Accessibility & Inclusion

默认以 WCAG AA 为目标。正文对比度不低于 4.5:1；状态信息不能只依赖颜色；交互控件保留可读 `aria-label`、`aria-pressed` 和键盘焦点；动效只用于状态反馈，并遵守 reduced motion 降级。
