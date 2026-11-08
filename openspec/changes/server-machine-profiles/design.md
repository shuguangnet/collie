## Context

Crew 已在服务端保存成员 pin、地址及成功 SSH 安装参数；草稿既没有经远端验证，也不是成员，
不能写进 trust store 或伪装 ops 的观测结果。ADR 0015 禁止 daemon 代替操作者执行远端安装。

## Goals / Non-Goals

Goals：服务端保存参数；更换浏览器不丢配置；保留首次接入确认与持久校验；提示网络前置条件。

Non-Goals：HTTP SSH 安装器、SSH 密码库、静默接受 host key、其他服务器之间自动同步配置。

## Decisions

- 独立 owner-only JSON，字段白名单、数量/长度限制、损坏 fail closed、原子串行写。
- 路由复用设备 gate；GET 不写文件，POST/DELETE 不联网；peer 不提供该入口。
- CLI 根据随机 id 读取并校验最新文件，构造 inline flag argv 后复用 `cmdCrewAdd`。
- 页面不写 localStorage，loader 读取服务端状态；保存后 revalidate。删除仅作用于草稿。
- Crew 原有服务端 pin 和重连逻辑不变，配置保存不代表实际接入成功。

## Risks / Trade-offs

- 第一次组网仍需终端，避免本次引入安装器授权与密码保管问题。
- 当前 `crew add` 使用 BatchMode，密码-only SSH 必须先由操作者配置密钥，不宣称已支持密码。
- 用户的 Tailscale 未登录，真实第二机器组网不属于可伪造的本机浏览器验收。

## Migration Plan

旧安装不创建配置文件；首次保存才创建。已有 Crew 成员不迁移、不删除、不重签身份。

## Open Questions

完整网页远程安装和 SSH 密码引导如需支持，应单独设计授权、主机身份和短期凭据处理。
