# cli → Yome Mesh 迁移计划

> 起草: 2026-05-17
> 目标: 把 cli 从 "独立 standalone agent" 改造成 "Yome mesh 上的一台 Linux device"

## 设计依据
- 设计文档: `docs/architecture/yome-linux-mesh-v1.md`
- 架构选型: D (Cloud 是唯一大脑, cli 是 mesh 里的 device)
- 跟 macOS 端 (`Yome/Shared/Sync/`) 完全等价

## 分两个 Stage 执行

### Stage A: 加 mesh 能力, 不砍任何东西 (低风险, 当前 PR)
**结果**: 新增 `yome mesh start`, 让 cli 同时支持 standalone REPL 和 mesh device daemon 两种模式.
- iOS / macOS 通过 Cloud 能远程调这台 Linux server 跑 bash/git/docker 等命令.
- 现有 `yome` REPL 继续可用 (沿用本地 agent loop).
- **不删任何文件, 不改任何现有逻辑**.

### Stage B: 全面 thin client 化 (高风险, 后续 PR)
**结果**: cli REPL 也变成 mesh thin client, 三端体验完全镜像.
- 砍 `cli/src/{agent,llm,withRetry,loops}/`
- 改 `cli/src/ui/App.tsx`: 输入 → PartyKit message, 输出 ← PartyKit event stream
- 改 `cli/src/sessions.ts`: 本地 jsonl → Cloud thread cache

## Stage A 细节 (本次实施)

### 复用已有基建 (绝对不重复造轮子)

| 已有能力 | 在哪 | mesh 怎么复用 |
|---|---|---|
| `yome login` GitHub Device Flow → yome_token | `cli/src/yomeSkills/{login,auth}.ts` | mesh 直接读 `~/.yome/auth.json` 拿 `yome_token` |
| `bearerHeader()` 给 hub 调用加 Authorization | `cli/src/yomeSkills/auth.ts` | mesh 兑换 ticket 时直接用 |
| `~/.yome/` 目录 + 0600 perms 写法 | `cli/src/yomeSkills/auth.ts` | `~/.yome/device.json` 沿用相同模式 |
| Linux 工具实现 (bash/grep/glob/ls/read/write/edit) | `cli/src/tools/*.ts` | `mesh:cmd` 路由到这些 tool 复用其执行逻辑 |
| PartyKit room + verifyToken (HS256) | `Server/party/yome.ts` | **零改动**, ws ticket 是 Supabase JWT secret 签的 HS256 JWT |
| mesh:register / mesh:heartbeat / rpc:cal-request 协议 | `Server/agent/types.ts` + `Yome/Shared/Sync/PartyKitClient.swift` | cli 端 TS port 协议帧 |
| DeviceRegistrar 行为 (heartbeat 30s, reconnect backoff) | `Yome/Shared/Sync/DeviceRegistrar.swift` | cli 端 TS port |

### 认证设计: PAT + Mint Ticket (工业标准, GitHub/Vercel/Supabase CLI 同款)

```
cli 持有: yome_token (长效 opaque, 已有, 可吊销)
                  │
                  │ POST /api/cli/mesh/ws-ticket  Authorization: Bearer <yome_token>
                  │ body: { deviceId, hostname?, platform: 'linux' }
                  ▼
hub: 验 yome_token → 返回短期 JWT
     { ws_token: <HS256 by SUPABASE_JWT_SECRET, sub=user_id, aud='partykit', exp=now+300>,
       expires_in: 300,
       userId,
       deviceId }
                  │
                  ▼
cli WSS: wss://yome.party.yome.work/parties/main/<userId>
           ?type=desktop&userId=<userId>&deviceId=<deviceId>&token=<ws_token>
                  │
                  ▼
PartyKit: 现有 verifyToken HS256 分支直接验通过 ←── 零改动
```

为什么这个方案 (vs 让 cli 直接持有 Supabase session):
1. PartyKit 端零改动 (HS256 验签路径现成)
2. cli 不需要 Supabase SDK 依赖
3. ws_token 5min 过期, 即使泄露窗口短
4. yome logout 调 hub 标 token revoked, 已有连接 5min 内自动失效
5. 跟 iOS / macOS 传 Supabase session JWT 走的是同一个 jwtVerify 分支, 验证路径完全对齐

### 新增 (不冲突任何现有代码)

```
cli/src/mesh/
├── types.ts                # 协议帧 (mesh:register / mesh:heartbeat / rpc:cal-request / ...)
├── device-id.ts            # ~/.yome/device.json (UUID), 跟 auth.json 同级
├── ticket.ts               # POST /api/cli/mesh/ws-ticket (用 yome_token 换 ws_token)
├── partykit-client.ts      # WSS client, port from Yome/Shared/Sync/PartyKitClient.swift
├── capabilities.ts         # Linux device 的 capability 列表 (bash/git/docker/k8s/...)
├── device-registrar.ts     # 注册 + 心跳 + 重连 backoff, port from DeviceRegistrar.swift
├── rpc-handler.ts          # 监听 mesh:cmd 帧, dispatch 到 tools/, 流式返回
└── index.ts                # runMeshDaemon() 入口

cli/src/commands/
└── mesh.ts                 # `yome mesh start/status/stop/logs` 子命令实现

cli/src/daemon/
└── systemd.ts              # Linux systemd user unit (镜像 launchd.ts 接口)
```

### hub 端 (Yome.work) 新增

```
hub/app/api/cli/mesh/ws-ticket/route.ts
  POST  Authorization: Bearer <yome_token>
  body  { deviceId: string, hostname?: string, platform?: string }
  resp  { ws_token, expires_in, userId, deviceId, partykit_url }
```

(具体路径取决于 hub 现有 /api/cli/* 的组织方式, 实施时确认)

### 改动 (最小侵入)

| 文件 | 改动 |
|---|---|
| `cli/src/index.tsx` | 加 `yome mesh` 子命令路由 (在现有 skill/thread/daemon 路由旁边) |
| `cli/src/daemon/index.ts` | platform 派发: macOS 用 launchd, Linux 用 systemd |
| `cli/package.json` | 加 `ws` 依赖 (WSS client) |
| `cli/src/yomeSkills/cli.ts` | `runWhoami` 加一行显示当前 deviceId (可选) |

### 不改动 (零风险保证)

| 模块 | 状态 |
|---|---|
| `cli/src/agent.ts` | 保留, 用于 standalone REPL |
| `cli/src/loops/*` | 保留 |
| `cli/src/llm.ts` | 保留 |
| `cli/src/tools/{bash,edit,read,write,grep,glob,ls,todoWrite,askUser}.ts` | 保留, mesh:cmd 复用其实现 |
| `cli/src/permissions/*` | 保留, mesh:cmd 也走它 |
| `cli/src/ui/*` | 保留 |
| `cli/src/sessions.ts` | 保留 |
| `cli/src/skills/*` | 保留 |

## Stage A 验收
1. `yome` 命令仍能正常进 REPL (standalone 模式)
2. `yome mesh start --foreground` 能连上 Cloud PartyKit, 注册成 device
3. 用户在 macOS Yome App 打开 thread, 看到 Linux device 在 mesh 列表里 online
4. 用户在 iOS Yome App 说 "@srv-linux-01 bash df -h", LLM 路由到这台 Linux, 命令在 cli 端执行, 输出流回 iOS

## Stage B 待办 (本次不实施)
1. 设计三端会话同步细节 (cli 端的 thread 缓存策略 + 离线 / 增量)
2. cli/src/ui/App.tsx 改造: 输入路径变更
3. 砍 agent/llm/loops/withRetry
4. 移除 user 自填 API key, 改用 Yome account device_token
5. 文档同步更新 README
