# 服务端机器连接配置

## 目标

用户要求其他机器的连接配置保存在 Collie 服务端，换浏览器后仍然可用。复用 Crew 作为真正的
机器注册和自动重连权威，不将一个未验证的 SSH 地址或书签描述成已连接机器。

## 范围

- 机器页面增加连接配置表单和服务端列表，读写需要既有设备认证，写入需 write gate。
- 独立 `<stateDir>/machine-profiles.json` 只保存操作参数，不保存 SSH 密码、私钥或浏览器 token。
- 配置包含稳定随机 id、名称、SSH target、远端 Collie port、mux 及可选 lead HTTPS 地址、
  peer bare host、remote path、instance；数量、字段和请求体有界。
- 保存不执行 SSH、不探测 URL、不接受证书、不安装程序、不改服务。首次由主机终端执行
  `collie crew add --saved <id>`，复用所有现有确认和持久性检查。
- `--saved` 读取最新服务端文件，不与位置 host 或参数覆盖混用；文件损坏拒绝，不走候选选择。
- 已注册机器仍来自 Crew 的服务端 trust store，保留身份 pin、离线保存和自动重连。
- 删除配置仅删除草稿，不能删除 Crew 成员；页面明确此边界。

## 安全与测试

- 0600 原子写入，损坏／不可读 fail closed；GET 不创建文件；写入串行、成功后返回最新数据。
- 严格白名单拒绝密码等未知字段，避免将凭据误存或放到复制命令里。
- 前端不使用 localStorage 保存连接配置。已保存命令仅含安全随机 id，字段不拼 shell。
- 纯逻辑、CLI、API gate、前端表单／跨客户端读取测试；真实隔离 Chrome 测试保存、刷新、第二
  浏览器读取、删除及匿名拒绝。不访问真实 SSH 主机。
- 更新 docs/crew、commands、CHANGELOG、ADR 和 OpenSpec；typecheck/lint/build 后本机重启。
