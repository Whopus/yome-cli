# Yome CLI

AI coding agent in your terminal.

## Install

```bash
npm install -g @sobers/yome
```

Or run directly with npx:

```bash
npx @sobers/yome
```

## Configuration

### Environment Variables

```bash
export YOME_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
export YOME_API_KEY=sk-
export YOME_MODEL=qwen-plus
```

| Variable | Description | Default |
|---|---|---|
| `YOME_API_KEY` | API key | - |
| `YOME_BASE_URL` | API base URL | `https://zenmux.ai/api` |
| `YOME_MODEL` | Model name | - |
| `YOME_PROVIDER` | API provider: `anthropic` or `openai` | auto-detected |

### CLI Flags

```bash
yome --key sk-xxx --base-url https://api.anthropic.com
yome --model qwen-plus --provider openai
```

Flags will be saved to `~/.yome/config.json` for future use.

## Usage

```bash
# Interactive mode
yome

# With a prompt
yome "help me read package.json"

# Set config and run
yome --key sk-xxx --base-url https://dashscope.aliyuncs.com/apps/anthropic
```
