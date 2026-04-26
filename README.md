<div align="center">

<img src=".assets/yome-icon.png" width="120" alt="Yome" />

# YOME AGENT

### The Empower Kernel

*Agentic context, native skills, bash kernel.*
*The open-source substrate that makes AI feel and know you.*

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

Yome Agent is not yet another chat agent. It is the open-source substrate of [Yome](https://yome.work) — an **Empower Kernel** that weaves the LLM, your devices and your native apps into one runtime.

The model is strong. It lives nowhere near your twelve context silos. Today you are the router between context and tool; 80% of your workday is spent shuffling, not creating. Yome Agent exists to take that routing job away from you — not by inventing one more tool, but by waking up the tools you already own.

---

## Quickstart

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

Once `yome` is running, type:

```
> Make a new ppt titled "Q3 Review" and save it to my Desktop
```

The model issues real `ppt new ~/Desktop/q3.pptx` → `ppt title 1 --text="Q3 Review"` → `ppt save` Bash commands. Microsoft PowerPoint opens on your desktop. The file lands on disk. That is the minimum loop of an Empower Kernel.

---

## The Three Engines

Yome Agent is composed of three engines, each independent yet interlocking. Each is a piece of ground truth from the *Agentic Empower Intelligence* blueprint in the Yome business plan.

---

### 1. Agentic Contextual Engine

> Context is not a static string. It is a *living continuum*.

The agent loop must not live only in the 30 seconds after you press Enter. It should be always-on, never-forget, ambient. This is the dimension that separates Yome Agent from traditional chat-style coding agents.

| Capability | Meaning |
|---|---|
| **Daemon** | Yome runs as an OS-level daemon, not a chat window. It watches your filesystem, calendar, IM signals, and long-running jobs in the background — and only surfaces when something matters. The agent loop never has to be re-spawned from scratch. |
| **Live compaction** | Long sessions auto-compress history; tokens never overflow, memory never lost |
| **Oncall** | The agent is event-driven, not prompt-driven. WeChat / Feishu / Slack / iMessage messages, calendar fires, build finishes, GPU spikes, *@you* mentions — Yome reacts to the world and pages you with a one-line summary + a draft response, instead of waiting for you to ask. |

**Available today:**

```bash
yome thread list                                # list past sessions in cwd
yome thread share <session-id> --skill=<slug>   # build redacted case bundle
yome thread submit <bundle-dir> --skill=<slug>  # publish as PR (needs gh CLI)
```

Sessions, history compaction and case bundles ship today. Daemon and Oncall are next-up on the `next` branch.

---

### 2. Agentic Native Skill

> The scarce capability is not "another prompt template" or "an MCP wrapper running in the cloud". It is **invoking the native apps already installed on your machine** and making them obey agent instructions.

We call them **Native Skills**:

| Type | Runs where | Does what | Example |
|---|---|---|---|
| **Prompt Skill** | LLM context window | Loads a markdown prompt template | code-review, web-research |
| **MCP Server** | Remote process | Exposes JSON-RPC tools to the LLM | github MCP, filesystem MCP |
| **Native Skill** *(Yome)* | Your own machine (macOS / Win / Linux) | Drives native apps via AppleScript / Win32 / DBus | ppt, xl, cal, mail, rem |

**Install / manage:**

```bash
yome skill install github:Whopus/yome-skill-ppt
yome skill perms @yome/ppt                      # view granted capabilities
yome skill perms @yome/ppt --revoke=fs:write    # revoke one
yome skill validate                             # lint the cwd skill
yome skill publish                              # publish to hub (after `yome login`)
```

**Capability model.** Every skill must declare the OS resources it needs in its manifest, and the user must grant them explicitly at install time. This is not "asking for permission" in a prompt — it is a real sandbox gate:

| Capability | Meaning |
|---|---|
| `applescript` | Execute AppleScript (macOS only) |
| `fs:read` / `fs:write` / `fs:delete` | Filesystem access, scope-limited |
| `network` | Outbound network |
| `shell` | Arbitrary shell commands (dangerous, denied by default) |

Ungranted capabilities return `capability not granted: …`. The model sees the error and asks you to grant — never silently fails.

**Native skills available today:**

| Skill | Domain | Status |
|---|---|---|
| `@yome/ppt` | `ppt` | **stable** — 16 actions, batch-ready, 4 themes (`--doc`) |
| `@yome/xl` | `xl` | beta |
| `@yome/cal` | `cal` | beta |
| `@yome/rem` | `rem` | beta |
| `@yome/mail` | `mail` | alpha |

---

### 3. Agentic Bash Kernel

> Bash is the interface. A skill is a verb. **However a user types it in a shell, the model invokes it the same way through its Bash tool.** One syntax. Two users.

The model does not have to learn a new tool:

```jsonc
// What the model sees in its tools list — just one Bash:
{ "name": "Bash", "description": "Run a shell command." }

// What the model emits when it wants to add a slide:
Bash({ "command": "ppt slide.add" })

// The kernel intercepts BEFORE /bin/sh sees it, routes to the
// installed @yome/ppt skill, runs the AppleScript, returns the result.
```

#### Three-layer skill docs · L1 / L2 / L3

All the information the model needs to pick and use a skill lives in three layers, each optimised for tokens / latency:

| Layer | Where | Who reads it | Size |
|---|---|---|---|
| **L1 — Index** | Lives in the system prompt | The model on every turn | 3 lines / ~60 tokens per skill |
| **L2 — Signature** | Returned by `<domain> --help` | The model once it decides to use the skill | ~50 lines / ~250 tokens |
| **L3 — Cookbook** | Returned by `<domain> --doc [name]` | The model when the task is non-trivial | KB of markdown |

**L1 looks like this** — the actual block for the `ppt` skill in the system prompt:

```
ppt | when:    user wants to create / edit / export PowerPoint .pptx slides
    | effects: opens Microsoft PowerPoint, writes files (first save to ~/Desktop may show OS dialog)
    | start:   ppt --help
```

Just three fields, because that is all the LLM needs when picking a tool: **when to fire, what side effects, what to type first**. Authored by the skill maintainer in `yome-skill.json`:

```jsonc
"l1": {
  "when":    "user wants to create / edit / export PowerPoint .pptx slides",
  "entry":   "ppt --help",
  "effects": "opens Microsoft PowerPoint, writes files"
}
```

**L2 (`ppt --help`)** is the hand-written `SIGNATURE.md` — one action per line, defaults inlined; the LLM can grok every arg in one read:

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

**L3 (`ppt --doc`)** lists cookbook templates; `ppt --doc blue-white` returns the full body (palette, type scale, batch example). The skill maintainer authors them under `docs/*.md` with frontmatter:

```yaml
---
name: blue-white
label: Blue & White
summary: Corporate navy on white — quarterly reviews, product launches, sales decks
tags: [theme, business]
---
```

#### Batch mode · 6× speedup

Sequential tasks are the #1 performance killer in a CLI agent — each AppleScript invocation has a 200 ms cold-start. The Yome Bash kernel has a built-in `batch` verb that fuses N steps into one call, and `--merge` further fuses N scripts into a single `osascript` process:

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

Measured numbers — 8 sequential `ppt` actions, M1 Mac:

| Mode | Wall time | Speedup |
|---|---|---|
| 8 separate `ppt …` calls | 2041 ms | 1× |
| `ppt batch <<EOF…EOF` (sequential) | 2353 ms | 1× (parsing overhead) |
| `ppt batch --merge <<EOF…EOF` | **334 ms** | **6.1×** |

The kernel decides at the token level: is the first token a reserved system command (47 of them: `git`, `ls`, `cd`, `rm`, `node`, …)? Yes → straight to `/bin/sh`. Else → is it the domain of an installed skill? Yes → route to the skill. No → pass through to shell.

So *one Bash tool* simultaneously carries:

- Real shell commands (`ls`, `git status`, `python script.py`)
- Skill verbs (`ppt new`, `cal create`)
- Shell composition (`ppt slides | head -3` — domain stdout piped to a real shell)
- Batches (`ppt batch --merge <<EOF…EOF`)

---

## Skills Marketplace

```bash
yome skill search powerpoint              # search public hub
yome skill install github:Whopus/yome-skill-ppt
yome skill install ./my-local-skill       # local dir
yome skill install github:owner/repo@v2   # pin to a ref
yome skill update                         # re-pull all installed
yome skill rollback @yome/ppt             # one-level undo
yome skill enable / disable / link / unlink / doctor
```

`yome skill publish` publishes the cwd to the public hub (requires `yome login` via GitHub Device Flow). The hub is just a discovery layer; skills themselves remain plain git repos. No vendor lock-in.

---

## Configuration

```bash
export YOME_API_KEY=sk-...
export YOME_BASE_URL=https://your.endpoint
export YOME_MODEL=claude-opus-4-6
export YOME_PROVIDER=anthropic     # or openai (auto-detected from base URL)
```

Or persist once into `~/.yome/config.json`:

```bash
yome --key sk-... --base-url https://… --model …
```

**Storage layout:**

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

## Philosophy

> *Users will not learn a new product. Users will not change the way they already work.*

We do not replace your tools. We **empower** them without interrupting the way you already work. Mail, Chat, Docs, Calendar, Files, Web — they already live on your machine. We just bolt on a living-context layer and wake them up.

| Before | After |
|---|---|
| Passive Tool | Proactive Agent |
| You route context → tool | Yome reaches into every device for you |
| 12 contexts, 0 AI | 1 buddy that knows everything about you |

---

## Project Status

| Area | Status |
|---|---|
| Bash kernel (tokenizer + dispatcher + permission gate) | **stable** |
| Native skill format (yome-skill.json + L1/L2/L3 docs) | **stable** |
| `@yome/ppt` (16 actions, batch + 4 themes) | **stable** |
| Skill hub (search / install / publish) | **stable** |
| Capability model (sandbox grants) | **stable** |
| Thread history + case bundles | **stable** |
| Live history compaction | beta |
| Daemon (OS-level always-on loop) | experimental, on `next` branch |
| Oncall (event-driven, auto-paging) | next-up |

**Daemon roadmap** *(scoped, on `next`)*

- [ ] **Notification interception** — WeChat / Feishu / Slack / WhatsApp / iMessage. Surface what matters, suppress noise, draft replies before you ask.
- [ ] **Routine automation** — subscribed feeds, blogs, daily digests, alarms, calendar. Fires without you opening anything.
- [ ] **State-change watchers** — experiment finished, CPU/GPU spike, build green, someone @-pinged you. Push the moment, not the digest.

---

## License

[Apache License 2.0](./LICENSE) — Yome Agent + official skills (`yome-skill-ppt`, `yome-skill-xl`, `yome-skill-cal`, `yome-skill-rem`, `yome-skill-fs`).

Community-contributed skills published to the Yome hub are author-owned git repositories under their own license terms.

---

<div align="center">

**YOME — Your Universal AI Work Buddy.**
*Know everything. Run everywhere. Empower everyone.*

</div>
