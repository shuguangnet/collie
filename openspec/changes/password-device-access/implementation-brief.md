# Implementation brief

## 用户授权与目标

用户已要求调整现有登录体验：本机免手输一次性配对码，远端浏览器使用固定密码并记住登录；本机 Herdr 自动识别继续使用原 mux，无需改变 mux/crew 协议。交付需要真实实现、测试、主代理 review、构建并重启本地服务。上次交付 HEAD e0c177c6，工作树起始干净。

## 实施范围（先完成这一个独立交付）

1. 阅读 CLAUDE.md、DESIGN.md、ADR 0086、相关配对/本地凭据/Origin/Host/代理/限流实现与测试。创建本 change proposal/design/specs/tasks 中文文档，并新增 ADR 0133 记录新的**凭据颁发渠道**（不是放开 API 认证），更新 ADR 索引；不修改旧 ADR 决策正文使之失真。
2. 固定 Collie 访问密码：新增安全的 host-only CLI 设置/清除入口，例如 `collie password set`（TTY 隐藏输入两次，可提供 stdin 模式供自动化但绝不 argv/env 密码）、`status`、`clear`；密码最少12字符，最大长度和请求体限额。注入式纯模块，node crypto scrypt 异步 KDF+随机 salt，严格 verifier 结构与参数白名单/上限，0600 原子落盘，仅存 verifier。文件不可读/损坏 fail-closed，不自动覆盖损坏数据。不输出密码或hash。设置密码必须是CLI，不允许匿名网页初始化/修改密码。
3. 增加有限的匿名 auth status 与 login 接口。成功验证密码后创建普通可逐设备 revoke 的 bearer token，复用 paired-devices 注册及有效期语义；不要把共享密码直接作为所有 API bearer。密码不存浏览器，设备 token 继续持久化。重名设备不得无密码替换或覆盖仍有效设备；可以明确拒绝并让用户换名字。清除密码阻止未来密码登录、不悄悄吊销已有设备；修改密码同样明确文档说明现有设备继续有效，可显式 revoke。
4. 所有登录/状态入口遵守既有 Host、Origin、安全前门和 peer/crew/standby边界；密码登录仅支持HTTPS前门或严格loopback HTTP，proxy headers不能被客户端伪造来绕过；复用现有限流并限制KDF并发，错误密码统一文案、不打印payload、状态仅暴露是否配置。普通API读写仍必须凭据，不能增加 `disable auth` 开关，不将local-secret升级成浏览器写凭据。
5. 本机 `collie open`：当前 uid 通过 CLI 生成短期单次引导（可复用 pair pending），用平台已有 open seam 打开严格 loopback URL，凭据只能放fragment不可query；前端第一时间清理fragment、不写日志/历史持久化，自动兑换普通设备token、无需用户填验证码/设备名。前端请求必须带浏览器same-origin Origin，未持有引导值的localhost用户不获权；空registry不开放；不能仅凭localhost/UA/header自动登录；不能以永久local-secret进URL。已登录浏览器不反复生成新设备；label唯一并有合理数量上限/失败提示。支持 basePath、实例及未知URL拒绝。
6. 前端未登录状态优先展示密码表单（配置时），记住设备名/密码字段autocomplete合适；未设密码提示在主机CLI设置、或继续备用配对。同步12种语言，不破坏已配对用户、码配对、过期/revoke、网络恢复不丢token。复用UI primitives。新增纯模块、CLI、server guard/API、UI单测；可用Playwright时做真实隔离浏览器登录、重开、失败与revoke验证。
7. 更新 docs commands/security/install 和 CHANGELOG Unreleased；不改版本/lockfile。不在源码/任务书写真实密码/token，不触碰真实SSH远端、系统Tailscale或其他agent。现有本地launchd服务正在运行，不由你重启，由主代理review后重启。
8. SSH机器密码添加当前BatchMode=yes、不支持；本交付明确不假装支持、不保存SSH密码；文档列下一独立任务，需要明确凭据保管与known_hosts验证方案。不得为了满足网页登录而降低SSH主机校验。

## 验证工具

Bun 1.4.4固定归档已校验，路径在 `/tmp/collie-review-bun-path`：用python读路径，再 export PATH="$(dirname "$BUN"):$PATH"。两侧node_modules已安装。macOS socket测试使用 `/tmp/collie-review-test-tmpdir` 记录的 /private/tmp短规范路径作为TMPDIR，避免/var软链造成既有失败。
OpenSpec可用 `CI=1 OPENSPEC_TELEMETRY=0 node /Users/shuguang/.npm/_npx/b098fb4e2a1b2260/node_modules/@fission-ai/openspec/bin/openspec.js validate password-device-access --strict`。
CLI全量既有一项 account-windows Keychain文案断言失败已在基线复现，不为此改无关逻辑。

## 协作

你负责代码与测试，不commit、不push、不启动服务、不设置真实密码。主代理独立审查后处理。完成后停止编辑，报告变更、测试、未完成点。使用指定模型 9779/deepseek-v4.1-flash；若上下文不足写进度文档并停止请求继续，不省略安全检查。
