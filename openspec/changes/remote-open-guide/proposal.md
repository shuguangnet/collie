## Why

用户明确要求去除一次性打开链接仅限本机浏览器兑换的限制，允许手机或其他电脑通过既有 HTTPS 入口注册设备，并重新启动本机服务。

## What Changes

- `/api/auth/open` 采用密码登录相同的严格 loopback HTTP 或受信任 HTTPS 前门传输检查。
- `collie open --remote` 使用现有实例前门地址，`--print` 显式输出含凭据链接，默认行为不泄漏凭据。
- 前端接受 HTTPS origin 的 fragment，同时保持即时清除、已有 token 复用和单次启动。

## Capabilities

### New Capabilities

- `remote-open-guide`：跨浏览器的一次性 HTTPS 引导。

### Modified Capabilities

## Impact

修改 CLI、认证路由和前端引导；不放开普通 API，不关闭 Host/Origin 或代理身份验证。ADR 0135 修订 ADR 0133 的局部限制。
