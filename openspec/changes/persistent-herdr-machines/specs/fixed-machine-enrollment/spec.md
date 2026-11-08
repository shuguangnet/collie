# 固定机器注册

## Purpose

让操作者通过一次明确的机器选择和授权，建立可跨 Collie 重启保留的机器连接。机器候选只是添加
入口，成员身份由已验证的信任记录决定，日常访问不依赖反复发现、匹配或重新登录目标机器。

## ADDED Requirements

### Requirement: Explicit machine enrollment

系统 SHALL 接受操作者明确指定的 SSH 目标和 multiplexer，跳过机器候选选择；成功后 SHALL
保留成员身份与目标配置，后续访问不得要求重新选择机器。

#### Scenario: Add a named Herdr host

- **GIVEN** 操作者在 lead 持有目标机的有效 SSH 访问权限，且目标机满足现有安装前提
- **WHEN** 操作者执行 `collie crew add work-server --mux herdr` 并完成必要确认
- **THEN** 系统安装或复用目标机 Collie，完成现有 Crew 注册并保存明确的 Herdr 选择
- **AND** 不再要求从 Herdr 或 SSH 候选列表选择该目标

#### Scenario: Restart with enrolled machines

- **GIVEN** 成员注册完成且持久状态未丢失
- **WHEN** lead 和 peer 的 Collie 重启
- **THEN** 系统恢复同一成员身份并使用保存的连接信息
- **AND** 不重新生成邀请、不重新选择 mux、不要求手机再次配对

### Requirement: Offline membership retention

系统 MUST 保留暂时离线的已注册机器，并持续报告其连接状态；候选来源的新增、删除或不可读
SHALL NOT 自动改变 Crew 成员关系。

#### Scenario: Member temporarily unavailable

- **WHEN** 已注册机器因关机或断网不可达
- **THEN** 固定机器列表仍包含该机器并显示不可达状态
- **AND** 恢复连接时使用原身份，不进行重新注册

#### Scenario: Herdr source removes a machine

- **WHEN** Herdr 的候选机器列表删除已加入 Crew 的机器
- **THEN** Crew 保留该成员，最多给出两份列表不同的提示
- **AND** 只有操作者明确移除才改变成员关系

### Requirement: Repeat enrollment preserves trust

系统 SHALL 对已在同一 Crew 的同一机器复用现有注册结果；地址、别名或标签相似 MUST NOT
被当作身份相同的证据，已属于其他 Crew 的机器 MUST 被拒绝而非静默接管。

#### Scenario: Repeat add for the same enrolled peer

- **GIVEN** 远端证明自己是本 Crew 已注册成员且配置一致
- **WHEN** 操作者再次添加该机器
- **THEN** 系统复用成员与证书，不创建重复成员或重复消耗邀请
- **AND** 若请求持久检查，继续检查运行条件而不是把“已注册”当作持久就绪

#### Scenario: Machine belongs to another crew

- **WHEN** 远端报告另一个 Crew 的有效成员关系
- **THEN** 系统拒绝自动加入并给出明确的人工处理指引
- **AND** 不覆盖远端信任状态

### Requirement: Provisioning remains operator-authorized

安装和配置 MUST 通过操作者的 SSH 通道进行并遵守现有破坏性变更确认；系统 SHALL NOT
降低 SSH 主机身份检查，也不得通过网页或 Crew 运行链路获得新的安装权限。

#### Scenario: SSH host key is refused

- **WHEN** SSH 因主机密钥不匹配拒绝目标机
- **THEN** 添加失败并报告 SSH 原因
- **AND** 系统不关闭主机密钥校验、不自动接受新密钥

#### Scenario: Browser requests remote provisioning

- **WHEN** 浏览器试图提交 SSH 私钥或请求运行远端安装
- **THEN** 本能力不提供该操作入口
- **AND** 已配对手机的权限不被扩展为 SSH 安装权限

### Requirement: Successful enrollment verifies the runtime link

系统 MUST 分别报告安装、注册与运行链路验证结果；SSH 成功或进程存在 SHALL NOT 被单独
当作 lead 能访问该成员的证据。

#### Scenario: SSH works but crew transport is blocked

- **WHEN** SSH 安装完成，但 lead 无法通过 Crew 链路验证成员
- **THEN** 系统报告已完成的步骤与未就绪的运行链路，并以非成功结果结束完整添加流程
- **AND** 保留可安全重试的状态，不删除已完成的合法注册
