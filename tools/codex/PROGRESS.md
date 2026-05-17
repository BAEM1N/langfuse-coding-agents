# Progress

## v0.1.0 (2026-05-17) — Native Codex CLI baseline

### Completed
- Forked from `langfuse-claude-code` with Codex schema adaptation
- All paths migrated `~/.claude/*` → `~/.codex/*`
- Inline `camelCase` → `snake_case` payload normalizer (9 key aliases)
- Event coverage expanded to 6: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- `transcript_path` fallback — emits minimal trace when Codex omits the transcript file
- Settings.json `hooks` merge → standalone `~/.codex/hooks.json` file (Codex native format)
- `install.sh` / `install.ps1` updated with Codex 0.128+ version check, trust reminder, and ChatGPT model override note

### Verified
- Syntax check on `langfuse_hook.py` (1500+ lines, Python 3.9)
- All 6 event types + camelCase variant unit-tested with `TRACE_TO_LANGFUSE=false` (exit 0)
- `install.sh` bash syntax check (`bash -n`)
- Tested on macOS 26.3.1 / Codex CLI v0.130.0

### Pending (out of v0.1.0 scope)
- Real-world trust + transcript_path observation on a live Codex session (depends on user TUI access)
- PreCompact / PostCompact event payload exploration (v0.2)
- Sibling repo READMEs updated to mention `langfuse-codex` (separate PRs)
