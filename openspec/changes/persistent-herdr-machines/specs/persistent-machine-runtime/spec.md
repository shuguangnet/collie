# 机器持久运行

## Purpose

让固定添加的机器在已经声明的操作系统登录条件下持续提供 Collie 服务，并在网络和 multiplexer
恢复后自动重新可用。明确监督与重启保障的边界，使操作者知道是否还需要登录目标机采取行动。

## ADDED Requirements

### Requirement: Explicit persistence verification

系统 SHALL 提供可选的 `crew add --persistent` 模式，并分别验证远端桥接在线、运行受监督、
平台登录条件满足及目标 mux 可达；任一必要条件不满足 MUST 返回未就绪，而非持久成功。

#### Scenario: Persistent runtime is ready

- **GIVEN** 目标平台的监督与登录条件满足，且已验证 Crew 连接与 Herdr 可用
- **WHEN** 操作者以 `--persistent` 添加或检查已注册机器
- **THEN** 系统报告持久就绪及其具体保障范围
- **AND** 不把该结论扩展为恢复未运行的 Herdr 或恢复丢失的 agent 进程

#### Scenario: Legacy add without persistent verification

- **WHEN** 操作者使用原有添加命令且未指定 `--persistent`
- **THEN** 保留原有成功条件和退出行为
- **AND** 新的监督警告不被伪装成已通过的持久检查

### Requirement: Linux unattended persistence

Linux 持久模式 MUST 验证已启用且活动的用户服务和 linger 状态；linger 未开启或无法验证时
SHALL 报告未就绪并给出处理方式，不静默执行提权操作。

#### Scenario: Linger is disabled

- **WHEN** 用户服务当前在线但用户未启用 linger
- **THEN** 系统报告退出登录／重启后运行条件不满足，并指引操作者启用 linger
- **AND** 不因当前 SSH 会话仍存活而报告持久就绪

#### Scenario: Reboot with prerequisites satisfied

- **GIVEN** linger 已启用、用户服务已启用、机器启动完成、网络可达且 Herdr 已运行
- **WHEN** 目标 Linux 主机重启而操作者未重新 SSH 登录
- **THEN** Collie 由监督器恢复并使用原成员身份重新连接
- **AND** 手机无需重复注册或配对

### Requirement: macOS persistence is login-scoped

macOS 持久模式 SHALL 明示受监督运行依赖用户登录，且 MUST 验证 launchd 中实际载入和运行
的受管任务；无监督降级 MUST 报未就绪，不得承诺登录前启动或关闭 FileVault 解锁需求。

#### Scenario: Supervised login session is available

- **GIVEN** 受支持的用户登录会话存在且 launchd 正在监督 Collie
- **WHEN** 操作者请求持久检查
- **THEN** 报告登录后监督就绪，并明确重启后需要相应用户登录

#### Scenario: SSH-only start falls back

- **WHEN** 只有 SSH 会话且无法载入可用的受管 launchd 任务
- **THEN** 原有启动可以按现有策略降级，但持久检查必须失败
- **AND** 给出需要用户登录或单独配置受管服务的说明

### Requirement: Unsupported supervision fails honestly

持久模式 SHALL 仅对已验证的平台监督方案作出保证；其他平台或只有无监督进程时 MUST
明确报告不支持或未验证，不修改原有普通启动行为。

#### Scenario: Persistent verification on an unverified target

- **WHEN** 目标平台尚未具有本能力的验证方案
- **THEN** 系统拒绝宣称持久就绪并说明限制
- **AND** 不删除成员、不停止原来正常工作的普通服务

### Requirement: Missing multiplexer does not discard the machine

目标 Herdr 不可达时，系统 SHALL 保留机器身份和仍可用的 Collie 服务，单独报告 mux 不可用；
本能力 MUST NOT 猜测启动命令、自动迁移到其他 mux 或连接另一个会话。

#### Scenario: Bridge starts before Herdr

- **WHEN** Collie 已启动而配置的 Herdr socket 尚不可达
- **THEN** 系统报告“桥接在线、Herdr 不可用”并继续重试
- **AND** 不把它描述为手机配对失败或要求重新添加机器

#### Scenario: Herdr becomes available again

- **GIVEN** 配置所指的 Herdr 暂时不可达
- **WHEN** 同一配置目标的 Herdr 恢复且提供有效响应
- **THEN** 系统自动恢复读取，无需重启 Collie 或重新配对
- **AND** 不重放断线前的输入写操作

### Requirement: Recovery preserves identity and write safety

网络中断后系统 SHALL 继续使用已固定的成员身份重试；恢复成功后自动刷新状态，但 MUST NOT
静默接受变更的证书或自动重发无法证明结果的终端写操作。

#### Scenario: Network interruption heals

- **WHEN** 已注册机器断网后恢复，身份与授权仍有效
- **THEN** lead 和手机在正常重试周期内恢复显示
- **AND** 不新增成员、不生成新配对、不重复发送用户输入

#### Scenario: Certificate changes at the saved address

- **WHEN** 保存的地址返回不同的成员证书
- **THEN** 系统报告信任冲突并拒绝接受该身份
- **AND** 不以“自动重连”为由更新固定证书

### Requirement: Layered diagnostics explain availability

系统 SHALL 在 CLI 诊断中区分入口、桥接、监督与登录条件、Crew 链路、mux 和手机授权状态，
对未知状态明确报告未知；机器页面 SHALL 提供现有可观测连接状态和只读持久部署指引。

#### Scenario: Diagnose a live bridge with a stopped mux

- **WHEN** Crew 成员的 Collie 可达但 Herdr 不可达
- **THEN** 诊断指出 mux 层问题而不是笼统要求重新配对
- **AND** 机器页面保留该机器并提供相应说明

#### Scenario: Phone cannot inspect supervision

- **WHEN** 手机没有可验证的远端监督状态数据
- **THEN** 页面不编造持久就绪结论，而是提供在 lead 上运行检查的指引
- **AND** 不通过新增网页 SSH 能力补齐该信息
