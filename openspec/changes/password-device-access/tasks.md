# Tasks

## 1. 规划与决策记录

- [x] 1.1 完成 proposal / design / specs / tasks 中文文档，并通过 OpenSpec strict validate。
- [x] 1.2 新增 ADR 0133，记录“密码/引导只颁发普通设备 token”，并更新 `.adr/README.md` 索引。

## 2. 密码纯模块

- [x] 2.1 新增 `bridge/password.ts`：固定 scrypt 参数、随机 salt、严格 verifier 解析、长度策略、
      `timingSafeEqual`、注入式异步 IO 和 0600 原子写入。
- [x] 2.2 损坏文件读取为 `invalid`，`set` 拒绝自动覆盖；`clear` 可显式删除。
- [x] 2.3 单测覆盖参数白名单、短/长密码、损坏 JSON、不可读、原子写入、正确/错误密码。

## 3. 引导纯模块

- [x] 3.1 新增 `bridge/open-guide.ts`：256-bit 引导、2 分钟 TTL、单次消费、0600 原子写入。
- [x] 3.2 单测覆盖解析、过期、二次兑换、损坏、不可读。

## 4. CLI

- [x] 4.1 新增 `cli/password.ts`：`set`（TTY 隐藏两次或 `--stdin`）、`status`、`clear`，绝不从
      argv/env 接收密码，不输出秘密。
- [x] 4.2 新增 `cli/open.ts`：写引导、构造严格 loopback URL、平台 opener seam；支持 basePath 和
      实例；不打印 URL。
- [x] 4.3 在 `cli/program.ts` 注册 `password` 与 `open`。
- [x] 4.4 CLI 单测覆盖隐藏输入、stdin、长度、损坏拒绝覆盖、clear、open URL 和失败路径。

## 5. Bridge 认证与路由

- [x] 5.1 新增 `bridge/auth.ts`：登录/兑换请求解析、传输条件、自动标签选择、统一 reason。
- [x] 5.2 扩展 `bridge/pairing.ts`：显式登记入口、设备上限、过期替换复用。
- [x] 5.3 `bridge/server.ts` 增加匿名 `GET /api/auth/status`、`POST /api/auth/login`、
      `POST /api/auth/open`；加入 `OPEN_API_ROUTES`，自带 gate、限流、KDF 并发和 no-store。
- [x] 5.4 成功登录/兑换复用审计、过期替换清理和 launcher 撤销；重名活动设备拒绝。
- [x] 5.5 `bridge/index.ts` 组装 password store、open guide store 和限流器。
- [x] 5.6 单测覆盖传输矩阵、Origin、Host、限流、并发、错误文案、重名、过期替换、open 空 registry。

## 6. 前端

- [x] 6.1 新增 `web/src/lib/open-boot.ts`：首帧前捕获并清除 fragment，只执行一次兑换，已有 token
      先验证。
- [x] 6.2 `web/src/main.tsx` 在 App/router 前等待 boot promise。
- [x] 6.3 新增 `web/src/lib/access-login.ts`、`web/src/components/access-sign-in.tsx`：状态、密码
      表单、设备名、autocomplete、失败文案、未配置提示和配对码回退。
- [x] 6.4 `RootLayout` 在未登录时优先渲染登录页；不破坏已配对用户。
- [x] 6.5 `web/src/lib/access-login.ts` 携带 auth 请求与类型，不把 401 当作配对撤销。
- [x] 6.6 12 种语言同步文案；单测覆盖 gate、open-boot、StrictMode 幂等、失败和已有 token。

## 7. 验证与文档

- [x] 7.1 `bun run typecheck`（root 与 web）。
- [x] 7.2 后端 `bun run test` 与前端 `bun run test`；记录基线已知失败。
- [x] 7.3 条件允许时用本机 Chrome 和 Playwright 做真实隔离浏览器登录、重开、错误密码、revoke。
- [x] 7.4 更新 `docs/commands.md`、`docs/security.md`、`docs/install.md` 和 `CHANGELOG.md` 的
      Unreleased。
- [x] 7.5 不 commit、不 push、不重启服务、不设置真实密码；报告变更、测试和未完成点供主代理 review。
