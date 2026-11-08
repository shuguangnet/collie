# Review 记录

首轮以下四项已修复并复核。最终追加检查修复了实际 launchd argv 与当前实例不一致、
任意条件 KeepAlive 被当作崩溃恢复保证，以及 doctor 非零退出丢失有效未就绪原因的问题。
CLI 最终回归 3046 pass / 5 skip / 1 既有失败，根 typecheck、lint、版本检查及 OpenSpec
strict validate 通过。真实机器重启与手机浏览器系统验收仍待执行。

## 首轮 Review 阻断项

主代理已取得并验证 `flake.nix` 固定 Bun 1.4.4 归档，工具路径保存在
`/tmp/collie-review-bun-path`。两侧依赖已 frozen-lockfile 安装，未改 lock。
在 shell 使用 `BUN=$(python3 -c 'from pathlib import Path; print(Path("/tmp/collie-review-bun-path").read_text().strip())'); export PATH="$(dirname "$BUN"):$PATH"` 即可运行。

## 必须修复

1. **持久成功没有验证实际运行服务归属与持久配置。**
   Linux 目前只检查同名文件的 uid 和 unit enabled/active；文件是同用户另一个安装、unit 的
   FragmentPath/ExecStart 指向别处、`enabled-runtime` 只在当前启动有效都能误报无人值守就绪。
   必须检查实际 loaded unit 对应当前安装/实例，并将 runtime-only enable 判未就绪。
   macOS 仅同名 loaded + pid 就 ready，缺少 RunAtLoad/KeepAlive、disabled override、实际 program
   与当前安装/实例的一致性；one-shot 或其他安装同名 job 也能误报。读取实际 job 与可持久 plist，
   无法证明则 unknown；外部管理服务只读识别、不覆盖。两域有停止 GUI 和运行 user 时要发现运行者。

2. **远端 JSON parser 不是 fail-closed。**
   仅 ready/guarantee/reasons 存在即可，其余缺失默认，未知 reasons 被丢弃；
   `[{"check":"persistence","data":{"ready":true,"guarantee":"unattended","reasons":[]}}]`
   能当成功，矛盾 ready true / muxReachable false 同样可接受。
   应验证完整必需字段、枚举、三态 boolean，未知/矛盾形状拒绝为 unverified，并测试。
   `persistenceLeg` 还必须检查进程退出码：非零退出即便 stdout 有 ready 也不能成功。

3. **重复添加在 persistent 模式未证明 lead->peer Crew 链路。**
   enrollLeg 的 already-member 分支对未改变配置直接成功，不 probeMembers；远端 SSH 的 doctor
   能读本机 mux 不表示 lead 能直达它。persistent 模式在已注册路径也必须以本 lead 现有固定身份
   验证真实 Crew link；不可达/证书冲突返回非成功且保留注册，不旋转证书。

4. **修复建议错误目标。**
   persistenceRemedy 硬编码 collie unit、gui domain 和 herdr.collie label；named instance 会引导操作
   默认实例；Herdr-managed 安装又绕过了 CLAUDE.md 指定的 plugin action。
   优先使用安装类型和当前实例生成正确指引，避免硬编码 systemctl/launchctl mutation；无身份上下文
   的 report 可给只读状态检查建议，不能猜测要改哪一个服务。
   Mac 成功文本 `survives logout and login` 过度承诺，改为 starts/restarts in the supported login session。

## 验证

- 首轮两侧 typecheck、lint、针对性前端 84 tests 已通过。
- 首轮 Bun 672 tests 有 12 fail，其中新增 uid seam 相关失败已由你修复；其余多数与现有 macOS
  `/var` symlink 和 Keychain 文案相关，主代理将用原始 HEAD 单独对比，不要为此弱化安全边界。
- 请修复上述项及相关最小测试，补 tasks 的本地验证证据。不要 commit/push；完成后停止编辑再交 review。
