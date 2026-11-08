# 本机浏览器打开

## Purpose

让运行 `collie open` 的主机用户无需手输代码或设备名即可进入 Collie，同时不让任何匿名网络请求
仅凭 loopback、UA 或 header 自动获得设备 token。

## ADDED Requirements

### Requirement: CLI mints a short-lived single-use guide

`collie open` SHALL 在主机生成高熵、短期、单次使用的引导值，并只把它放进 loopback URL 的
fragment。

#### Scenario: Open the strict loopback URL

- **GIVEN** 操作者在主机运行 `collie open`
- **WHEN** 服务可访问
- **THEN** 系统写入 `<stateDir>/open-pending.json` 的引导 hash
- **AND** 通过平台 opener 打开 `http://127.0.0.1:<port><basePath>#collie-open=<token>`
- **AND** 不打开 tailnet 名称，不打印 URL 或引导值

#### Scenario: Instance and basePath are respected

- **GIVEN** 操作者设置了非默认实例或 `COLLIE_BASE_PATH`
- **WHEN** 运行 `collie open`
- **THEN** URL 使用该实例的端口和该 basePath
- **AND** 不使用另一个实例的地址

#### Scenario: Unknown or unsafe URL is refused

- **WHEN** 无法确定 loopback 地址、端口或 basePath 不合法
- **THEN** 系统拒绝打开并给出错误
- **AND** 不把引导值放到 query、路径或日志中

#### Scenario: Guide expires and is consumed once

- **GIVEN** 引导值已超过 2 分钟
- **WHEN** 浏览器兑换
- **THEN** 系统拒绝并删除过期引导
- **WHEN** 同一引导值第二次兑换
- **THEN** 系统拒绝

### Requirement: Fragment is handled before the router starts

前端 MUST 在 router 和 loaders 启动前捕获并清除引导 fragment，且 MUST NOT 把它写入日志、历史或
持久存储。

#### Scenario: Capture and clear before startup

- **GIVEN** URL 带有 `#collie-open=<token>`
- **WHEN** 应用加载
- **THEN** 引导值在 `createRoot` 之前被读入模块内存
- **AND** `history.replaceState` 立即移除 fragment
- **AND** 地址栏、历史记录和任何日志中不再出现该值

#### Scenario: StrictMode does not exchange twice

- **GIVEN** 引导值正在兑换
- **WHEN** React StrictMode 或 HMR 重复执行启动逻辑
- **THEN** 兑换只发出一次
- **AND** 成功后的 token 不会被第二次执行清掉

#### Scenario: Unknown fragment is not exchanged

- **GIVEN** fragment 不是精确的 `#collie-open=<43 字符 base64url>`
- **WHEN** 应用加载
- **THEN** 它不被当作引导值
- **AND** 不发起兑换请求
- **AND** 形如 `#collie-open=...` 的 fragment 仍会被清除，不留在地址栏

### Requirement: Exchange requires the guide and a browser request

`POST /api/auth/open` SHALL 要求有效的单次引导、同源 `Origin` 和严格 loopback 传输条件；任何
匿名 localhost 请求都不得仅凭地址自动登录。

#### Scenario: Browser with the guide exchanges it

- **GIVEN** 浏览器从严格 loopback URL 打开，且持有未使用的引导值
- **WHEN** 它 POST 引导值并带有同源 Origin
- **THEN** 系统签发普通设备 token
- **AND** 引导值被消费

#### Scenario: Localhost without the guide gets nothing

- **GIVEN** 同机另一个浏览器或进程没有引导值
- **WHEN** 它请求 `/api/auth/open`
- **THEN** 系统拒绝
- **AND** 不从 UA、header、referer 或 loopback 地址推断身份

#### Scenario: Empty registry is not a bypass

- **GIVEN** `paired-devices.json` 为空
- **WHEN** 请求没有有效引导
- **THEN** 系统仍拒绝兑换
- **AND** 不因为“还没有设备”而开放自动登录

#### Scenario: Cross-origin or proxied request is refused

- **GIVEN** 请求缺少同源 Origin，或带有 proxy marker，或 peer 不是 loopback
- **WHEN** 它尝试兑换
- **THEN** 系统拒绝

### Requirement: Already signed-in browsers keep their token

前端 SHALL 在兑换前检查已有设备 token；有效时 MUST NOT 创建新设备。

#### Scenario: Reopen keeps the same device

- **GIVEN** 浏览器已持有有效设备 token
- **WHEN** 再次运行 `collie open` 并打开页面
- **THEN** 前端验证现有 token 后丢弃新引导
- **AND** 注册表不新增设备

#### Scenario: Token is accepted without a guide

- **GIVEN** 浏览器之前通过密码或配对登录
- **WHEN** 它重新打开 Collie
- **THEN** 沿用 localStorage 中的设备 token
- **AND** 不要求再次输入密码或运行 `collie open`

### Requirement: Auto-generated labels are unique and bounded

系统 SHALL 为 `collie open` 自动选择不冲突的设备名，并在达到上限时给出可操作错误。

#### Scenario: First open gets a label

- **WHEN** 引导有效且注册表还有余量
- **THEN** 系统选择一个不冲突的标签并登记设备

#### Scenario: Label space exhausted

- **GIVEN** 尝试的自动标签均已被活动设备占用
- **WHEN** 兑换
- **THEN** 系统返回 `409 label-unavailable`
- **AND** 前端提示先撤销旧设备或改用密码/配对码

#### Scenario: Device cap reached

- **GIVEN** 设备总数达到 `MAX_PAIRED_DEVICES`
- **WHEN** 兑换需要新登记一个标签
- **THEN** 系统返回 `409 device-limit`
- **AND** 前端提示先撤销旧设备

#### Scenario: Expired holder is replaced

- **GIVEN** 自动标签对应的设备已过期
- **WHEN** 兑换
- **THEN** 系统复用过期替换、审计和 launcher 清理语义
- **AND** 不留下旧设备的写权限

### Requirement: Failure falls back to the normal sign-in paths

前端 SHALL 在引导兑换失败时显示可操作提示，并保留密码登录与配对码入口。

#### Scenario: Guide expired or spent

- **WHEN** 兑换返回过期或已消费
- **THEN** 页面提示在主机重新运行 `collie open`
- **AND** 页面仍提供密码登录和配对码入口

#### Scenario: Network failure

- **WHEN** 兑换因网络失败
- **THEN** 页面提示连接问题并允许重试
- **AND** 不把失败当作成功登录，也不丢失已有 token
