# 稳定设备访问

## Purpose

确保操作者使用固定 Collie 入口时，一次合法配对可以跨页面重开和服务重启持续生效，同时保留
设备撤销、显式到期以及首次授权的安全边界。连接中断与身份丢失必须得到不同的诊断和处理方式。

## ADDED Requirements

### Requirement: Pairing survives ordinary restarts

使用同一入口和同一实例状态时，系统 SHALL 复用已持久保存且有效的设备凭据；页面重开、
Collie 重启、Herdr 重启和机器短暂离线 MUST NOT 单独触发重新配对。

#### Scenario: Reopen a paired browser

- **GIVEN** 浏览器保存有效凭据，且服务端保留对应设备注册
- **WHEN** 操作者关闭并重新打开相同 Origin 的 Collie
- **THEN** 系统自动使用原凭据获取授权范围内的数据
- **AND** 不要求重新执行 `collie pair`

#### Scenario: Bridge restarts without state loss

- **GIVEN** 实例的设备注册文件未改变且凭据未撤销、未到期
- **WHEN** Collie 重启
- **THEN** 设备凭据继续有效，恢复访问不要求重新配对

### Requirement: Network failure does not invalidate credentials

系统 MUST 区分网络不可达与明确的授权拒绝；网络失败、超时或服务器错误 SHALL NOT
清除有效凭据或引导用户用重新配对来修复离线机器。

#### Scenario: Network times out

- **WHEN** 手机请求因断网超时，且未得到明确授权拒绝
- **THEN** 系统保留设备凭据并显示连接恢复状态
- **AND** 网络恢复后自动继续使用该凭据

### Requirement: Revocation and expiry remain authoritative

系统 MUST 继续对 API 读写验证设备凭据，保留现有公开例外；合法撤销或显式到期 SHALL
终止设备访问，固定机器或持久模式不得绕过这些检查。

#### Scenario: Device is revoked

- **WHEN** 操作者撤销当前设备的有效配对
- **THEN** 后续受保护 API 请求被拒绝，遵循既有设备清理与重新授权流程
- **AND** 不因机器已固定注册而自动补发 token

#### Scenario: Explicit lifetime expires

- **GIVEN** 操作者以有限有效期授权设备
- **WHEN** 凭据到期
- **THEN** 系统明确显示到期并要求重新合法授权
- **AND** 不把到期无限延长为“自动重连”

### Requirement: Stable origin and state prerequisites are explained

系统 SHALL 说明持续配对要求相同浏览器 Origin、未清除的站点存储及稳定的实例状态目录；
新 Origin、丢失状态或清空存储 MUST NOT 获得旧身份的自动授权。

#### Scenario: Origin changes

- **WHEN** 操作者从原地址改用不同 scheme、host 或 port 的地址
- **THEN** 新 Origin 无旧 token 时按未配对设备处理
- **AND** 部署指引解释 Origin 的隔离，不通过 URL 参数传递旧 token

#### Scenario: Service uses another state directory

- **WHEN** 服务改用不同状态目录而没有原设备注册
- **THEN** 系统拒绝未知 token，并指引检查实例、运行用户与状态目录
- **AND** 不自动创建受信设备记录或关闭配对门禁

### Requirement: One phone entry accesses the enrolled crew

手机 SHALL 通过 lead 的固定入口访问其有权访问的已注册成员，不要求为每个 peer 另行建立
浏览器配对或公开独立入口。

#### Scenario: Open an enrolled peer from the lead

- **GIVEN** 手机已在 lead 配对且 peer 的 Crew 身份有效
- **WHEN** 手机从固定机器列表打开该 peer 的会话
- **THEN** 请求通过现有 Crew 授权与转发访问目标
- **AND** 手机无需向 peer 发送 SSH 凭据或进行独立设备配对
