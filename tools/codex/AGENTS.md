# Agent Setup Guide

This file helps AI coding agents (Claude Code, Codex, Cursor, Gemini, etc.) automatically set up langfuse-codex for the user.

## Project Overview

**langfuse-codex** traces [Codex CLI](https://github.com/openai/codex) (v0.128+) conversations to Langfuse using Codex's **native hook system** (`~/.codex/hooks.json`). No wrapper or bridge required.

Covered events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`.

## Automated Setup Procedure

### Step 1: Check Prerequisites

```bash
# Codex CLI 0.128+
codex --version

# Python 3.8+
python3 --version

# pip + langfuse SDK
python3 -m pip --version
python3 -c "import langfuse; print(langfuse.__version__)" 2>/dev/null || echo "not installed"
```

If langfuse is not installed:
```bash
python3 -m pip install --upgrade langfuse
```

If Codex CLI is older than 0.128, **stop** and ask the user to upgrade — native hooks are unavailable on older versions.

### Step 2: Interview User for Langfuse Credentials

Ask the user for these values. Do NOT guess or use placeholder values.

| Key | Question | Example |
|-----|----------|---------|
| `LANGFUSE_PUBLIC_KEY` | "Langfuse Public Key를 알려주세요" | `pk-lf-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `LANGFUSE_SECRET_KEY` | "Langfuse Secret Key를 알려주세요" | `sk-lf-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `LANGFUSE_BASE_URL` | "Langfuse URL? (기본 https://cloud.langfuse.com)" | URL or self-hosted instance |
| `LANGFUSE_USER_ID` | "Trace 에 표시할 사용자/호스트 ID (기본 codex-user)" | any string, e.g. `AgentOS` |

Get keys from: Langfuse Dashboard → Project Settings → API Keys.

### Step 3: Install Hook Script

```bash
mkdir -p ~/.codex/hooks ~/.codex/state
cp langfuse_hook.py ~/.codex/hooks/langfuse_hook.py
chmod +x ~/.codex/hooks/langfuse_hook.py
```

### Step 4: Write Credentials to `~/.codex/.env`

```bash
cat > ~/.codex/.env <<EOF
# Langfuse credentials for langfuse-codex
TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=<from interview>
LANGFUSE_SECRET_KEY=<from interview>
LANGFUSE_BASE_URL=<from interview>
LANGFUSE_USER_ID=<from interview>
EOF
chmod 600 ~/.codex/.env
```

### Step 5: Write `~/.codex/hooks.json`

Codex uses a separate `hooks.json` (NOT inside `config.toml`). The top-level key is `"hooks"`:

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }],
    "PreToolUse":        [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/langfuse_hook.py" }] }]
  }
}
```

If the user already has a `~/.codex/hooks.json`, **merge** instead of overwriting (preserve existing non-langfuse entries). The `install.sh` script does this automatically.

### Step 6: ONE-TIME Trust (CRITICAL — cannot be skipped)

Codex requires explicit user trust for non-managed command hooks. Tell the user:

> "Codex is now configured but the hooks won't fire yet. You need to **trust** them once:
>
> 1. Run `codex` (interactive TUI)
> 2. Type `/hooks` and press enter
> 3. Review the langfuse_hook entries and approve them
> 4. Type `exit` or press Ctrl-C to leave
>
> This is required once per host."

If the user skips this, the hook script is installed but `~/.codex/state/langfuse_hook.log` will remain empty.

### Step 7: ChatGPT Account Model Override

If the user authenticated with `codex login` using a ChatGPT account (Plus/Pro), the default `gpt-5-codex` model is rejected. Recommend setting `model = "gpt-5.5"` in `~/.codex/config.toml`, or using `-c model="gpt-5.5"` per invocation.

Skip this step for API-key users.

### Step 8: Verify

```bash
# Files exist
ls -la ~/.codex/hooks/langfuse_hook.py ~/.codex/.env ~/.codex/hooks.json

# langfuse import works
python3 -c "import langfuse; print('OK')"

# Hook unit test (TRACE_TO_LANGFUSE=false so no real send)
echo '{"session_id":"t","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"cmd":"ls"},"tool_response":{"stdout":"ok"}}' | \
  TRACE_TO_LANGFUSE=false python3 ~/.codex/hooks/langfuse_hook.py
echo "exit=$?"   # expect 0
```

### Step 9: Inform User

- After the trust step, the hook fires automatically on every Codex turn
- Dashboard: `LANGFUSE_BASE_URL`
- Logs: `~/.codex/state/langfuse_hook.log`
- Debug mode: `CC_LANGFUSE_DEBUG=true codex ...`
- Disable: edit `~/.codex/.env` → `TRACE_TO_LANGFUSE=false`

## Configuration Hierarchy

Priority (highest first):
1. **Environment variables** (system-level)
2. **`~/.codex/.env`** (user-level credentials, loaded by the hook)

`~/.codex/config.toml` is for Codex CLI's own configuration (model, OTel, sandbox, etc.) — langfuse-codex does not touch it.

## File Paths

| File | Path | Purpose |
|------|------|---------|
| Hook script (source) | `./langfuse_hook.py` | Main hook implementation |
| Hook script (installed) | `~/.codex/hooks/langfuse_hook.py` | Active hook |
| Credentials | `~/.codex/.env` | Langfuse API keys (user-level) |
| Hooks registration | `~/.codex/hooks.json` | Codex native hook config |
| State | `~/.codex/state/langfuse_state.json` | Incremental processing offsets |
| Tool buffer | `~/.codex/state/langfuse_tool_buffer.jsonl` | PreToolUse/PostToolUse event buffer |
| Log | `~/.codex/state/langfuse_hook.log` | Hook execution log |

## Troubleshooting

- **No traces** — Did you complete Step 6 (trust)? Run `codex` → `/hooks` to verify entries are approved
- **Hook not firing** — `~/.codex/hooks.json` syntax error, or trust not granted
- **Import error** — `python3 -m pip install langfuse`
- **Duplicate traces** — `rm ~/.codex/state/langfuse_state.json`
- **`gpt-5-codex` rejected** — ChatGPT account user, see Step 7
- **Stop trace empty** — Codex didn't populate `transcript_path`; hook auto-falls-back to minimal trace (v0.1.0 behavior)
