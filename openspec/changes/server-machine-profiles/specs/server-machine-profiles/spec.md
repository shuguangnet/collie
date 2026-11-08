## ADDED Requirements

### Requirement: Server-owned connection parameters

系统 SHALL 将显式保存的连接配置持久化于当前实例服务端，而非浏览器存储；配置 MUST 不包含
SSH 密码、私钥、设备 token，未知字段必须拒绝。保存与读取 SHALL 不发起远端连接。

#### Scenario: Another browser sees saved configuration

- **WHEN** 一个已认证浏览器保存有效配置
- **THEN** 第二个已认证浏览器及重启后的服务读取相同配置
- **AND** 浏览器不需要迁移 localStorage

#### Scenario: Corrupt file fails closed

- **WHEN** 文件存在但不可读或格式损坏
- **THEN** 读取及写入返回不可用，不将旧内容覆盖为空列表

#### Scenario: Credentials or unsafe parameters are refused

- **WHEN** 请求包含 password 字段、SSH 选项注入或含凭据的地址
- **THEN** 服务拒绝并不保存内容、不联网

### Requirement: Authenticated bounded management

系统 SHALL 对配置读写应用既有设备 gate，写入使用 write gate，限制请求体、数量和字段长度，
并以 owner-only 原子串行写持久化。peer SHALL 拒绝提供配置管理。

#### Scenario: Unpaired client is refused

- **WHEN** 无设备 token 请求任意配置操作
- **THEN** 请求被拒绝且不返回保存的主机信息

#### Scenario: Saved profile is not membership

- **WHEN** 用户仅保存或删除连接配置
- **THEN** 系统不更改 Crew 信任和成员身份，也不安装或停止服务

### Requirement: Operator-driven enrollment from saved parameters

系统 SHALL 提供 `collie crew add --saved <id>`，读取当前实例已验证的配置参数，经 argv 复用
既有 SSH 安装、确认、注册及持久性校验，不接受额外 host 或覆盖参数。

#### Scenario: Consume a saved profile

- **WHEN** 操作者在主机执行有效配置 id
- **THEN** 系统使用保存的参数进入现有 SSH 接入流程并保留所有确认

#### Scenario: Invalid or missing profile

- **WHEN** id 无效、不存在或配置文件不可用
- **THEN** 命令拒绝且不启动 SSH 或候选选择

### Requirement: Honest connection state

界面 SHALL 明确保存不等于联网成功，并说明首次接入要在主机终端执行；已注册机器继续使用
Crew 的服务端身份和自动重连。界面 SHALL 提示 localhost 不能充当另一机器可达的 lead 地址。

#### Scenario: Machine returns after outage

- **WHEN** 已注册机器离线后恢复可达
- **THEN** 现有 Crew 使用 pinned 身份重连，不要求每个浏览器重新添加
