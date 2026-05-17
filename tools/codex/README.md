# langfuse-codex

> 📦 Part of the [`langfuse-coding-agents`](../../README.md) monorepo. Other tools: [`claude-code`](../claude-code/) · [`codex`](../codex/) · [`oh-my-codex`](../oh-my-codex/) · [`opencode`](../opencode/) · [`gemini-cli`](../gemini-cli/)

[English](README.md) | [한국어](README.ko.md)

Native [Langfuse](https://langfuse.com) tracing for [Codex CLI](https://github.com/openai/codex) — no wrapper required. Every conversation turn, tool call, and model response is captured as structured traces in your Langfuse dashboard.

## Status (May 17, 2026)

- ✅ `v0.1.0` — Native Codex CLI baseline
- ✅ Codex CLI 0.128+ native hook system (`~/.codex/hooks.json`)
- ✅ 6 hook events covered: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- ✅ `snake_case` payload primary, `camelCase` alias fallback inline (works with Codex v0.128+ direct OR oh-my-codex bridge)
- ✅ `transcript_path` fallback — generates a minimal trace even when Codex omits the transcript file
- ✅ Verified on Codex CLI v0.130.0 (single-hook unit tests)
- 🔗 Sibling repos: [`langfuse-claude-code`](https://github.com/BAEM1N/langfuse-claude-code) · [`langfuse-gemini-cli`](https://github.com/BAEM1N/langfuse-gemini-cli) · [`langfuse-opencode`](https://github.com/BAEM1N/langfuse-opencode) · [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex)

## Why two Codex repos?

| Repo | Target | Dependencies |
|---|---|---|
| **`langfuse-codex`** (this) | Pure Codex CLI 0.128+ users | Codex CLI only |
| [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex) | [oh-my-codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex) wrapper users | OMX required (native-bridge optional) |

If you run Codex CLI directly, use **this repo**. If you wrap Codex with OMX, use `langfuse-oh-my-codex`.

## Features

- **Native Codex hooks** — uses Codex CLI's own hook system (`~/.codex/hooks.json`), no third-party wrapper
- **6 event coverage** — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- **Per-turn tracing** — each user prompt + assistant response becomes a Langfuse trace
- **Tool call tracking** — every tool use is captured with inputs and outputs
- **Thinking blocks** — model reasoning is captured as separate spans
- **Token usage** — input/output/cache token counts recorded on each generation
- **Session grouping** — traces are grouped by Codex session ID
- **Incremental processing** — only new turns are sent (no duplicates)
- **Schema-tolerant** — accepts both Codex's `snake_case` (v0.130+) and `camelCase` payload variants
- **Transcript fallback** — minimal trace when transcript JSONL is unavailable (Codex behavior is still evolving)
- **Fail-open** — if anything goes wrong the hook exits silently; Codex is never blocked
- **Cross-platform** — macOS, Linux, Windows

## Prerequisites

- **Codex CLI 0.128+** ([install](https://github.com/openai/codex)) — required for the native hook system
- **Python 3.8+** with `pip` (`python3 -m pip --version`)
- **Langfuse account** — [cloud.langfuse.com](https://cloud.langfuse.com) or a self-hosted instance

## Quick Start

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/codex
bash install.sh
```

On Windows (PowerShell):

```powershell
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/codex
.\install.ps1
```

The installer will:
1. Check Codex CLI 0.128+ and Python 3.8+ are available
2. Install the `langfuse` Python package
3. Copy the hook script to `~/.codex/hooks/`
4. Prompt you for Langfuse credentials and write them to `~/.codex/.env`
5. Generate `~/.codex/hooks.json` registering the 6 lifecycle events
6. Print the one-time **trust** step you must complete

## One-time Trust Step

Codex requires explicit trust for non-managed command hooks (security feature). The installer prints this reminder, but it's worth calling out:

```
$ codex                # interactive TUI
> /hooks               # slash command
# Review the langfuse_hook entries → approve
> exit
```

This is **one-time per host**. Subsequent `codex` and `codex exec` invocations will fire the hooks automatically.

If you skip this step, the hook script is installed but never invoked — `~/.codex/state/langfuse_hook.log` will remain empty.

## ChatGPT Account Users

If you authenticated with `codex login` using a **ChatGPT account** (Plus/Pro), the default `gpt-5-codex` model in your `~/.codex/config.toml` is **rejected** by the API. Use a supported model:

```bash
codex exec -c model="gpt-5.5" "your prompt"
```

Or set it permanently in `~/.codex/config.toml`:

```toml
model = "gpt-5.5"
```

API-key users (non-ChatGPT) can use `gpt-5-codex` as normal.

## Manual Setup

If you prefer manual installation:

### 1. Install the langfuse SDK

```bash
pip install langfuse
```

### 2. Copy the hook script

```bash
mkdir -p ~/.codex/hooks ~/.codex/state
cp langfuse_hook.py ~/.codex/hooks/
chmod +x ~/.codex/hooks/langfuse_hook.py
```

### 3. Write credentials to `~/.codex/.env`

```bash
cat > ~/.codex/.env <<EOF
TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_USER_ID=codex-user
EOF
chmod 600 ~/.codex/.env
```

### 4. Register hooks in `~/.codex/hooks.json`

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

### 5. Trust the hooks

```bash
codex
> /hooks
# Approve langfuse_hook.py entries
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TRACE_TO_LANGFUSE` | Yes | - | Set to `"true"` to enable tracing |
| `LANGFUSE_PUBLIC_KEY` | Yes | - | Langfuse public key (or `CC_LANGFUSE_PUBLIC_KEY`) |
| `LANGFUSE_SECRET_KEY` | Yes | - | Langfuse secret key (or `CC_LANGFUSE_SECRET_KEY`) |
| `LANGFUSE_BASE_URL` | No | `https://cloud.langfuse.com` | Self-hosted Langfuse URL |
| `LANGFUSE_USER_ID` | No | `codex-user` | User ID for trace attribution (e.g. host name) |
| `CC_LANGFUSE_DEBUG` | No | `false` | Verbose logging to `~/.codex/state/langfuse_hook.log` |
| `CC_LANGFUSE_MAX_CHARS` | No | `20000` | Truncate text fields beyond this length |

All `LANGFUSE_*` variables also accept a `CC_LANGFUSE_*` prefix (which takes priority).

### Self-hosted Langfuse

```bash
LANGFUSE_BASE_URL=https://langfuse.your-company.com
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    Codex CLI                            │
│                                                         │
│  User prompt ──► Model response ──► Tool calls ──► ...  │
│       │                                                 │
│       │  ┌──── 6 lifecycle hooks ──────────────┐        │
│       └─►│ langfuse_hook.py (stdin = JSON)      │        │
│          │                                      │        │
│          │ • Normalize camelCase → snake_case   │        │
│          │ • Detect event_type                  │        │
│          │ • Buffer PreToolUse / PostToolUse    │        │
│          │ • On Stop: read transcript or        │        │
│          │   fallback to buffered events        │        │
│          └───────┬──────────────────────────────┘        │
│                  │                                       │
└──────────────────┼───────────────────────────────────────┘
                   │
                   ▼
          ┌─────────────────────┐
          │      Langfuse        │
          │                      │
          │  Trace (Codex - Turn N) │
          │  ├─ System Prompt    │
          │  ├─ Generation       │
          │  │   ├─ model        │
          │  │   ├─ usage tokens │
          │  │   └─ stop_reason  │
          │  ├─ Thinking [1]     │
          │  ├─ Text [1]         │
          │  ├─ Tool: Bash       │
          │  ├─ Text [2]         │
          │  └─ Tool: apply_patch│
          │                      │
          │  Session: <codex_id>  │
          └─────────────────────┘
```

**Flow:**

1. Codex CLI writes session state and (optionally) a transcript file
2. On each lifecycle event, Codex invokes the registered hook with a JSON payload on stdin
3. The hook normalizes `camelCase`/`snake_case` keys, detects event type
4. `PreToolUse` / `PostToolUse` are buffered into `~/.codex/state/langfuse_tool_buffer.jsonl`
5. On `Stop`, the hook either:
   - Reads the transcript JSONL, rebuilds the conversation, and emits a full per-turn trace (rich path), OR
   - Falls back to a minimal trace using `last_assistant_message` + buffered tool events (when transcript_path is absent)
6. Other events (`SessionStart`, `UserPromptSubmit`, `PermissionRequest`) become single-span traces
7. All traces share the same `session_id` for session grouping in Langfuse

## Compatibility

| Component | Version |
|-----------|---------|
| Codex CLI | 0.128+ (native hooks required) |
| Python | 3.8+ |
| langfuse SDK | 2.0+ (flat) / 3.12+ (nested spans, recommended) |
| OS | macOS, Linux, Windows |

## Troubleshooting

### Traces not appearing

1. Confirm trust step: `codex` → `/hooks` → approve
2. Verify `~/.codex/.env` has `TRACE_TO_LANGFUSE=true` and valid keys
3. Enable debug: `CC_LANGFUSE_DEBUG=true codex exec "test"`
4. Check log: `tail -f ~/.codex/state/langfuse_hook.log`

### Hook not firing

1. `codex` → `/hooks` shows the entries? If not, hooks.json not loaded — check file syntax
2. ChatGPT account model error? Override with `-c model="gpt-5.5"` (see above)
3. Manual test: `echo '{"session_id":"t","hook_event_name":"PostToolUse","tool_name":"Bash"}' | python3 ~/.codex/hooks/langfuse_hook.py` → exit 0 + log entry expected

### Stop trace empty / transcript_path missing

Codex's transcript handling is still evolving. If `Transcript path does not exist` appears in the log, the hook now emits a **fallback trace** with `last_assistant_message` + buffered tool events. This is intentional v0.1.0 behavior — full transcript-based traces require Codex to populate `transcript_path` in the hook payload.

### Duplicate traces

State stored in `~/.codex/state/langfuse_state.json`. Delete this file to reset offsets (will re-send previously processed turns).

## Uninstall

```bash
rm ~/.codex/hooks/langfuse_hook.py
rm ~/.codex/hooks.json   # or edit out only the langfuse entries
rm ~/.codex/.env
rm -rf ~/.codex/state    # state + logs + tool buffer
```

Then run `codex` → `/hooks` to confirm no langfuse entries remain.

## License

[MIT](LICENSE)
