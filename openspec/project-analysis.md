# Collie 项目分析：固定机器与持久连接

## 分析范围

本次基于 1.28.0 的代码和文档梳理主要子系统、机器连接、配对、服务生命周期与测试入口。
这是静态分析，不是对每个 agent 解析器的完整审计，也没有连接、部署或重启用户的任何目标机器。
当前环境没有 Bun 和 Nix，也没有项目依赖目录，因此未执行产品测试或构建。

## 项目全貌

Collie 将已有终端 agent 的状态和操作搬到手机，而不替代终端 multiplexer。

```text
手机 / 桌面 PWA
  -> Tailscale Serve 或符合部署约定的反向代理
  -> lead Collie（Bun HTTP API、静态资源、设备授权）
       -> 本机 mux adapter -> Herdr / herdr-core / tmux / zellij
       -> Crew 加密链路 -> peer Collie -> 目标机本地 mux
```

| 子系统 | 主要文件 | 职责 |
| --- | --- | --- |
| CLI 入口 | `cli/main.ts`、`cli/program.ts` | 命令注册、引导构建、依赖注入 |
| 配置 | `cli/context.ts`、`bridge/config*.ts` | 配置目录、实例、状态目录、配置层合并 |
| 生命周期 | `cli/lifecycle.ts`、`cli/unit.ts`、`cli/task-scheduler.ts` | Linux、macOS、Windows 服务管理及无监督降级 |
| 网络入口 | `cli/serve.ts`、`bridge/server.ts` | 发布入口、Host/Origin/设备门禁、API |
| 远端安装 | `cli/remote.ts`、`cli/crew.ts` | SSH 探测、版本分发、配置、加入 Crew |
| 机器候选 | `cli/candidates.ts`、`cli/ssh-config.ts`、`bridge/mux/host-candidates.ts` | 合并 SSH、Herdr、herdr-core 的候选机器 |
| Crew | `bridge/crew/` | 身份、证书固定、注册、路由、转发、恢复、故障接管 |
| mux 适配 | `bridge/mux/registry.ts`、各驱动目录、`bridge/dial.ts` | 统一能力契约与本机连接 |
| 状态与通知 | `bridge/state-engine.ts`、`bridge/event-poker.ts`、`bridge/notifications.ts` | 快照、事件触发轮询、通知 |
| agent 会话 | `bridge/journal/`、`web/src/lib/harness/` | 日志历史、屏幕识别与安全交互 |
| 前端 | `web/src/router.tsx`、`lib/loaders.ts`、`lib/api.ts` | React Router 数据流、轮询、操作 |
| 机器界面 | `web/src/routes/machines.tsx`、`machine.tsx`、`crew.tsx` | 已注册机器与连接状态 |
| 设备身份 | `bridge/pairing.ts`、`cli/pairing.ts`、`web/src/lib/pairing.ts` | 一次配对、token 持久化与撤销 |
| 扩展能力 | `packages/durable-sdk/`、`examples/`、`herdr-app-mod/` | Durable agent 和 Herdr 集成 |
| 工程验证 | `scripts/`、`integration/`、`web/e2e/`、`.github/workflows/` | 版本、契约、单测、真实链路、浏览器和发布 |

根 `package.json` 定义后端、CLI 和脚本测试；`web/package.json` 定义 Vitest、类型检查及
Playwright。根类型检查不覆盖全部前端，后续功能变更必须运行两侧检查。

## 用户痛点与已经具备的能力

机器候选、可信成员、SSH 管理信息、手机配对是四件不同的事。

| 用户期望 | 当前事实 | 判断 |
| --- | --- | --- |
| 固定保存机器 | Crew 的 `crew-trust.json` 已持久保存成员和证书 | 应复用，不再建第二份可信机器列表 |
| 直接填写机器 | `collie crew add <ssh-host> --mux herdr` 已绕过候选选择 | 显式添加已经存在，不必每次“匹配” |
| 使用已有 Herdr 机器 | 无参数 `crew add` 可读取 Herdr、hc 和 SSH 列表 | 只是首次候选，不能把发现结果自动当信任 |
| 不登录目标机逐个安装 | `crew add` 已通过 SSH 完成安装、配置和加入 | 重点补常驻验证，而非重新实现安装器 |
| 无需反复配对 | token 默认无到期时间，浏览器存储和服务端文件均持久化 | 应诊断丢失原因，不删除授权门禁 |
| 断线自动恢复 | mux 轮询、watch 重连、Crew 探测、浏览器重试已存在 | 重点做故障分层、验证和可见性 |
| 不依赖打开 Herdr 窗口 | Collie 独立服务已存在，但仍依赖 Herdr socket 存活 | Collie 常驻不等于 Herdr 自动启动 |

依据：`cli/remote.ts` 的 `cmdCrewAdd`、`muxChoice`，`bridge/crew/trust-store.ts`、
`ops-store.ts`，`cli/mux.ts` 的 `ensureMuxChosen`，`bridge/index.ts` 的初次连接失败后继续轮询，
以及 `web/src/lib/pairing.ts` 和 `cli/pairing.ts`。

## 需要优先排查的根因

现象不足以确认用户机器的具体根因，以下是代码和部署文档明确存在的风险点。

1. **Linux 登录生命周期。** `collie start` 注册并启用 user service；没有 linger 时可能随
   最后一个登录会话结束而停止。`docs/install.md` 和 `docs/upgrading.md` 已给出
   `loginctl enable-linger $USER`，但当前安装体验没有统一证明持久运行条件已满足。
2. **macOS SSH-only。** 当前 lifecycle 优先使用 GUI launchd domain；无法 bootstrap 时可降级
   无监督进程。`docs/install.md` 明确说明该降级不保证失败重启和下次登录启动。
3. **Herdr 不在运行。** 桥接可存活，但不负责凭空创建 Herdr 会话。已验证的接口文档没有给出
   可直接承诺跨重启无人值守启动的统一 Herdr daemon 命令。
4. **mux 或 endpoint 不稳定。** 首次未明确设置 `COLLIE_MUX`，或把某次会话 socket 当作固定
   目标，可能出现交互选择或连接错误。不能在连接失败时悄悄选择另一会话。
5. **状态目录或浏览器 Origin 变化。** `COLLIE_STATE_DIR`、`COLLIE_INSTANCE`、不同运行用户，
   以及 URL 的 scheme/host/port 变化，可能分别切换服务端注册表或浏览器存储空间。
6. **配对被合法终止。** `--expires`、主动撤销、浏览器清理站点数据，需要与连接中断区分。
7. **机器可达性。** SSH 别名只表示安装通道，不代表 lead 能直达 peer 的 Crew 监听地址。
   SSH 安装成功不等于运行链路已就绪。

## “直接连接 Herdr”的边界

推荐把“直接”定义为用户体验：打开固定入口即可访问固定机器，而不是删除远端桥接。

Herdr 在 POSIX 使用本机 Unix socket，Windows 使用对应 named pipe。浏览器无法直接访问，
且日志、上传文件、审计都在目标机器。跨机继续由目标机 Collie 处理，不开放原始 Herdr RPC，
不把 SSH 私钥放入浏览器，不让 lead 远程挂载 socket。依据 ADR 0011、0013、0015、0016。

Herdr 的机器列表与 Crew 成员独立。添加、删除 Herdr 候选不应自动改变 Crew 信任；临时离线也
不能从固定列表删除成员。具体行为规格位于本轮 change 的 `specs/`。

## 推荐实施顺序

分为“先用现有能力收敛配置”和“补齐产品缺口”两步。

- **现有能力路径：** 固定一个常在线的 lead 与 URL；在 lead 使用明确 SSH host 和 `--mux`
  添加机器；保持配置和状态目录稳定；配置合适的 supervisor；手机只配对 lead 一次。
- **MVP：** 沿用 `crew add` 和现有信任模型，新增显式的持久运行校验、分层诊断、机器页指引和
  回归测试。Linux 作为无人值守重启验证目标；macOS 明确区分登录后常驻和登录前启动。
- **后续独立提案：** 若必须在 Herdr 未运行时自动创建它，先验证 upstream headless 生命周期、
  用户/权限/会话归属，再规划专门的 mux supervision；不以猜测命令扩充本轮范围。

## 本轮交付与验证边界

这里只提交 Agent 导航和 OpenSpec 规划，不安装服务、不修改网络或安全配置，也不宣称功能完成。

OpenSpec 使用 `@fission-ai/openspec@1.16.1` 初始化为工具中立的 `spec-driven` 工作流。
本轮不安装全局 CLI，不修改项目依赖和版本号，不启用产品实现阶段。
`openspec status` 的 artifact 完成仅表示规划文件齐备；`tasks.md` 的实现项仍全部待办。
