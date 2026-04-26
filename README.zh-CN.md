<div align="center">

<img src=".assets/yome-icon.png" width="120" alt="Yome" />

# YOME AGENT

### Empower Kernel · 赋能内核

*主动式上下文 · 原生应用赋能 · 智能 Bash 内核*
*让 AI 真正感知你、连接你、为你交付的开源底座。*

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

Yome Agent 不是又一个 chat agent。它是 [Yome](https://yome.work) 的开源底盘 —— 一台把 LLM、你的设备、你机器上的原生 app 编织成统一运行环境的 **Empower Kernel**。

模型已经很强了。它住在你 12 个 context 之外的某处。今天你是 context 与 tool 之间的 router; 80% 的工作日花在搬运而不是创造。Yome Agent 的存在是为了把这层路由职责从你手里拿走 —— 不是再造一个工具,而是让你已有的工具醒来。

---

## 60 秒上手

```bash
# 安装
npm install -g @poping/yome

# 配置 (写入 ~/.yome/config.json)
yome --key sk-... --base-url https://your.endpoint --model your-model

# 运行
yome                              # 交互式 REPL
yome "总结一下 package.json"       # 一次性

# 安装第一个原生 skill (PowerPoint 编辑器)
yome skill install github:Whopus/yome-skill-ppt
yome skill list
```

`yome` 跑起来后,试一下:

```
> 帮我新建一个 ppt,标题 "Q3 Review",保存到桌面
```

模型会自己用 Bash 调 `ppt new ~/Desktop/q3.pptx` → `ppt title 1 --text="Q3 Review"` → `ppt save`。Microsoft PowerPoint 在你桌面打开,文件落地。这就是 Empower Kernel 的最小闭环。

---

## 三大引擎

Yome Agent 由三个相互独立、又彼此咬合的引擎组成。每一个都是 Yome 商业蓝图中 *Agentic Empower Intelligence* 的一块 ground truth。

---

### 1. Agentic Contextual Engine · 主动式上下文引擎

> Context 不是一段静态字符串,而是一条 *living continuum*。

Agent loop 不能只活在用户敲下 Enter 的那 30 秒;它应当 always-on, never-forget, ambient。这是 Yome Agent 与传统 chat-style coding agent 的根本分野。

| 能力 | 含义 |
|---|---|
| **Daemon · 守护进程** | Agent 长驻后台,跨会话保持状态,不再"开个窗口才会思考" |
| **Live compaction · 即时压缩** | 长会话自动压缩历史,token 永远不爆,记忆永远不丢 |
| **Custom missions · 定制任务** | 把"每周一上午整理周报"这种重复任务沉淀成可复用 mission |
| **Async agent · 异步 agent** | 后台跑长任务,完成后主动 push 通知,而不是阻塞你的 prompt |

**当前可用:**

```bash
yome thread list                                # 列出当前 cwd 的历史会话
yome thread share <session-id> --skill=<slug>   # 构建脱敏的 case bundle
yome thread submit <bundle-dir> --skill=<slug>  # 作为 PR 发布 (需要 gh CLI)
```

会话 / 历史压缩 / case bundle 这三件已落地。Daemon、custom missions、async agent 在 `next` 分支推进。

---

### 2. Agentic Native Skill · 原生应用赋能

> 真正稀缺的能力不是"另一个 prompt 模板",也不是"远端跑的 MCP wrapper"。是**调起你机器上已经装好的那些原生 app**,让它们听懂 agent 的指令。

我们把这种 skill 叫 **Native Skill**:

| 类型 | 跑在哪 | 干什么 | 例子 |
|---|---|---|---|
| **Prompt Skill** | LLM context window | 加载一段 markdown 提示模板 | code-review, web-research |
| **MCP Server** | 远端进程 | 暴露 JSON-RPC tool 给 LLM | github MCP, filesystem MCP |
| **Native Skill** *(Yome)* | 你本机 (macOS / Win / Linux) | 通过 AppleScript / Win32 / DBus 驱动原生 app | ppt, xl, cal, mail, rem |

**安装 / 管理:**

```bash
yome skill install github:Whopus/yome-skill-ppt
yome skill perms @yome/ppt                      # 查看授予的 capability
yome skill perms @yome/ppt --revoke=fs:write    # 撤销某项
yome skill validate                             # 校验当前目录的 skill
yome skill publish                              # 发布到 hub (需要 `yome login`)
```

**Capability 模型。** 每个 skill 必须在 manifest 里声明它需要的 OS 资源,用户在安装时显式 grant。这不是 prompt 里的"请求权限",是真正的 sandbox gate:

| Capability | 含义 |
|---|---|
| `applescript` | 可执行 AppleScript (仅 macOS) |
| `fs:read` / `fs:write` / `fs:delete` | 文件系统访问,作用域受限 |
| `network` | 出站网络 |
| `shell` | 任意 shell 命令 (危险,默认拒绝) |

未授权的能力一律返回 `capability not granted: …`,模型看到错误会主动让你 grant,而不是默默失败。

**当前 Native Skills:**

| Skill | Domain | 状态 |
|---|---|---|
| `@yome/ppt` | `ppt` | **stable** — 16 个 action,batch-ready,4 套主题 (`--doc`) |
| `@yome/xl` | `xl` | beta |
| `@yome/cal` | `cal` | beta |
| `@yome/rem` | `rem` | beta |
| `@yome/mail` | `mail` | alpha |

---

### 3. Agentic Bash Kernel · 智能 Bash 内核

> Bash 即接口,skill 即 verb。**用户在 shell 里怎么用,模型在 Bash tool 里就怎么用。** 一套语法,两个用户。

模型不需要学习新工具:

```jsonc
// 模型工具列表里只有一个 Bash:
{ "name": "Bash", "description": "Run a shell command." }

// 模型想加一张幻灯片时这样发:
Bash({ "command": "ppt slide.add" })

// kernel 在 /bin/sh 看到之前就拦截,路由到已安装的
// @yome/ppt skill, 跑 AppleScript, 返回结果。
```

#### Skill 三层文档 · L1 / L2 / L3

模型选择和使用 skill 的全部信息分布在三层。每一层都为 token / latency 优化:

| Layer | 在哪 | 给谁看 | 长度 |
|---|---|---|---|
| **L1 — Index** | system prompt 永驻 | 模型每次对话都看 | 3 行 / ~60 tokens per skill |
| **L2 — Signature** | `<domain> --help` 按需返回 | 模型决定要用之后 | ~50 行 / ~250 tokens |
| **L3 — Cookbook** | `<domain> --doc [name]` 按需返回 | 复杂任务时主动查阅 | KB 级 markdown |

**L1 看起来是这样** (system prompt 里 ppt skill 的真实块):

```
ppt | when:    user wants to create / edit / export PowerPoint .pptx slides
    | effects: opens Microsoft PowerPoint, writes files (first save to ~/Desktop may show OS dialog)
    | start:   ppt --help
```

只有三个字段,因为 LLM 选 tool 时也只在乎这三件事:**何时该用 / 副作用是什么 / 第一步敲什么**。Skill 作者在 `yome-skill.json` 里写:

```jsonc
"l1": {
  "when":    "user wants to create / edit / export PowerPoint .pptx slides",
  "entry":   "ppt --help",
  "effects": "opens Microsoft PowerPoint, writes files"
}
```

**L2 (`ppt --help`)** 是手写的 `SIGNATURE.md` —— 一行一 action,默认值内联,LLM 一眼扫完知道全部 args:

```
ppt new [path] [--force]                       create blank presentation
ppt open <path>                                open existing .pptx
ppt save [--path=P] [--force]                  save (or save-as)
ppt slides                                     TSV: index, title, shape count
ppt slide.add [--index=N] [--layout=N]
ppt title <slide> --text=<str>
ppt addtext <slide> --text=<str>
                       [--left=100 --top=200 --width=400 --height=50]
                       [--size=N --bold --italic]
                       [--color=red|#RRGGBB|R,G,B]
                       [--align=left|center|right]
ppt fmt <slide> --shape=<n> [--size=N --bold --italic --color --bg --align]
ppt export --format=pdf|png|jpg --path=<file> [--force]
…
```

**L3 (`ppt --doc`)** 列出 cookbook 模板; `ppt --doc blue-white` 返回完整模板内容(配色、字号、batch 例子)。Skill 作者在 `docs/*.md` 里用 frontmatter 声明:

```yaml
---
name: blue-white
label: 蓝白风格
summary: 商务深蓝主色 + 白底,适合季度回顾、产品发布、销售汇报
tags: [theme, business]
---
```

#### Batch mode · 6 倍提速

序列任务在 cli agent 里是头号性能杀手 —— 每个 AppleScript 调用 200ms cold-start。Yome Bash kernel 内置 `batch` verb 把 N 步合成一次调用; `--merge` 进一步把 N 个 AppleScript 合成一个 `osascript` 进程:

```bash
ppt batch --merge <<EOF
new ~/Desktop/q3.pptx
title 1 --text="Q3 Review"
slide.add
title 2 --text="Revenue"
addtext 2 --text="+18% YoY" --size=72 --bold --color=green --align=center
slide.add
title 3 --text="Conclusion"
save
export --format=pdf --path=~/Desktop/q3.pdf
EOF
```

实测数字 —— 8 个连续 `ppt` action,M1 Mac:

| 模式 | Wall time | 提速 |
|---|---|---|
| 8 次独立 `ppt …` 调用 | 2041 ms | 1× |
| `ppt batch <<EOF…EOF` (顺序执行) | 2353 ms | 1× (含解析开销) |
| `ppt batch --merge <<EOF…EOF` | **334 ms** | **6.1×** |

Kernel 在 token 级别决定:第一个 token 是不是 reserved system command (47 个: `git`, `ls`, `cd`, `rm`, `node`…) ?是 → 直接放给 `/bin/sh`。否则 → 是不是某个已安装 skill 的 domain ?是 → 路由到 skill。否 → 透传给 shell。

因此 *同一个 Bash tool* 同时承载了:

- 真 shell 命令 (`ls`, `git status`, `python script.py`)
- skill verb (`ppt new`, `cal create`)
- shell 复合 (`ppt slides | head -3` —— domain 命令的 stdout 喂给真 shell)
- 批量 (`ppt batch --merge <<EOF…EOF`)

---

## Skills Marketplace · Skill 市场

```bash
yome skill search powerpoint              # 搜索公共 hub
yome skill install github:Whopus/yome-skill-ppt
yome skill install ./my-local-skill       # 本地目录
yome skill install github:owner/repo@v2   # 锁定到某 ref
yome skill update                         # 重新拉取所有已装 skill
yome skill rollback @yome/ppt             # 一级撤销
yome skill enable / disable / link / unlink / doctor
```

`yome skill publish` 把当前目录发布到公共 hub (需先 `yome login` 走 GitHub Device Flow)。Hub 只是发现层,skill 真身依然是 git repo —— 没有 vendor lock-in。

---

## 配置

```bash
export YOME_API_KEY=sk-...
export YOME_BASE_URL=https://your.endpoint
export YOME_MODEL=claude-opus-4-6
export YOME_PROVIDER=anthropic     # 或 openai (会从 base URL 自动检测)
```

或一次性写入 `~/.yome/config.json`:

```bash
yome --key sk-... --base-url https://… --model …
```

**存储布局:**

```
~/.yome/
├── config.json                   # API 配置
├── skills/                       # 已安装的 native skill
│   ├── .index.json               # 缓存的注册表
│   └── yome/
│       └── ppt/                  # @yome/ppt skill, 就是 git repo 本体
└── threads/                      # 会话历史 (按 cwd 分目录)
```

---

## 哲学

> *用户不愿学习新产品,也不愿改变已有的行为模式。*

我们不替代你的工具,而是在不打断现有流程的前提下进行**赋能 (Empower)**。Mail、Chat、Docs、Calendar、Files、Web —— 它们已经在你机器上,我们只是给它们装一层 living context 让它们苏醒。

| Before | After |
|---|---|
| Passive Tool · 被动工具 | Proactive Agent · 主动 Agent |
| You route context → tool | Yome 替你伸进每一台设备 |
| 12 contexts, 0 AI | 1 个 buddy,知道关于你的一切 |

---

## 项目状态

| 模块 | 状态 |
|---|---|
| Bash kernel (tokenizer + dispatcher + permission gate) | **stable** |
| Native skill 格式 (yome-skill.json + L1/L2/L3 docs) | **stable** |
| `@yome/ppt` (16 actions, batch + 4 themes) | **stable** |
| Skill hub (search / install / publish) | **stable** |
| Capability model (sandbox grants) | **stable** |
| Thread 历史 + case bundles | **stable** |
| Live history compaction | beta |
| **Daemon (always-on agent)** | experimental, 在 `next` 分支 |
| &nbsp;&nbsp;└─ 系统消息拦截 (微信 / 飞书 / Slack / WhatsApp / iMessage) — 实时捕获,过滤垃圾,主动协助回复,不漏任何重要消息 | scoped |
| &nbsp;&nbsp;└─ 日程 / Routine 自动化 (订阅博主、社交频道、每日 digest、提醒闹铃、日历联动) — 不用打开就会自己跑 | scoped |
| &nbsp;&nbsp;└─ 状态变化监听 (实验跑完、CPU / GPU 飙高、build 通过、有人 @你) — 在关键时刻推送,而不是事后汇总 | scoped |
| Custom missions (recurring tasks) | next-up |
| Async agent (后台长任务) | next-up |

---

## License

MIT。Skills 是作者拥有的 git repo,各自适用其自己的 license。

---

<div align="center">

**YOME — Your Universal AI Work Buddy.**
*Know everything. Run everywhere. Empower everyone.*

</div>
