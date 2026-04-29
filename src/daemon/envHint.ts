// cli/src/daemon/envHint.ts
//
// Build a lightweight "environment hint" block that gets prepended to
// every daemon-task prompt. The goal is to compensate for two things
// the LLM cannot easily learn at runtime in an unattended session:
//
//   1. Which non-default tools are installed on THIS machine
//      (lark-cli, gh, jq, osascript, ...). Without this hint the
//      Agent often spends 30s of its budget exploring with `which`.
//   2. Per-tool gotchas that come up in real tasks (lark-cli's
//      "+method" subcommand naming, macOS `date -v` vs GNU `date -d`,
//      etc.). One sentence here saves several wasted tool calls later.
//
// We deliberately do NOT touch the Agent's system prompt: this hint is
// daemon-only. Interactive `yome` runs in front of a human who already
// knows their own machine.
//
// The hint is appended in user-prompt position (not system) so it shows
// up in audit logs (`run_start.prompt`) and is trivially debuggable.

import { spawnSync } from 'child_process';

/** Cheap PATH lookup: spawn `/usr/bin/which` and check exit code. */
function which(name: string): boolean {
  // We deliberately avoid `shell: true` here: name comes from a static
  // constant table below but Node 22+ warns on shell:true regardless,
  // and `which` (BSD + GNU) supports the same calling convention.
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf-8', timeout: 2_000 });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

interface ToolHint {
  /** Binary name to detect via `command -v`. */
  bin: string;
  /** Short label shown in the "已检测到" line. */
  label: string;
  /** Multi-line cheatsheet appended only if the binary is present. */
  cheatsheet: string;
}

const TOOLS: ToolHint[] = [
  {
    bin: 'lark-cli',
    label: 'lark-cli (飞书 CLI)',
    cheatsheet: [
      '【lark-cli 速查】',
      '- 子命令是连字符串带 +：lark-cli im +chat-messages-list',
      '  错误写法（会报 unknown command）：lark-cli im chat-messages list',
      '- 列群：lark-cli im chats list --params \'{"page_size":50}\' --page-all',
      '- 拉某群最近消息：lark-cli im +chat-messages-list --chat-id <id> --page-size 20 --format json',
      '- 自己的 open_id：lark-cli auth status | jq -r .openId  （不是 .open_id）',
      '',
      '**重要：lark-cli JSON 顶层结构（两种 envelope，会混淆）**',
      '- 直接子命令（im chats list, im chats get）：{ code, data, msg }   ← 飞书 API 原生',
      '- 加号子命令（im +chat-messages-list 等）：{ ok, identity, data }   ← lark-cli envelope',
      '- **不要**用 .ok 判断成功（直接子命令没这字段）；用 .data 是否存在更鲁棒',
      '- 各自的数据路径：',
      '    .data.items[]      → chats list 的群条目（含 chat_id, name）',
      '    .data.messages[]   → +chat-messages-list 的消息条目',
      '    .data.items[]      → +messages-search 的消息条目（也是 items）',
      '- 计数: .data.items | length / .data.messages | length',
      '',
      '【lark-cli 输出陷阱】',
      '- --page-all 在 **stderr** 输出 "[page N] fetching..." 进度行；用 2>/dev/null 抑制',
      '- 不带 --page-all 输出纯 JSON 到 stdout，更安全',
      '- jq 输出**多行 JSON 对象**会被 while-read 拆碎；用 jq -c (compact) 或 jq -r ... | @tsv',
      '- 全部模块：im / calendar / sheets / base / drive / docs / mail / contact / vc / wiki / minutes / task',
      '',
      '**重要：messages-list 的字段格式（实测过）**',
      '- create_time 是字符串 "YYYY-MM-DD HH:MM"（本地时区，不是 epoch）',
      '  时间过滤直接字符串比较即可：select(.create_time >= "2026-04-28 00:00")',
      '- sender.id_type 决定 sender.id 的含义：',
      '    "open_id"  → 真人 (ou_xxx)',
      '    "app_id"   → 机器人 (cli_xxx)',
      '    "user_id"  → 企业 user_id (罕见)',
      '- **content 字段在顶层 (.content)，不是 .body.content**！',
      '  msg_type=text          → content 是纯文本字符串 "请问下..."（**不是** JSON）',
      '  msg_type=interactive   → content 是带 <card> XML 的字符串（直接展示即可）',
      '  msg_type=post          → content 是带 <p>/<a> 的字符串（直接展示即可）',
      '  千万别 .body.content 也别 (.content | fromjson)；fromjson 用不上',
    ].join('\n'),
  },
  {
    bin: 'gh',
    label: 'gh (GitHub CLI)',
    cheatsheet: [
      '【gh 速查】',
      '- 当前用户：gh api user --jq .login',
      '- 列 PR：gh pr list --state open --json number,title,author',
      '- 触发 workflow：gh workflow run <file> -f key=val',
    ].join('\n'),
  },
  {
    bin: 'jq',
    label: 'jq (JSON 处理)',
    cheatsheet: '【jq】可用，不用退回 grep/awk 切 JSON。',
  },
  {
    bin: 'osascript',
    label: 'osascript (macOS 自动化)',
    cheatsheet: [
      '【osascript】可用。读日历、提醒、Notes、Music、Mail 等。',
      '示例：osascript -e \'tell application "Calendar" to get name of calendars\'',
    ].join('\n'),
  },
];

/**
 * Build the env-hint string. Returns '' if no notable tools are
 * detected so we don't waste tokens on a useless empty block.
 */
export function buildEnvHint(): string {
  const present = TOOLS.filter((t) => which(t.bin));
  if (present.length === 0) return '';

  const platform = process.platform;
  const lines: string[] = [];
  lines.push('[环境提示] (daemon 任务自动注入)');
  lines.push(`平台: ${platform === 'darwin' ? 'macOS' : platform}`);
  lines.push(`已检测到的本地命令: ${present.map((t) => t.label).join(', ')}`);
  lines.push('');

  // Per-tool cheatsheets.
  for (const t of present) {
    lines.push(t.cheatsheet);
    lines.push('');
  }

  // Platform-specific gotchas. Most agent failures we've seen are
  // GNU-vs-BSD coreutils mismatches.
  if (platform === 'darwin') {
    lines.push('【macOS 注意】');
    lines.push('- date 是 BSD 版：减时间用 -v，不用 -d。');
    lines.push('  减 3 小时: date -v-3H "+%Y-%m-%d %H:%M"');
    lines.push('  减 7 天:   date -v-7d "+%Y-%m-%d"');
    lines.push('- sed 也是 BSD 版：-i 后必须跟一个备份后缀（用 \'\' 表示无备份）：sed -i \'\' \'s/a/b/\' file');
    lines.push('');
    lines.push('【shell 脚本陷阱（macOS）】');
    lines.push('- shebang 优先 #!/bin/bash 而不是 #!/bin/sh —— /bin/sh 是 dash-ish，不支持 $\'\\t\' 之类 ANSI-C 转义');
    lines.push('- 用制表符做 IFS 必须用 ANSI-C 引用：IFS=$\'\\t\'（bash），不要 IFS=\'\\t\'（那是字面 \\ + t 两个字符）');
    lines.push('  POSIX-only 写法：IFS="$(printf \'\\t\')"');
    lines.push('- jq 多字段输出优先 @tsv（自动转义）：jq -r \'.[] | [.a, .b] | @tsv\'，再 while IFS=$\'\\t\' read 拆');
    lines.push('- 写脚本/MD 文件时不要带 BOM；echo/printf/cat <<EOF 都安全，避免编辑器自动加 BOM');
    lines.push('- **管道 + while 是 subshell！**变量赋值传不回父 shell：');
    lines.push('  WRONG: cmd | while read x; do BUF="$BUF$x"; done; echo "$BUF"  # BUF 是空的');
    lines.push('  FIX (1) 用临时文件累计:    cmd | while read x; do echo "$x" >> $TMP; done');
    lines.push('  FIX (2) 用 process substitution: while read x; do BUF="$BUF$x"; done < <(cmd)');
    lines.push('  FIX (3) 直接 printf >> 文件 (推荐): cmd | while read x; do printf ... >> /tmp/out.md; done');
    lines.push('- 类似坑：在 while loop 里改 HAS_MESSAGES=true，loop 退出后还是 false');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
