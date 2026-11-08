# 主代理审查与验收

## 实现边界

- 参数草稿保存到实例服务端，Crew 仍是注册机器与身份的唯一权威；不写浏览器 storage。
- 保存／读取／删除不联网、不安装、不改 trust 或 ops 文件；HTTP 入口不执行命令。
- --saved 从磁盘读取最新严格校验文档，以 inline flags 传给既有 CLI，保留确认和 persistent 检查。
- GET 只读 paired gate，POST/DELETE write gate；peer 拒绝；整体经过安全响应头包装。
- mux 名来自服务端注册表，不在前端硬编码，也不引入第二套驱动列表。
- 字段、数量、文件、请求体均有界；无密码／私钥字段；损坏文件不能被写操作重置。

## 验证结果

- 全量后端：14,261 pass、96 skip、1 fail。唯一失败是此前基线复现的 account-windows
  Keychain 文案断言，未为此修改不相关测试。
- 全量前端：54,523 pass、34 expected fail、1 skip、56 todo，622 files。
- 真实 pinned TLS Crew 集成：82 pass、0 fail；这证明现有协议回归，不是实际第二机器验收。
- 根/web typecheck、lint、完整 build、playground build、OpenSpec strict、git diff --check 通过。
- 真实 Chrome 隔离目录：匿名读写拒绝；表单写 0600 服务端文件；刷新保留；第二独立浏览器读取；
  localStorage/sessionStorage 无主机配置；bridge 重启保留；未知凭据字段不保存；确认删除同步；
  损坏文件界面拒绝覆盖。
- playground 的空列表／保存配置／不可用／手机宽度表单已通过 Chrome 检查并截图。

## 仍需真实环境的验收

- 未运行真实 SSH，不代替用户确认其他机器 host key，不保存或请求聊天传输 SSH 密码。
- Tailscale 尚未完成登录；未虚构 remote 可达地址，localhost 不能作为另一机器的 lead 地址。
- 首次 SSH 认证仍需主机已配置 key/agent，当前 BatchMode 不支持网页输入密码。
- profile 目前提供新增／删除，修改须重存草稿；不影响已加入成员。
