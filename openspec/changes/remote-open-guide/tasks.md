## 1. Implementation

- [x] 1.1 ADR 修订和明确链接泄漏边界。
- [x] 1.2 后端复用 HTTPS 传输与前门检查。
- [x] 1.3 CLI remote/print 与目的地址校验。
- [x] 1.4 前端 HTTPS fragment 与已有标签页引导。

## 2. Validation

- [x] 2.1 后端 513、前端定向 15 tests，双 typecheck 和 lint。
- [x] 2.2 完整构建；真实 Chrome 经隔离 TLS 前门验证兑换、fragment 清除、刷新保留、重放／缺失及跨 Origin／HTTP 拒绝、已有页 token 复用、普通 API 仍拒绝匿名。
- [x] 2.3 本机 launchd 服务恢复并链接 CLI，仅监听 127.0.0.1；旧手动 wide-bind 进程已终止。Tailnet 已登录但尚未启用 HTTPS 证书，远程发布被明确阻止，并非已验收真实手机可达。
