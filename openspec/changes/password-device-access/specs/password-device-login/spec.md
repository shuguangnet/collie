# 密码设备登录

## Purpose

让远端浏览器用固定访问密码换取普通、可逐设备撤销的 Collie 设备 token，同时保持 ADR 0086 的
“读也要 token”不变。密码只在主机 CLI 设置，网页永远不能初始化、修改或清除它。

## ADDED Requirements

### Requirement: CLI-only password management

系统 SHALL 提供 `collie password set`、`collie password status` 和 `collie password clear`，
并 MUST NOT 提供任何匿名 HTTP 接口来设置、修改或清除访问密码。

#### Scenario: Set a password on a TTY

- **GIVEN** 操作者在主机终端运行命令，且标准输入是 TTY
- **WHEN** 执行 `collie password set`
- **THEN** 系统隐藏输入并要求输入两次
- **AND** 两次一致且满足长度要求时写入 verifier
- **AND** 终端输出、进程 argv 和环境中都不出现密码
- **AND** 文件只包含 verifier，不包含密码明文

#### Scenario: Set a password from stdin

- **GIVEN** 自动化脚本需要设置密码
- **WHEN** 执行 `collie password set --stdin` 并通过 stdin 提供密码
- **THEN** 系统从 stdin 读取一次密码并写 verifier
- **AND** 不接受 `--password`、位置参数或环境变量作为密码来源

#### Scenario: Reject a short password

- **WHEN** 密码少于 12 个字符或超过 256 个字符
- **THEN** 系统拒绝写入并给出可操作的错误
- **AND** 不修改已有 verifier

#### Scenario: Status reports configuration only

- **WHEN** 操作者运行 `collie password status`
- **THEN** 输出是否已配置、不可用或未配置
- **AND** 不输出密码、salt、verifier 或 scrypt 完整参数

### Requirement: Verifier at rest is strict and fail-closed

系统 MUST 只接受固定的 scrypt 参数白名单，使用随机 salt 和异步 KDF，并以 0600 权限原子写入
`<stateDir>/access-password.json`。

#### Scenario: Corrupt verifier is not treated as unconfigured

- **GIVEN** verifier 文件存在但无法解析、参数越界或字段缺失
- **WHEN** 匿名状态或登录请求读取它
- **THEN** 状态请求返回 `503 password unavailable`，登录也返回 `503 password unavailable`
- **AND** 系统不自动删除或覆盖该文件

#### Scenario: Damaged verifier blocks set

- **GIVEN** 已有 verifier 损坏
- **WHEN** 操作者运行 `collie password set`
- **THEN** 系统拒绝覆盖并要求先检查或显式清除
- **AND** 不把损坏内容当作“未配置”直接替换

### Requirement: Anonymous status and login are bounded

系统 SHALL 提供匿名 `GET /api/auth/status` 与 `POST /api/auth/login`，并按现有 Host、Origin、
Tailscale 身份、peer、限流和 KDF 并发约束保护它们。

#### Scenario: Status exposes only configuration

- **WHEN** 浏览器调用 `GET /api/auth/status`
- **THEN** 成功响应只包含 `configured` 布尔值
- **AND** 响应带 `cache-control: no-store`

#### Scenario: Login over HTTPS front door

- **GIVEN** 请求来自本机前门，TCP peer 是 loopback，代理声明 `x-forwarded-proto: https`
- **AND** 请求带有同源 `Origin`
- **WHEN** 密码正确
- **THEN** 系统签发普通设备 token 并写入 `paired-devices.json`
- **AND** 响应只在此刻返回 token 一次

#### Scenario: Strict loopback HTTP

- **GIVEN** 请求没有 proxy marker，Host 是 loopback，TCP peer 是 loopback
- **WHEN** 密码正确
- **THEN** 登录被允许

#### Scenario: Untrusted proxy header is not enough

- **GIVEN** 请求的 TCP peer 不是 loopback
- **WHEN** 它伪造 `x-forwarded-proto: https`
- **THEN** 密码登录被拒绝
- **AND** 不因 `arrivedOverHttps()` 的宽松判断放行

#### Scenario: Wrong password is uniform

- **WHEN** 密码错误或超出允许长度
- **THEN** 系统返回统一的 `401 password incorrect`
- **AND** 不记录或回显请求体
- **AND** 不泄露攻击尝试次数以外的时间信息
- **WHEN** 请求体缺少密码或字段类型不对
- **THEN** 系统返回 `400 bad-request`，同样不回显请求体

#### Scenario: Rate limit and KDF concurrency

- **WHEN** 同一来源一分钟内超过现有配对限流阈值
- **THEN** 系统返回 429 和 `retry-after`
- **WHEN** 并发 scrypt 超过进程上限
- **THEN** 系统拒绝或排队，队列满时返回 503，不无限占用内存

### Requirement: Login issues an ordinary device token

系统 MUST 复用现有设备注册表、有效期、审计和撤销语义；共享密码 MUST NOT 直接作为 API bearer。

#### Scenario: Password token is revocable

- **GIVEN** 浏览器通过密码登录成功
- **WHEN** 操作者在另一设备或 CLI 撤销该设备
- **THEN** 该 token 的下一次请求被拒绝
- **AND** 其他设备 token 继续有效

#### Scenario: Live duplicate label is refused

- **GIVEN** 注册表中已有未过期的同名设备
- **WHEN** 密码登录使用同一设备名
- **THEN** 系统返回 `409 duplicate-label`
- **AND** 不替换、不覆盖现有设备 token

#### Scenario: Expired label is replaced with cleanup

- **GIVEN** 同名设备已过期
- **WHEN** 密码登录使用该名称
- **THEN** 系统在同一次写入中替换该条目
- **AND** 记录 `device.revoke` 审计并清理旧 launcher 权限

#### Scenario: Clear password does not revoke devices

- **WHEN** 操作者运行 `collie password clear`
- **THEN** 未来的密码登录被拒绝
- **AND** 已签发的设备 token 继续有效，直到显式撤销

#### Scenario: Change password keeps devices

- **WHEN** 操作者设置新密码
- **THEN** 已登录设备继续有效
- **AND** 文档说明可逐设备撤销

### Requirement: Existing access paths keep working

系统 MUST NOT 破坏已配对设备、配对码、token 过期/撤销、local-secret 只读边界或 crew/standby
凭据。

#### Scenario: Paired device after upgrade

- **GIVEN** 升级前已配对的浏览器
- **WHEN** 它请求任意 API
- **THEN** 原 token 继续有效

#### Scenario: local-secret cannot become a browser write credential

- **WHEN** 浏览器持有 local-secret
- **THEN** 它仍只能用于本机 CLI 读取
- **AND** 不能用于写操作、Files 读或密码登录

#### Scenario: Pairing code still works

- **WHEN** 操作者运行 `collie pair` 并在网页输入代码
- **THEN** 原配对流程继续签发设备 token
