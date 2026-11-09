## ADDED Requirements

### Requirement: HTTPS guide exchange

系统 SHALL 允许主机生成的有效一次性引导通过受信任 HTTPS 前门兑换普通可撤销设备 token，并保留 Host、Origin、身份检查、限流、请求体上限和先消费后注册。

#### Scenario: Remote browser enrols

- **GIVEN** 浏览器持有未过期未使用的引导，通过允许的 HTTPS 前门同源 POST
- **WHEN** 兑换引导
- **THEN** 仅签发一个普通设备 token，并拒绝重放

#### Scenario: Insecure or cross-origin request

- **WHEN** 请求使用远端 HTTP、错误或缺失 Origin、未允许 Host 或不可信 TCP peer
- **THEN** 系统 MUST 拒绝请求且不消费引导

### Requirement: Explicit link disclosure

CLI SHALL 默认打开本机地址且不输出凭据，只有显式 --print 输出链接；--remote SHALL 只使用现有配置的实例 HTTPS 入口。

#### Scenario: Print a remote link

- **WHEN** 主机运行 collie open --remote --print
- **THEN** 输出两分钟单次链接，stderr 提醒完整设备权限，不打开浏览器

#### Scenario: Invalid destination

- **WHEN** 地址非 HTTPS、含 userinfo/query/fragment 或 mount 不匹配
- **THEN** CLI MUST 在生成引导前拒绝

### Requirement: Safe browser boot

前端 SHALL 接受 HTTPS origin 的引导，在任何请求前清除 fragment，并复用有效设备 token。

#### Scenario: Existing browser receives another guide

- **WHEN** 已打开的浏览器收到新的引导 fragment
- **THEN** 重新引导并清除 fragment，不创建多余设备
