## Why

用户需要保存其他机器的连接配置，不能只依赖单个浏览器。现有 Crew 服务端注册和自动重连可复用，
但网页没有保存首次接入参数的入口，且 localhost 地址易被误解为远程可达地址。

## What Changes

- 提供经过设备读写 gate 的服务端连接配置列表、保存及删除。
- 机器页填写 SSH 接入参数，复制 id-only 命令在主机终端执行既有安装／注册流程。
- 明确未验证配置与 Crew 机器身份的区别，不收集 SSH 密码／私钥，不通过 HTTP 启动安装器。

## Capabilities

### New Capabilities

- `server-machine-profiles`: 服务端连接配置持久保存、跨浏览器读取和主机终端消费。

### Modified Capabilities

无。Crew wire 和已注册成员的权威不变。

## Impact

新增 `machine-profiles.json` 与受保护 `/api/machine-profiles`，CLI 增加 `crew add --saved`。
更新机器页面、语言字典和操作文档；不修改版本、依赖或 Crew 协议。
