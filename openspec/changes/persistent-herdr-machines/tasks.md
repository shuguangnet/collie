# Tasks

本清单记录实现与验收状态。范围与约束见 `design.md`。

> 本轮已在本地实现 2.1–2.5、3.1–3.5、4.1–4.3 与 4.5，并补齐对应测试代码和文档。
> 已实际执行并通过：根目录 `oxlint --max-warnings 0`、根 `tsc --noEmit`（含
> `tsconfig.contract.json`）、web `tsc --noEmit`（含 `tsconfig.worker.json`）以及 web 全量 Vitest。
> 2026-11-08 复审修复后，使用 `flake.nix` 固定的 Bun 1.4.4（路径见
> `review-findings.md`）补跑：
>
> - `bun test cli/persistence.test.ts cli/doctor.test.ts cli/lifecycle.test.ts cli/remote.test.ts`
>   → 658 pass / 11 fail；11 项均为本机 macOS `/var` symlink、Keychain 与 durable-socket
>   既有环境失败，与本 change 无关。新增的服务归属/持久配置、远端 parser fail-closed、
>   非零退出、重复添加 Crew 链路及实例/安装类型修复指引回归全部通过。
> - `bun test ./cli` → 3033 pass / 11 fail（同上，无新增失败）。
> - `bunx tsc --noEmit`、`bunx tsc --noEmit -p tsconfig.contract.json`、
>   `bunx oxlint --max-warnings 0` 通过。
>
> 主代理最终复核：使用规范化短 TMPDIR 执行完整 CLI：3046 pass / 5 skip / 1 fail；
> 唯一失败是已在原始 HEAD 复现的 account-windows Keychain 文案断言。
> 新增服务实际 argv、条件 KeepAlive 与非零诊断退出保留原因的回归已通过。
> 既有完整后端测试为 14101 pass / 96 skip / 2 fail，其中新增 persistence 用例已修复并复验；
> 完整前端为 54499 pass / 34 expected fail / 5 skip / 56 todo，Crew TLS 集成为 82 pass / 0 fail。
> 最终根 typecheck（含 contract）、lint、版本一致性与 OpenSpec strict validate 通过。
>
> 勾选仍表示“实现 + 验证”都已完成。真实双机、SSH 退出与重启验收尚未执行；
> 既有 Crew 集成通过不等于新增 5.3 恢复场景已完成。
> 4.2 的 playground 检查仍未运行。
> 1.4 为纯文档项，已人工核对命令与当前 CLI 帮助一致，故勾选。6.5 的全量验证、5.x 的既有回归扩展
> 和 6.x 的真实环境验收仍未完成。

## 1. 真实环境基线与回归约束

- [ ] 1.1 在获得授权后收集脱敏的 lead/peer 系统、安装种类、mux 版本、入口与实例配置；以环境矩阵确认设计假设，不读取或输出私钥、secret、token。
- [ ] 1.2 使用现有 status、doctor、crew status 及受控 SSH 退出流程复现故障；以日志确认 bridge、mux、网络或配对中具体失效的一层，未复现项记录未知。
- [ ] 1.3 在 `cli/remote.test.ts` 补显式目标与 `--mux herdr` 的持久配置、重复添加、外部 Crew 拒绝及无候选读取回归测试；以针对性 Bun 测试通过验证。
- [x] 1.4 为 `docs/crew.md` 增补现有显式添加、候选与成员独立的使用说明；核对命令与当前 CLI 帮助一致，且不把待实现参数描述成已发布。

## 2. 持久运行纯判定与平台检查

- [x] 2.1 新建 `cli/persistence.ts` 的注入式事实模型和 findings 判定；用假平台输入验证 unknown、未监督、登录依赖、mux 不可达及完全就绪，不产生系统写操作。
- [x] 2.2 实现 Linux service 所有权、enabled/active 与 linger 只读探测；用 `cli/persistence.test.ts` 验证无 systemd、无 bus、linger 关闭、解析失败和正常结果。
- [x] 2.3 实现 macOS launchd 只读监督检查，区分 after-login 与 unsupervised；用注入式测试验证 SSH-only、载入失败、外部管理任务及不得覆盖外部 plist。
- [x] 2.4 对未验证平台返回明确 unsupported/unknown；以测试确认 Windows 普通启动和现有 Task Scheduler 行为不变。
- [x] 2.5 接入拟新增 `doctor --only persistence --json` 与相关 help/status 输出，复用同一判定；以 CLI 参数和输出测试验证，并更新 `docs/commands.md`、`docs/install.md` 的保障范围。

## 3. 固定添加的持久模式

- [x] 3.1 在 `cli/remote.ts` 和命令帮助接入可选 `crew add --persistent`；以参数测试验证普通调用兼容、显式 host 不进入候选选择、批量添加保留逐机器结果。
- [x] 3.2 复用现有 SSH runner 执行远端只读持久诊断，已注册机器也经过该阶段；以 transport fake 验证无重复注册、无秘密进 argv、SSH 失败与诊断失败可区分。
- [x] 3.3 将 Crew 可达性、监督、登录条件及 mux 响应纳入持久就绪判定；以测试验证 HTTP 在线但 mux 离线、仅进程存在、证书冲突均不能误报成功。
- [x] 3.4 实现部分完成摘要与可重试退出结果；以测试验证检查失败保留合法 trust/ops 状态，重试不生成重复成员，且不自动 sudo、enable-linger 或创建 Herdr 会话。
- [x] 3.5 更新 `docs/crew.md` 和 `docs/upgrading.md`，同时说明普通模式与持久模式、Linux 一次性 linger 和 Mac after-login 边界；对照已实现命令进行文档验证。

## 4. 稳定访问与只读机器页指引

- [x] 4.1 在现有机器列表／详情使用已有状态展示离线、mux 不可用、信任拒绝，不虚构远端 supervisor 信息；以组件测试覆盖每种状态及未知时的 lead 侧检查指引。
- [ ] 4.2 复用现有 UI primitive 增加只读固定机器和持久部署说明，同步十二种字典；用 Vitest、两侧类型检查及 playground 检查文本、导航和各状态不发生布局跳动。
- [ ] 4.3 为 `web/src/lib/pairing.test.ts`、API 和相关组件补网络超时不清 token、同 Origin 重开及服务重启继续授权的回归；以测试确认没有新 token 发放或自动补授权。
- [ ] 4.4 扩展 bridge/CLI 配对回归覆盖默认无到期、显式到期、revoke、状态目录变化和未知 token；以测试验证所有现有门禁与清理规则仍生效。
- [x] 4.5 在 `docs/security.md` 与安装指南解释固定 Origin、实例、运行用户及状态目录；人工核对排障路径先区分网络和授权，不建议绕过配对或在 URL 中携带 token。

## 5. 连接恢复与状态完整性

- [ ] 5.1 扩展 Crew registry/lead 单测，覆盖已注册成员离线保留、恢复原身份及证书变更拒绝；以现有 Bun 测试验证不引入新计时器或自动接受证书。
- [ ] 5.2 补 mux 与 bridge 回归，覆盖 Herdr 初始不可达、恢复与进程重启；以测试验证 bridge 继续运行、不自动换 session/mux、不重放输入。
- [ ] 5.3 扩展 `integration/crew-harness.test.ts`，验证 lead/peer 重启和网络恢复后身份与授权连续性；运行 `bun run test:crew` 并记录真实 TLS 链路结果。
- [ ] 5.4 若现有 census 字段不能表达所需状态，先修订 design/spec 与 `CREW_PROTOCOL.md` 变更决策；以 wire guard 和兼容性测试通过后再修改，不能静默增加 wire 字段。

## 6. 系统级验收

- [ ] 6.1 在隔离 Linux 主机完成 SSH 退出、bridge crash、真实重启后不登录三类验证；记录 user service、linger、网络与 Herdr 前提，手机在恢复后无需重加机器或配对。
- [ ] 6.2 在隔离 Mac 完成关闭终端、结束 SSH、bridge crash、用户重新登录验证；记录 after-login 保证，SSH-only fallback 必须被持久检查拒绝。
- [ ] 6.3 在双机环境执行断网恢复、Herdr 停止后恢复和证书变化拒绝；记录机器仍在固定列表、无重复终端输入及各层故障说明。
- [ ] 6.4 在同 Origin、不同 Origin、清理站点数据、revoke、显式到期条件下走查真实 PWA；验证只有凭据确实失效或缺失才要求重新配对。
- [ ] 6.5 运行根与 web 的 typecheck、根 lint、两侧完整测试、Crew 集成；需改浏览器引擎行为时运行相应 Playwright，若涉及 mux reader/Surface/Send/ask 依 `CLAUDE.md` 执行真实 browser legs。
- [x] 6.6 每组功能提交同步满足 Unreleased 记录要求，不因本功能单独升版本；执行 OpenSpec strict validate 并核对所有验收证据再请求合并。

## Workflow follow-up

- 实现与验收完成、经操作者确认后再归档本 change，将新增能力同步到 `openspec/specs/`。
- 如需 Herdr 自动启动或 macOS 登录前无人值守，另起已验证生命周期前提下的 OpenSpec 提案。
