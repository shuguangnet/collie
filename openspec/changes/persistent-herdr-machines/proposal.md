# Proposal

## Why

用户希望一次固定添加 Herdr 机器，之后打开 Collie 就能访问，而不是每次登录目标机器启动、重新选择
目标或重复配对。现有 Crew、持久 token、后台服务和重连机制已覆盖基础能力，但安装流程没有统一
区分“当前运行”和“退出登录／重启后仍可用”，也没有清晰说明 Herdr 本身未启动的边界。

## What Changes

- 复用 `collie crew add <ssh-host> --mux herdr` 的显式添加路径，记录稳定成员身份、明确 mux
  和配置来源；离线和候选列表变化不触发删除、重新匹配或重新注册。
- 为现有 `crew add` 增加可选的 `--persistent` 持久模式，并在 `doctor` / `status` 提供
  分层检查：安装成功、桥接在线、监督状态、登录依赖、mux 可用性、运行链路是否可达。
- Linux 持久模式验证 user service 与 linger；需要操作者干预时明确报未就绪，不静默提权。
- macOS 持久模式验证受监督的登录后运行；SSH-only 降级不能报持久成功，不承诺登录前开机启动。
- 补充机器页面的只读连接／部署指引，区分机器离线、Herdr 未运行、信任拒绝、配对失败。
- 建立重启、断网、Herdr 重启、Origin 与状态目录稳定性的回归验证；继续复用现有重试机制。

**非目标：** 浏览器直连 socket；用 Herdr 机器列表自动授权；在 Web 端收集 SSH 凭据或触发
远端安装；新增裸 TCP Herdr RPC；自动安装／拉起未验证的 Herdr daemon；迁移到 herdr-core；
强行接管另一 Crew；保证断电或无人登录时任意操作系统都可用。

## Capabilities

### New Capabilities

仓库此前没有 OpenSpec 正式规格；以下是首次建立能力契约，其中会复用部分已有行为。

- `fixed-machine-enrollment`：明确指定机器、一次授权、稳定成员身份和受限安装行为。
- `persistent-machine-runtime`：持久模式、监督与登录条件校验、重连及故障分层。
- `stable-device-access`：固定入口下的持续配对、可撤销授权和配对异常诊断。

### Modified Capabilities

无。已有 OpenSpec spec 清单为空，不虚构已有 capability 或以 MODIFIED 覆盖不存在的规格。

## Impact

- CLI：`cli/remote.ts`、`cli/crew.ts`、`cli/program.ts`、`cli/lifecycle.ts`、`cli/unit.ts`、
  `cli/doctor.ts`、`cli/setup-findings.ts`、`cli/context.ts`。
- 状态与展示：优先复用 `bridge/crew/registry.ts`、`bridge/machines.ts` 和现有机器 census；
  前端涉及 `routes/machines.tsx`、`routes/machine.tsx`、`lib/loaders.ts`、相关组件及十二种字典。
- 持久化：沿用 `crew-trust.json`、`crew-ops.json`、`paired-devices.json` 与已有 `.env`；
  不创建第二套成员注册表，不将 SSH 信息放入 Crew wire。
- API / 协议：MVP 不增加远端执行 API，不预设 Crew wire 变更；若现有字段不足，须先修订设计并
  按 `CLAUDE.md` 完成 `CREW_PROTOCOL.md` / 协议版本决策。
- 测试与文档：CLI 注入式测试、bridge 和前端测试、真实 Crew 集成以及安装／机器管理文档。
- 兼容性：旧命令行为保持；持久检查只在显式请求时作为成功条件。预计新增功能属于 MINOR，
  具体轴由发布时决定；本次规划不改版本、锁文件或 CHANGELOG。
