<div align="center">

# YOME CLI

### The Empower Kernel

*Agentic context. Agentic native skills. Agentic Bash kernel.*
*让 AI 真正感知你、连接你、为你交付。*

</div>

---

Yome CLI 不是又一个 chat agent。它是 **Yome 的开源底盘** —— 把 LLM、你的本地设备、本地 app 编织成一台运行环境的 **Empower Kernel**。

> Yome CLI is not yet another chat agent. It is the open-source substrate of Yome — an **Empower Kernel** that weaves the LLM, your devices and your native apps into one runtime.

模型已经很强了。它住在你 12 个 context 之外的某处。今天你是 context 与 tool 之间的 router；80% 的工作日花在搬运而不是创造。Yome CLI 的存在是为了把这层路由职责从你手里拿走 —— 不是再造一个工具,而是让你已有的工具醒来。

> The model is strong. It lives nowhere near your twelve context silos. Today you are the router between context and tool; 80% of your workday is spent shuffling, not creating. Yome CLI exists to take that routing job away from you — not by inventing one more tool, but by waking up the tools you already own.

---

## Quickstart · 60s 上手

```bash
# Install
npm install -g @poping/yome

# Configure (saved to ~/.yome/config.json)
yome --key sk-... --base-url https://your.endpoint --model your-model

# Run
yome                              # interactive REPL
yome "summarise package.json"     # one-shot

# Install your first native skill (PowerPoint editor)
yome skill install github:Whopus/yome-skill-ppt
yome skill list
```

第一条 `yome` 命令跑起来后,再敲一次:

```
> 帮我新建一个 ppt,标题 "Q3 Review",保存到桌面
```

模型会自己用 Bash 调 `ppt new ~/Desktop/q3.pptx` → `ppt title 1 --text="Q3 Review"` → `ppt save`,Microsoft PowerPoint 在你桌面打开,文件落地。这就是 Empower Kernel 的最小闭环。

> Type a Chinese / English request and watch the model issue real `ppt …` Bash commands. PowerPoint opens on your desktop, files land on disk. That is the minimum loop of an Empower Kernel.

---

## The Three Engines · 三大引擎

Yome CLI 由三个相互独立、又彼此咬合的引擎组成。每一个都是 Yome BP 中 "Agentic Empower Intelligence" 蓝图里的一块 ground truth。

> Yome CLI is composed of three engines, each independent yet interlocking. Each is a piece of ground truth from the "Agentic Empower Intelligence" blueprint in the Yome business plan.

---

### 1. Agentic Contextual Engine · 主动式上下文引擎

**Thesis** — Context 不是一段静态字符串,而是一条 *living continuum*。Agent loop 不能只活在用户敲下 Enter 的那 30 秒;它应当 always-on, never-forget, ambient。

> Context is not a static string. It is a *living continuum*. The agent loop must not live only in the 30 seconds after you press Enter; it should be always-on, never-forget, ambient.

差异化方向 — 这是 Yome CLI 与传统 chat-style coding agent 的根本分野:

> What sets it apart from traditional chat-style coding agents:

| 能力 / Capability | 含义 / Meaning |
|---|---|
| **Daemon · 守护进程** | Agent 长驻后台,跨会话保持状态,不再"开个窗口才会思考" |
| **Live compaction · 即时压缩** | 长会话自动压缩历史,token 永远不爆,记忆永远不丢 |
| **Custom missions · 定制任务** | 把"每周一上午整理周报"这种重复任务沉淀成可复用 mission |
| **Async agent · 异步 agent** | 后台跑长任务,完成后主动 push 通知,而不是阻塞你的 prompt |

**当前可用 / Available today**:

```bash
yome thread list                         # list past sessions in cwd
yome thread share <session-id> --skill=<slug>   # build redacted case bundle
yome thread submit <bundle-dir> --skill=<slug>  # publish as PR (needs gh CLI)
```

会话 / 历史压缩 / case bundle 这三件已落地。Daemon、custom missions、async agent 是 next-up,在 `next` 分支推进。

> Sessions, history compaction and case bundles ship today. Daemon, custom missions and async agent are next-up on the `next` branch.

---

### 2. Agentic Native Skill · 原生应用赋能

**Thesis** — 真正稀缺的能力不是"另一个 prompt 模板",也不是"远端跑的 MCP wrapper"。是**调起你机器上已经装好的那些 native app**,让它们听懂 agent 的指令。

> The scarce capability is not "yet another prompt template" or "an MCP wrapper running in the cloud". It is **invoking the native apps already installed on your machine** and making them obey agent instructions.

我们把这种 skill 叫 **Native Skill**:

> We call them **Native Skills**:

| 类型 / Type | 跑在哪 / Runs where | 干什么 / Does what | 例子 / Example |
|---|---|---|---|
| **Prompt Skill** | LLM context window | 加载一段 markdown 提示模板 | code-review, web-research |
| **MCP Server** | 远端服务器 | 暴露 JSON-RPC tool 给 LLM | github MCP, filesystem MCP |
| **Native Skill** *(Yome)* | 你本机 (macOS / Win / Linux) | 通过 AppleScript / Win32 / DBus 调起原生 app | ppt, xl, cal, mail, rem |

一个 Native Skill 是一个 git repo,目录长这样:

> A Native Skill is a git repo with this layout:

```
yome-skill-ppt/
├── yome-skill.json              # manifest: slug, domain, l1 doc, capabilities
├── SIGNATURE.md                 # L2 doc — author-tuned signature for the LLM
├── docs/                        # L3 doc — cookbook templates / themes
│   ├── blue-white.md
│   ├── black-gold.md
│   └── academic.md
└── backends/
    └── macos/
        ├── manifest.json        # action → AppleScript file mapping
        ├── new.applescript
        ├── title.applescript
        ├── addtext.applescript
        └── …
```

安装:

```bash
yome skill install github:Whopus/yome-skill-ppt
yome skill perms @yome/ppt                      # view granted capabilities
yome skill perms @yome/ppt --revoke=fs:write    # revoke one
yome skill validate                             # lint the cwd skill
yome skill publish                              # publish to hub (after `yome login`)
```

**Capability 模型 / Capability model** — 每个 skill 必须在 manifest 里声明它需要的 OS 资源,用户在安装时显式 grant。这不是 prompt 里的"请求权限",是真正的 sandbox gate:

> Each skill must declare the OS resources it needs in its manifest, and the user must grant them explicitly at install time. This is not "asking for permission" in a prompt — it is a real sandbox gate:

| Capability | 含义 |
|---|---|
| `applescript` | 可执行 AppleScript (macOS only) |
| `fs:read` / `fs:write` / `fs:delete` | 文件系统 |
| `network` | 出站网络 |
| `shell` | 任意 shell 命令 (危险,默认拒绝) |

未授权的能力一律返回 `capability not granted: …`,模型看到错误会主动让你 grant,而不是默默失败。

> Ungranted capabilities return `capability not granted: …`. The model sees the error and asks you to grant — never silently fails.

**当前能力清单 / Current native skills**:

| Skill | Domain | Status |
|---|---|---|
| `@yome/ppt` | `ppt` | **stable** — 16 actions, batch-ready, 4 themes (`--doc`) |
| `@yome/xl` | `xl` | beta |
| `@yome/cal` | `cal` | beta |
| `@yome/rem` | `rem` | beta |
| `@yome/mail` | `mail` | alpha |

---

### 3. Agentic Bash Kernel · 智能 Bash 内核

**Thesis** — Bash 即接口,skill 即 verb。**用户在 shell 里怎么用,模型在 Bash tool 里就怎么用**。一套语法,两个用户。

> Bash is the interface. A skill is a verb. **However a user types it in a shell, the model invokes it the same way through its Bash tool.** One syntax. Two users.

这意味着模型不需要学习新工具:

> The model does not have to learn a new tool:

```jsonc
// What the model sees in its tools list — just one Bash:
{ "name": "Bash", "description": "Run a shell command." }

// What the model emits when it wants to add a slide:
Bash({ "command": "ppt slide.add" })

// The kernel intercepts BEFORE /bin/sh sees it, routes to the
// installed @yome/ppt skill, runs the AppleScript, returns the result.
```

#### Three-layer skill docs · L1 / L2 / L3

模型选择和使用 skill 的全部信息分布在三层。每一层都为 token / latency 优化:

> All the information the model needs to pick and use a skill lives in three layers, each optimised for tokens / latency:

| Layer | 在哪 / Where | 给谁看 / Who reads it | 长度 / Size |
|---|---|---|---|
| **L1 — Index** | system prompt 永驻 / lives in the system prompt | 模型每次对话 | 3 行 / 60 tokens per skill |
| **L2 — Signature** | `<domain> --help` 按需 | 模型决定要用之后 | ~50 行 / 250 tokens |
| **L3 — Cookbook** | `<domain> --doc [name]` 教程 | 复杂任务时主动查阅 | KB 级 markdown |

**L1 看起来是这样** (system prompt 里 ppt skill 的真实块):

> **L1 looks like this** (the actual block for the `ppt` skill in the system prompt):

```
ppt | when:    user wants to create / edit / export PowerPoint .pptx slides
    | effects: opens Microsoft PowerPoint, writes files (first save to ~/Desktop may show OS dialog)
    | start:   ppt --help
```

只有三个字段,因为 LLM 选 tool 时也只在乎这三件事:**何时该用 / 副作用是什么 / 第一步敲什么**。Skill 作者在 `yome-skill.json` 里写:

> Just three fields, because that is all the LLM needs when picking a tool: **when to fire, what side effects, what to type first**. Authored by the skill maintainer in `yome-skill.json`:

```jsonc
"l1": {
  "when":    "user wants to create / edit / export PowerPoint .pptx slides",
  "entry":   "ppt --help",
  "effects": "opens Microsoft PowerPoint, writes files"
}
```

**L2 (`ppt --help`)** 是手写的 `SIGNATURE.md` —— 一行一 action,默认值内联,LLM 一眼扫完知道全部 args:

> **L2 (`ppt --help`)** is the hand-written `SIGNATURE.md` — one action per line, defaults inlined; the LLM can grok every arg in one read:

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

> **L3 (`ppt --doc`)** lists cookbook templates; `ppt --doc blue-white` returns the full body (palette, type scale, batch example). The skill maintainer authors them under `docs/*.md` with frontmatter:

```yaml
---
name: blue-white
label: 蓝白风格 / Blue & White
summary: 商务深蓝主色 + 白底,适合季度回顾、产品发布、销售汇报
tags: [theme, business]
---
```

**Three-tier fallback** — 旧 skill 没写 `l1` / `SIGNATURE.md` / `docs/` 也不会坏:

> **Three-tier fallback** — old skills without `l1` / `SIGNATURE.md` / `docs/` still work:

| Missing | Falls back to |
|---|---|
| `l1` | `prompt_line` (legacy single-liner) |
| `prompt_line` | `<domain> — <description>` |
| `SIGNATURE.md` | auto-generated from `backends/macos/manifest.json` args |
| `docs/` | "no templates available" |

#### Batch mode · 10x 提速

序列任务在 cli 里是头号性能杀手 —— 每个 AppleScript 调用 200ms cold-start。Yome Bash kernel 内置 batch verb,把 N 步合成一次调用,带 `--merge` 把 N 个 AppleScript 文件合成一个 `osascript` 进程:

> Sequential tasks are the #1 performance killer in a CLI agent — each AppleScript invocation has a 200 ms cold-start. The Yome Bash kernel has a built-in `batch` verb that fuses N steps into one call, and `--merge` further fuses N scripts into a single `osascript` process:

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

实测数字 / Measured numbers (8 sequential `ppt` actions, M1 Mac):

| Mode | Wall time | Speedup |
|---|---|---|
| 8 separate `ppt …` calls | 2041 ms | 1× |
| `ppt batch <<EOF…EOF` (sequential) | 2353 ms | 1× (parsing overhead) |
| `ppt batch --merge <<EOF…EOF` | **334 ms** | **6.1×** ⚡ |

加 `--keep-going` 失败不中断 (默认 fail-fast):

> Add `--keep-going` to continue past failures (default is fail-fast):

```bash
ppt batch --keep-going --merge <<EOF
…
EOF
```

#### One syntax, two users

| 用户在 shell 里 / In a shell | 模型在 Bash tool 里 / In the model's Bash tool |
|---|---|
| `ppt --help` | `Bash({"command": "ppt --help"})` |
| `ppt new ~/Desktop/x.pptx` | `Bash({"command": "ppt new ~/Desktop/x.pptx"})` |
| `ppt slides \| head -3` (pipes to /bin/sh) | `Bash({"command": "ppt slides \| head -3"})` |
| `ppt batch <<EOF\n…\nEOF` | same heredoc, same kernel intercept |

Kernel 在 token 级别决定:第一个 token 是不是 reserved system command (47 个: `git`, `ls`, `cd`, `rm`, `node`…)?是 → 直接放给 `/bin/sh`。否则 → 是不是某个已安装 skill 的 domain?是 → 路由到 skill。否 → 透传给 shell。

> The kernel decides at the token level: is the first token a reserved system command (47 of them: `git`, `ls`, `cd`, `rm`, `node`, …)? Yes → straight to `/bin/sh`. Else → is it the domain of an installed skill? Yes → route to the skill. No → pass through to shell.

因此 *同一个 Bash tool* 同时承载了:

> So *one Bash tool* simultaneously carries:

- 真 shell 命令 (`ls`, `git status`, `python script.py`)
- skill verb (`ppt new`, `cal create`)
- shell 复合 (`ppt slides | head -3` — domain 命令的 stdout 喂给真 shell)
- 批量 (`ppt batch --merge <<EOF…EOF`)

不需要再发明 `SkillCall` 工具,不需要为 skill 训模型,不需要 prompt engineering 教模型新语法。**Bash 就是接口**。

> No need to invent a `SkillCall` tool. No need to train the model on skills. No need to teach the model new syntax via prompt engineering. **Bash is the interface.**

---

## Skills Marketplace · Skill 市场

```bash
yome skill search powerpoint              # search public hub
yome skill install github:Whopus/yome-skill-ppt
yome skill install ./my-local-skill       # local dir
yome skill install github:owner/repo@v2   # pin to a ref
yome skill update                         # re-pull all installed
yome skill rollback @yome/ppt             # one-level undo
yome skill enable / disable / link / unlink / doctor
```

`yome skill publish` 会把当前目录 publish 到公共 hub (需要先 `yome login` 走 GitHub Device Flow)。Hub 是发现层,skill 真身依然是 git repo;没有 vendor lock-in。

> `yome skill publish` publishes the cwd to the public hub (requires `yome login` via GitHub Device Flow). The hub is just a discovery layer; skills themselves remain plain git repos. No vendor lock-in.

---

## Configuration · 配置

```bash
export YOME_API_KEY=sk-...
export YOME_BASE_URL=https://your.endpoint
export YOME_MODEL=claude-opus-4-6
export YOME_PROVIDER=anthropic     # or openai (auto-detected from base URL)
```

或一次性写入 `~/.yome/config.json`:

> Or persist once into `~/.yome/config.json`:

```bash
yome --key sk-... --base-url https://… --model …
```

| Variable | Description | Default |
|---|---|---|
| `YOME_API_KEY` | API key | — |
| `YOME_BASE_URL` | API base URL | `https://zenmux.ai/api` |
| `YOME_MODEL` | Model name | — |
| `YOME_PROVIDER` | `anthropic` \| `openai` | auto-detected |

**Storage layout**:

```
~/.yome/
├── config.json                   # API config
├── skills/                       # installed native skills
│   ├── .index.json               # cached registry
│   └── yome/
│       └── ppt/                  # the @yome/ppt skill, exactly the git repo
└── threads/                      # session history (per cwd)
```

---

## Philosophy · 哲学

> *用户不愿学习新产品,也不愿改变已有的行为模式。*
>
> *Users will not learn a new product. Users will not change the way they already work.*

我们不替代你的工具,而是在不打断现有流程的前提下进行**增强 (Empower)**。Mail、Chat、Docs、Calendar、Files、Web —— 它们已经在你机器上,我们只是给它们装一层 living context 让它们苏醒。

> We do not replace your tools. We **empower (增强)** them without interrupting the way you already work. Mail, Chat, Docs, Calendar, Files, Web — they already live on your machine. We just bolt on a living-context layer and wake them up.

| Before | After |
|---|---|
| Passive Tool · 被动工具 | Proactive Agent · 主动 Agent |
| You route context → tool | Yome reaches into every device for you |
| 12 contexts, 0 AI | 1 buddy that knows everything about you |

---

## Project Status · 项目状态

| Area | Status |
|---|---|
| Bash kernel (tokenizer + dispatcher + permission gate) | **stable** |
| Native skill format (yome-skill.json + L1/L2/L3 docs) | **stable** |
| `@yome/ppt` (16 actions, batch + 4 themes) | **stable** |
| Skill hub (search / install / publish) | **stable** |
| Capability model (sandbox grants) | **stable** |
| Thread history + case bundles | **stable** |
| Live history compaction | beta |
| Daemon (always-on agent) | experimental, on `next` branch |
| Custom missions (recurring tasks) | next-up |
| Async agent (background long-running) | next-up |

---

## License

MIT. Skills are author-owned git repos under their own licenses.

---

<div align="center">

**YOME — Your Universal AI Work Buddy.**
*Know everything. Run everywhere. Empower everyone.*

</div>
