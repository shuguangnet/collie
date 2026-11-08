# AGENTS.md

The working agreement for this repo lives in [`CLAUDE.md`](./CLAUDE.md) — read it before changing
anything. It is the authoritative source of engineering, security, testing and release rules.
This file is a navigation guide, not a second working agreement.

@CLAUDE.md

## 项目导航

Collie 是终端 AI agent 的移动端 PWA，不是 Herdr 本身。沿以下路径理解项目：

| 关注点 | 入口 |
| --- | --- |
| 全局架构与部署模型 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、[`README.md`](./README.md) |
| CLI、远端安装与后台服务 | `cli/program.ts`、`cli/remote.ts`、`cli/lifecycle.ts`、`cli/unit.ts` |
| HTTP 服务与状态同步 | `bridge/index.ts`、`bridge/server.ts`、`bridge/state-engine.ts` |
| multiplexer 适配 | `bridge/mux/`、[`MUX_CONTRACT.md`](./MUX_CONTRACT.md)、[`HERDR_API.md`](./HERDR_API.md) |
| 多机 Crew 与持久身份 | `bridge/crew/`、[`CREW_PROTOCOL.md`](./CREW_PROTOCOL.md)、[`docs/crew.md`](./docs/crew.md) |
| 手机配对与授权 | `cli/pairing.ts`、`bridge/pairing.ts`、`web/src/lib/pairing.ts` |
| 前端路由与请求 | `web/src/router.tsx`、`web/src/lib/loaders.ts`、`web/src/lib/api.ts` |
| agent 日志与交互识别 | `bridge/journal/`、`web/src/lib/harness/`、[`HARNESS_CONTRIBUTING.md`](./HARNESS_CONTRIBUTING.md) |
| 界面规范与组件 | [`DESIGN.md`](./DESIGN.md)、`web/src/components/ui/`、`web/src/playground/` |
| 集成测试与浏览器验证 | `integration/`、`web/e2e/`、`web/e2e/rig/README.md` |
| Durable agent 接入 | `packages/durable-sdk/`、`examples/` |

架构文档部分段落早于当前功能；驱动、命令、语言数量等事实以代码和专项契约为准。
更详细的本轮分析见 [`openspec/project-analysis.md`](./openspec/project-analysis.md)。

## OpenSpec 规划入口

- 配置：[`openspec/config.yaml`](./openspec/config.yaml)。正文使用简体中文，保留 OpenSpec
  结构标题与 `SHALL` / `MUST` 关键字。
- 当前提案：[`persistent-herdr-machines`](./openspec/changes/persistent-herdr-machines/proposal.md)。
  阅读顺序为 `proposal.md` → `specs/*/spec.md` → `design.md` → `tasks.md`。
- 本轮交付停在规划阶段；任务未勾选表示尚未实现，不代表已有产品能力。
- 实现前仍需阅读 `CLAUDE.md` 和相关 `.adr/`，尤其 0011、0013、0015、0016、0040、0086。
  提案不是覆盖现有安全决策的授权。
- 使用 OpenSpec CLI 查看状态和验证；当前仅初始化工具中立目录，未安装 Pi 的 slash commands。
  已有 `openspec` 时运行：

  ```sh
  openspec status --change persistent-herdr-machines
  openspec validate persistent-herdr-machines --strict
  ```

仓库沿用通用入口名 `AGENTS.md`，不另建容易分叉的 `Agent.md`。
