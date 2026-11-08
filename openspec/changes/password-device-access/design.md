# Design

## Context

现有认证链路是两道独立闸门：`checkAccess` 负责 Host、Origin、可选 Tailscale 身份；`guard` 在
ADR 0086 之后要求每个 `/api/*` 请求都持有 `paired-devices.json` 中的设备 token。`/api/health`
与 `POST /api/pair` 是仅有的两个 OPEN_API_ROUTES，后者本身就是“用一次性代码换 token”的引导。

本 change 新增的是**凭据颁发渠道**，不是认证旁路：

| 入口 | 证明 | 结果 |
| --- | --- | --- |
| `POST /api/pair` | 主机终端 mint 的一次性代码 | 普通设备 token |
| `POST /api/auth/login` | 固定访问密码 | 普通设备 token |
| `POST /api/auth/open` | `collie open` mint 的短期单次引导 | 普通设备 token |

三条路径最终都写入同一个 `paired-devices.json`。密码和引导值都不进入 API bearer 校验。

## Goals / Non-Goals

**Goals:**

- 远端浏览器用固定密码登录一次，之后沿用已有设备 token（含 PWA 重开）。
- 本机运行 `collie open` 后无需手输验证码或设备名。
- verifier 不可读或损坏时 fail-closed，不把损坏数据当作“未配置”或写回覆盖。
- 所有新入口继续受 Host、Origin、peer 边界、限流和审计约束。
- 前端在 router/loader 启动前处理 fragment，React StrictMode 重复执行不重复兑换。

**Non-Goals:**

- 不做网页端密码初始化/修改，不提供 `disable auth`。
- 不把 local-secret 变成浏览器凭据，不让 localhost、UA 或任意 header 直接登录。
- 不改变 crew/standby 的凭据来源；crew 转发仍不带 `Authorization`。
- 不修改 SSH `BatchMode=yes` 或主机校验。

## Decisions

### 1. 密码是 bootstrap，设备 token 才是日常凭据

登录成功后仍然走 `enrolDevice`，签发 256-bit 随机 token，注册表只存 SHA-256。共享密码永不写入
`paired-devices.json`，也不作为 `Authorization` 值。这样撤销一台丢失设备不会影响其他设备，清除
密码也不会吊销已登录设备。

被否决：把密码 hash 当作 bearer；为密码登录单设一张“全局会话”表。前者无法逐设备撤销，后者会
产生第二套与 ADR 0086 冲突的授权来源。

### 2. CLI 独占密码写入口，verifier 严格白名单

`<stateDir>/access-password.json` 只由 `collie password set/clear` 写入。格式：

```json
{
  "version": 1,
  "kdf": "scrypt",
  "salt": "<base64url>",
  "n": 32768,
  "r": 8,
  "p": 1,
  "keyLen": 32,
  "verifier": "<base64url>"
}
```

解析只接受这一组参数和长度；任何未知版本、算法、参数或字段长度都作为“不可用”，不是“未配置”。
scrypt 使用异步实现、随机 16-byte salt，比较用 `timingSafeEqual`。密码最少 12 个字符、最多 256
个字符且 UTF-8 不超过 1024 字节。文件 0600、目录 0700、临时文件 + rename 原子落盘。

`set` 在已有文件损坏时拒绝覆盖并提示操作者检查；`clear` 是显式破坏性操作，可删除损坏文件。
不输出密码、hash 或 salt。

### 3. 传输条件：HTTPS 前门或严格 loopback HTTP

密码登录和 `collie open` 兑换都必须通过 `checkAccess`，并额外满足：

- **严格 loopback HTTP**：TCP peer 是 loopback、Host 是 loopback、没有 proxy marker。
- **HTTPS 前门**：TCP peer 是 loopback（说明连接来自本机前门而不是远端直连），`x-forwarded-proto`
  的所有非空项都是 `https`，并且请求带 proxy marker。`collie` 监听在 loopback 时，远端主机
  无法伪造这个组合；直接连到非 loopback bind 的客户端 peer 不是 loopback，会被拒绝。
- 两者都要求浏览器 same-origin `Origin`（缺失即拒绝），并先通过 Host 允许列表与可选
  Tailscale 身份检查。

不从 `arrivedOverHttps()` 复用“任意 `X-Forwarded-Proto: https` 即放行”的判断；那只是 HSTS 的
提示，不是信任依据。

### 4. 限流、KDF 并发与统一失败文案

`/api/auth/login` 与 `/api/auth/open` 复用 `bridge/pair-limit.ts` 的 per-source 滑动窗口（10 次/
分钟），源地址规则与 `/api/pair` 相同。scrypt 另有一个进程级并发上限（2）和有限等待队列；队列
满时返回 503，不无限堆积内存。

错误密码统一返回 `401 password incorrect`，不回显 payload、不区分“密码不存在”和“密码错误”的
时序细节；verifier 损坏返回 `503 password unavailable`；未配置返回 `403 password not configured`。
响应带 `cache-control: no-store`。

### 5. 重名与过期替换

- 密码登录必须带设备名，长度和字符规则复用 `normalizeLabel`。
- 活动设备重名返回 `409 duplicate-label`，不替换、不覆盖；客户端提示换名。
- 仅在原设备已过期时允许同名替换，并复用 `enrolDevice` 的同一次写入、`device.revoke` 审计和
  `forgetDevice` launcher 清理。
- 设备总数上限 `MAX_PAIRED_DEVICES`（64）；达到上限返回 `409 device-limit`。

### 6. `collie open` 使用独立引导文件

`<stateDir>/open-pending.json` 保存 256-bit 引导值的 SHA-256、过期时间和可选消耗标记；TTL 2 分钟。
兑换时先检查，再在**创建任何设备之前删除该文件**，删除成功才继续登记。删除即持久消费：崩溃、登记
被拒或进程重启都只能看到一个不存在的文件，同一引导值不可能再兑换第二个设备。删除失败则整个兑换
失败（fail-closed），不返回 token；登记失败时用户必须重新运行 `collie open`，这比可重放安全。
进程内另有一张有界、带 TTL 的已消费哈希表，作为文件删除成功但文件仍意外存在时的第二道防线。
它不与 `pairing-pending.json` 混用，避免 `collie pair` 与 `collie open` 互相覆盖，
也让“单次、短期、无手输”的语义独立可测。

`collie open` 只打开 `http://127.0.0.1:<port><basePath>#collie-open=<token>`。端口、basePath 和
实例来自 `CliContext`；不打开 tailnet 名称，不打印 URL。平台 opener 通过注入 seam 调用
（macOS `open`、Linux `xdg-open`、Windows `rundll32.exe url.dll,FileProtocolHandler`，从不用
`cmd /c start`，因为 URL 里的 `&`/`%` 会被 shell 解释）。opener 的异步 `error`/非零 `exit` 必须
让命令失败，不能吞掉后仍宣称“已打开”。

### 7. 前端在路由启动前完成 fragment 处理

`web/src/main.tsx` 在 `./App` 之前导入 `lib/open-boot.ts`。该模块同步：

1. 读取 `location.hash`，只识别精确的 `#collie-open=<43 字符 base64url>`；
2. 立即用 `history.replaceState` 清掉 fragment，不新增历史、不写日志、不持久化；
3. 保存引导值到模块内存，导出一个只执行一次的 boot promise。

`main.tsx` 在 `createRoot().render()` 前 `await settleOpenBoot()`。boot promise：

- 若已有设备 token，先向 `/api/devices` 验证；验证成功则丢弃引导，不创建新设备；
- 没有有效 token 才调用 `/api/auth/open`；
- 成功后 `setDeviceToken`；失败只保存稳定 reason code 供登录页提示，不记录引导值。

模块级 `started` promise 保证 StrictMode 双执行或 HMR 不会重复兑换；成功后 token 已存在，第二次
自然跳过。

### 8. 未登录 UI

`RootLayout` 在桥确认本设备未配对（`refused`）且当前数据不是离线缓存时渲染全屏登录页
（`web/src/components/access-sign-in.tsx`）：

- 先请求一次 `GET /api/auth/status`；
- `configured: true` 时显示设备名 + 密码表单（`autocomplete="username"` /
  `current-password`），提交成功写 token 并 revalidate；
- `configured: false` 时提示在主机运行 `collie password set`，并提供“改用配对码”入口，复用现有
  `PairForm`；
- 状态请求失败时显示可重试的连接提示，不把网络故障当成“未配置”。

`collie open` 兑换失败（引导过期、已使用、label 上限等）在同一页面显示一句可操作的提示。

## Risks / Trade-offs

- **loopback 残余风险**：本机进程或 plain TCP relay 可以把远端请求带到 loopback，从而满足“严格
  loopback”。这与 ADR 0086 对 local-secret 的残余一致；密码仍是必要证明，且不提供免密登录。
- **共享密码无法区分人**：登录后的设备名是操作者输入的标签，不是身份。审计记录标签，不记录人。
- **KDF 成本**：每次登录约 32 MiB 内存、几十毫秒；并发上限保护主机，但极端情况下会返回 503。
- **已登录设备在改密后继续有效**：这是有意选择，避免改密导致全员掉线；需要时逐设备 revoke。

## Migration

- 旧版本没有 `access-password.json`，读取为“未配置”，不影响现有配对与 token。
- 旧前端不认识 `#collie-open=`，会把它当普通 fragment；升级后由新前端处理。服务端路由新增，
  旧前端不会调用。
- 不改 `paired-devices.json` 格式；新增设备仍按原格式写入。
