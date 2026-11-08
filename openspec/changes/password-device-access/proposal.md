# Proposal

## Why

Collie 的手机访问目前依赖一次性配对码：操作者必须在主机终端运行 `collie pair`，再把八位代码
输入手机。远端浏览器每次换设备、清空存储或配对过期后都要重复这一流程，这对“打开手机就看”是
不必要的摩擦。与此同时，把固定密码直接当作 API bearal token 会模糊撤销边界：一个共享密码无法
逐设备吊销，泄漏后只能全体失效。

本 change 增加两条受控的凭据颁发渠道：远端浏览器用固定访问密码换取普通设备 token；本机浏览器
由 `collie open` 用短期单次引导自动换取同一类 token。认证模型本身不变：所有普通 API 读写仍要
设备 token，ADR 0086 的“读也要 token”继续成立。

## What Changes

- 新增 CLI 唯一入口管理访问密码：`collie password set`、`status`、`clear`。密码只经 TTY 隐藏
  输入两次或显式 stdin 读取，绝不从 argv/env 接收；只落盘 scrypt verifier。
- 新增匿名 `GET /api/auth/status` 与 `POST /api/auth/login`。状态只回答是否配置；登录成功签发
  普通、可逐设备撤销的设备 token，复用 `paired-devices.json`、有效期和审计语义。
- 新增 `collie open`：当前 uid 在主机生成短期单次引导，通过平台 open seam 打开严格 loopback
  URL；引导值只放 fragment，前端在 router/loader 启动前捕获并清除，自动兑换设备 token。
- 前端未登录时优先显示密码表单（已配置密码时）；未配置时提示在主机运行
  `collie password set`，并保留原有配对码路径。
- 12 种语言同步新增文案；更新 docs、CHANGELOG 与 ADR 0133。

**非目标：**

- 不允许网页匿名初始化、修改或清除访问密码；不增加关闭认证的开关。
- 不把共享密码作为 API bearer，不把 local-secret 升级为浏览器写凭据。
- 不新增 SSH 密码登录；当前 SSH 仍要求 `BatchMode=yes`，SSH 凭据保管是后续独立任务。
- 不改 mux/crew 协议，不改 Host、Origin、Tailscale 身份、peer/crew/standby 边界。
- 不重写已有配对码、token 存储、撤销或过期机制。

## Capabilities

### New Capabilities

- `password-device-login`：固定访问密码的 CLI 管理、scrypt verifier、匿名状态/登录、传输与限流
  约束，以及设备 token 的颁发、重名和撤销语义。
- `local-browser-open`：`collie open` 的一次性引导、fragment 传递、浏览器早期兑换和失败回退。

### Modified Capabilities

无。仓库 OpenSpec spec 清单仍为空；本 change 不虚构旧 capability，也不以 MODIFIED 覆盖不存在
的规格。ADR 0086 的既有决策保持不变，只新增凭据颁发渠道。

## Impact

- CLI：`cli/program.ts`、新增 `cli/password.ts`、新增 `cli/open.ts`，复用 `cli/context.ts`、
  `cli/io.ts`、`cli/sys.ts`。
- Bridge：新增 `bridge/password.ts`、`bridge/open-guide.ts`、`bridge/auth.ts`；扩展
  `bridge/pairing.ts` 的显式登记入口；在 `bridge/server.ts` 增加 auth/open 路由和传输 guard；
  `bridge/index.ts` 组装 store 与限流器。
- 前端：新增 `web/src/lib/open-boot.ts`、`web/src/lib/access-login.ts`、
  `web/src/components/access-sign-in.tsx`；修改 `main.tsx`、`routes/root.tsx`、
  `lib/api-error-codes.ts` 及 12 种字典。
- 测试：新增纯模块、CLI、server guard/API、UI 单测；条件允许时用本机 Chrome 做真实隔离浏览器
  登录、重开、失败和 revoke 验证。
- 文档：`docs/commands.md`、`docs/security.md`、`docs/install.md`、`CHANGELOG.md`、`.adr/0133-*.md`。
- 兼容性：已配对设备和配对码流程不变；清除密码不吊销现有设备；修改密码后现有设备继续有效，
  可显式撤销。预计 MINOR，发布轴由发布时决定；本次不改版本、锁文件，不 commit。
