# 实施任务书

## 授权与分工

用户已在本会话明确授权：由 Herdr 右侧 OpenCode 使用 `9779/deepseek-v4.1-flash` 执行本提案，
执行后由主代理 review、修复、验证并提交推送 GitHub。此前 planning-only 限制已被此授权取代。

OpenCode 负责实现和本地验证，不负责 git commit / push；主代理独立 review 后提交。
工作目录固定为 `/Users/shuguang/project/collie/collie`，复用当前 checkout，不创建其他 pane/worktree。
已有未提交的 `AGENTS.md` 和 `openspec/` 是本任务规划成果，必须保留。

## 阅读顺序

1. `CLAUDE.md`（完整工程约定）和 `AGENTS.md`。
2. 本 change 的 proposal、三份 specs、design、tasks 与 `openspec/project-analysis.md`。
3. 相关 ADR 0011、0013、0015、0016、0040、0086 及涉及模块的已有测试。

## 交付范围

按 tasks.md 实现本地可完成项并诚实更新进度，核心是：

- 注入式持久运行诊断：Linux user service / linger，macOS launchd / after-login，未支持平台不得误报。
- 对现有 `doctor --only persistence --json` 参数模式先确认 CLI 现状，再最小兼容接入；status 复用同一判定。
- `crew add --persistent`，显式目标和已注册成员均检查，复用现有 SSH runner、注册与 mux 选择。
- 持久检查失败必须非成功、保留已合法完成的状态；不能把进程存在等同全链路就绪。
- 机器页只读指引、现有状态的准确展示、全部语言字典同步及相应组件测试。
- 配对和恢复的必要回归测试，网络失败不得清凭据，信任冲突不得自动接受，失败写操作不得重放。
- 功能对应文档、必要测试和准确的 OpenSpec 任务状态。

不能通过删需求或把未验证项勾选为完成来结束。测试已有覆盖时可引用具体测试，避免复制测试。

## 操作边界

- 不访问用户 SSH 主机、不重启真实机器、不修改用户服务、Tailscale、linger、系统配置或真实 Herdr。
- 不启动/关闭其他 pane，不联系外部人员，不修改 SSH/模型配置，不输出凭据。
- 不创建 Herdr daemon、不引入网页 SSH 安装或新的信任/注册表，不关闭配对。
- 不改版本文件、flake.lock，不执行 release/tag；无必要不改 Crew wire。
- 依据 CLAUDE.md 先检查工具链，优先已有环境 / pinned flake；不要擅自安装构建工具绕过版本限制。
- 运行实际可用且与改动相关的 typecheck、lint、测试；不可用检查报告阻塞原因，不宣称通过。
- 本仓库是用户 fork `shuguangnet/collie`；交付目标为用户自己的仓库而不是上游 PR。主代理负责最终判断 changelog 和提交。

## 验收与报告

每组实现同时包含测试和文档。tasks.md 中无法安全执行的真实系统验收保持未勾选并注明原因。
完成后在当前对话报告：改动文件和行为、实际执行的验证及结果、未完成项与原因、潜在风险。
停止编辑并交给主代理 review；不要提交或推送。
