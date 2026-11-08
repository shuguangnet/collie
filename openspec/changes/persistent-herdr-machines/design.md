# Design

## Context

本设计以 `openspec/project-analysis.md` 的静态分析为基础；动机见 `proposal.md`。

现有链路已经是 `phone -> lead Collie -> peer Collie -> local Herdr`。固定成员、SSH 安装、
设备 token 与重连均已有实现，缺口在于部署结果没有统一提供持久运行保证和分层诊断。

本轮按以下默认边界规划：lead 保持在线且有固定 URL；目标机已安装 Herdr；操作者在 lead
持有 SSH 权限；Linux 支持无人值守 user service 验证，macOS 仅承诺合适登录会话下的监督。
这些是本提案的范围假设，不是对用户实际机器环境的确认。

## Goals / Non-Goals

**Goals:**

- 使用现有显式添加命令固定机器，日常不再进入目标机操作 Collie。
- 增加可选择的持久检查，而非破坏现有 `crew add` 的普通使用方式。
- 将“机器未连上”和“手机不被授权”分开，把需要人工操作的前提说清楚。
- 以真实退出登录、重启和故障恢复验证替代“进程启动了所以成功”。

**Non-Goals:**

- 无桥接远程直连 Herdr、暴露其原始 socket、在 lead 转发裸 Herdr RPC。
- 手机保存 SSH 凭据、Web 一键远端安装、后台自动 SSH 修复服务。
- 自动启动未经验证的 Herdr TUI／daemon，恢复机器重启前的所有 agent。
- macOS 登录前启动、root LaunchDaemon、绕过 FileVault，或改变 Windows 现有服务行为。
- 重新设计 Crew 信任协议、添加第二套注册表、自动证书接受或自动切换 Crew lead。

## Decisions

### 1. “直连”是操作体验，传输保持 Crew

沿用既有通道与 ADR 0011、0013、0015、0016，不让手机直接拨 Herdr。目标机 Collie 负责该机的
socket、日志、上传和审计。SSH 仅服务于操作者明确执行的安装／管理动作，日常访问不需要它。

被否决的替代项：SSH 转发远端 Unix socket；依赖 `herdr --remote` 私有接口；把 Herdr machine
list 当作已授权机器。它们分别破坏主机本地语义、适配器边界或信任来源。

### 2. 只保留现有四种状态的职责

| 数据 | 现有位置 | 处理 |
| --- | --- | --- |
| 成员身份、证书和 Crew secret | `<stateDir>/crew-trust.json` | 继续由现有 enrollment 独占写入 |
| 操作者如何通过 SSH 到达机器 | `<stateDir>/crew-ops.json` | 仅本地便利信息，不跨 Crew wire |
| mux、socket 与实例配置 | 实例 `.env` 和现有配置合并层 | CLI 沿既有 upsert 写 `.env`，不写操作者 TOML |
| 手机 token / 服务端设备记录 | Origin 的 localStorage / `paired-devices.json` | 沿用现有配对逻辑 |

不新增 `machines.json` 作为第二套成员权威。无参数 `crew add` 仍可供首次选择；明确目标时不读取
候选作为身份依据。候选消失和成员离线均不删除信任记录。

### 3. 在 `crew add` 上增加可选 `--persistent`

建议调用形状，注意第二行是待实现接口：

```sh
# 现有能力：明确指定 SSH 目标，不再进入候选选择
collie crew add work-server --mux herdr

# 拟新增：安装／复用后验证持久运行条件
collie crew add work-server --mux herdr --persistent
```

普通添加保留当前退出行为。持久模式对首次添加和已注册成员均执行，不因“已加入”提前跳过检查。
已有身份、版本和配置一致时不重新注册、不旋转证书、不无理由重启。

执行顺序：现有探测 -> 必要的安装／确认 -> 明确 mux 与配置 -> 现有注册或复用 -> 验证 Crew
链路 -> 通过同一 SSH runner 调用远端只读持久诊断 -> 输出分层结果。检查失败返回非成功并标明
哪个阶段已完成；不回滚合法 enrollment，更不自动清除信任后重加。

检查使用操作系统现状而不是缓存的“曾安装成功”。不对手机暴露 SSH 操作接口。

### 4. 持久诊断使用纯判定与 CLI 边界

建议新增 `cli/persistence.ts`，纯逻辑把可注入探测结果转成事实／findings，复用现有
`Finding`、`doctor` 和状态输出风格。只读命令形状为拟新增的
`collie doctor --only persistence --json`，由 CLI 注册并验证，不是现有可运行承诺。

内部报告可包含：`platform`、`supervisionTier`、`serviceEnabled`、`serviceActive`、
`loginRequirement`、`linger`、`muxReachable`、`guarantee` 与原因码；缺值为 unknown 而非 true。
这是本地诊断形状，不是 Crew wire 字段，也不直接把 JSON 声明为公共跨版本协议。

`status` 复用相同判定，避免 doctor 和 banner 两套语义。远端诊断输出仅保存本次命令结果；
MVP 不持久化过期的“在线／就绪”布尔值，不把该数据塞入 `crew-ops.json`。

### 5. Linux 保证依赖 user service 和 linger

检查 unit 属于当前安装／实例、enabled、active，以及 `loginctl show-user` 的 linger。
继续使用 `cli/lifecycle.ts` 的启用服务逻辑；缺少 linger 时输出未就绪与一次性处理提示：

```sh
# 在目标用户上下文中执行；可能需要系统策略授权
loginctl enable-linger "$USER"
```

本轮不自动 sudo，不更换服务用户。若策略不允许开启，在 lead 的本次命令结束后给出清晰摘要，
操作者完成一次环境准备后可重复持久检查。无 systemd 或用户 bus 不可用时保持普通启动降级，
但拒绝持久成功。

“重启后可用”必须带前提：机器已启动、磁盘已解锁、网络已恢复、Herdr 也在运行。

### 6. macOS 不把 SSH-only 的 fallback 当作成功

检查本项目生成且已载入的 launchd job、真实运行状态和登录域。已有 `RunAtLoad` / `KeepAlive`
继续复用；不重写为 root daemon，也不自动迁移外部管理的 plist。

可用 GUI 登录会话时给出 `after-login` 保证。仅 SSH 登录且 bootstrap 失败后降级的进程明确为
`unsupervised`，持久模式返回未就绪。支持 Nix/Home Manager 等外部管理场景时，只读识别其实际
监督结果，不因 plist 不归 Collie 所有而擅自替换；未能验证则 unknown。

在受控 Mac 上验证关闭终端、结束 SSH、进程异常退出和用户重新登录；不将这些验证表述为
FileVault 解锁前或无人登录时开机自启。

### 7. Herdr 可用性是独立条件，不偷偷创建会话

Collie bridge 的 HTTP/Crew 健康与 Herdr socket 健康分别显示。使用既有 mux 能力和快照结果
判定，不以 socket 文件存在替代有效响应，也不把 `/api/health` 的单一结果当作全链路健康。

明确的 `COLLIE_MUX=herdr` 防止之后自动改选；`HERDR_SOCKET_PATH` 若由操作者在实例配置中
明确给出则遵循现有优先级。不把某次插件动作注入的临时 socket 无条件写成永久配置，不以
“找得到的第一个 session”替换失败目标。

Herdr 不可用时保留 bridge 与成员，报告 mux 层故障；复用现有 poll/watch 恢复。若用户实际需求
是“Herdr 完全关闭也能自动拉起”，本轮只准确报告前提，另起提案验证 upstream 生命周期。

### 8. 日常重连不得获得额外写权限

继续使用 `bridge/crew/lead.ts`、`registry.ts`、mux watch 和前端轮询，不新增一套心跳／重试
计时器。短暂离线不清成员、不重配对；证书冲突失败关闭；网络恢复只刷新状态。

发送失败后不得盲目重放 reply、keys 或创建 pane 请求；继续遵守现有回执和 requestId 契约。
已经有自愈测试覆盖的行为只扩展缺失的组合场景，不为“重连”重写协议。

### 9. 手机只提供只读部署指引

复用已有 `/machines` 和 `/machines/:id`，保留已有连接、mux、信任状态。新增短说明和可复制的
lead 侧 CLI 指引，解释固定机器、一次配对以及持久部署前提。没有远端监督数据时不显示绿色
“永久在线”；手机也不承诺自行启动已停止的 Collie。

视觉实现前阅读 `DESIGN.md`，复用现有 UI primitive；走 React Router loader/revalidator，不引入
TanStack Query。所有新 UI 文案通过 `t()` / `tn()` 并同步十二种字典，jsdom 可验证的交互用 Vitest。

### 10. token 保持原策略，先诊断身份空间

不新增“永久万能 token”。现有默认不设有效期已经满足一次配对，`--expires` 和 revoke 继续有效。
稳定入口必须保持 scheme/host/port；实例状态目录不随 checkout 或版本目录切换。

检查入口／网络 -> 运行实例与状态目录 -> token 是否在当前 Origin -> 明确授权拒绝的原因。
网络失败不清 token；新 Origin 和注册表丢失必须按新授权处理，不自动复制凭据。

## Risks / Trade-offs

- [Herdr 未运行] -> Collie 常驻仍无终端可读；明确显示 mux 不可用，不宣称本提案自动解决。
- [lead 是会休眠的笔记本] -> 选择稳定 lead；自动接管继续使用已有 deputy 机制，不在本轮扩大。
- [SSH 能连但 Crew 端口不通] -> 添加后验证运行链路，单独给出地址／路由问题。
- [sudo／系统策略阻止 linger] -> 返回未就绪而非静默提权；提供一次性准备指引。
- [Mac 无登录会话或磁盘未解锁] -> 限定 after-login；无人登录需求需要独立方案。
- [混合版本 CLI] -> `--persistent` 要求本轮版本支持，老远端无法给出可信诊断时报未验证。
- [诊断变成第三套健康模型] -> 复用 findings 和已有运行状态，只新增监督／登录的纯判定。
- [静态规划无法复现实际故障] -> 实施前取得脱敏的 status、doctor 和拓扑信息，不能把风险点当定论。

## Migration Plan

1. 先记录真实环境：lead/peer 系统、安装种类、mux 版本、稳定 URL、实例和状态目录；只读诊断。
2. 使用现有显式 `crew add` 确认注册链路，优先修复已知部署条件，不重建工作中的 Crew。
3. 增量实现持久判定、可选参数、只读机器页说明以及各自单测／文档。
4. 在受控 Linux 和 Mac 验证关闭 SSH、bridge crash、网络中断、Herdr 重启和凭据连续性。
5. Linux 单独执行真实重启不登录验证；Mac 执行声明的 after-login 验证，记录不能验证的保障。
6. 功能提交按 `CLAUDE.md` 增加 Unreleased 条目；本轮不切 release，未来发布由维护者定轴。

回滚只撤回新增参数／展示／诊断逻辑，沿用原命令和现有磁盘格式，不清理成员和配对状态。
操作者明确开启的 linger 是系统策略，不由软件降级自动撤销。没有正式 schema/wire 变更，因此
不需要迁移信任记录；若实施发现必须变更协议，先回到规划阶段修订。

## Implementation Gate

本提案处于待确认规划状态，尚未实现。开始实现前确认范围假设是否符合实际拓扑；若用户要求
macOS 登录前启动、自动创建 Herdr 或完全取消远端 Collie，必须先改提案而不是在任务中暗中加入。
