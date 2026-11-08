# 主代理验收记录

## 已完成

- 认证入口只签发普通设备 token；匿名 snapshot 仍返回 403，不按 localhost 自动授权。
- 修复 owner-file 的 NTFS 权限判定，复用已有 ACL 检查；无法验证私有权限时拒绝。
- 修复隐藏 TTY 输入的箭头／功能键序列解析，并补跨 chunk 回归测试。
- 更新路由、stateDir 和私有文件／平台清单守卫，不移除普通 API 的认证断言。
- root/web typecheck、lint、完整 build、OpenSpec strict、diff check 通过。
- 完整前端：54,516 pass、34 expected fail、1 skip、56 todo。
- 完整 bridge：10,376 pass、44 skip、0 fail；CLI：3,069 pass、5 skip、1 fail。
  唯一失败是原始基线已复现的 account-windows Keychain 文案断言。
- scripts/herdr-app-mod/omp-extension：766 pass、47 skip、0 fail（使用规范化短 TMPDIR）。
- shell 的 ctl、payload-links、upstream-bun、tag、flake-lock、pre-commit、AUR pkgbuild 通过。
  collie-cli 在 env -i 找不到 Bun 后的期望文案不符，已在原始基线复现；packaging refresh
  有 3 项因 macOS BSD sed 不兼容失败，未为本功能修改这些无关脚本。
- 隔离状态目录和真实 Chrome 验证：错误密码、正确登录、刷新保留 token、本机引导兑换及
  fragment 清除、重放拒绝、重复 open 不增加设备、CLI revoke 后回登录页、错误/缺失 Origin、
  超长 body、损坏 verifier 返回 503。
- 已重启本机 launchd 并实际执行 `collie open`，浏览器成功注册 Local browser。
- 已执行 `collie link`，新 zsh 可解析 `~/.local/bin/collie`。

## 保留限制

- 未代设真实密码；操作者通过 `collie password set` 隐藏输入。
- Tailscale 尚未登录，未验证手机及真实 HTTPS 前门。
- 本机认证可用不代表 SSH 密码注册或多机网页安装已实现。
