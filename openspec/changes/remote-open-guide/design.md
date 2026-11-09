## Context

原引导仅在 127.0.0.1 兑换；主机 shell 生成的高熵凭据本身已能证明授权。

## Goals / Non-Goals

允许远端 HTTPS 浏览器使用引导；不允许远端 HTTP，不新增匿名权限或代理托管方式。

## Decisions

复用 authDenied、既有 bridgeUrl、consume-before-enrol 和前端 token 存储；--print 显式告警。远端地址必须为实例的准确 mount、无 userinfo/query/fragment 的 HTTPS URL。

## Risks / Trade-offs

输出链接可能进入终端历史、日志或截图；仅显式输出，并告知两分钟内持有者有完整设备注册能力。

## Migration Plan

默认本机 open 不变。构建后重启本机服务，恢复 loopback 监听并通过既有 Tailscale HTTPS 前门发布。

## Open Questions

无。真实其他机器的可达性仍取决于 Tailnet ACL 和客户端网络。
