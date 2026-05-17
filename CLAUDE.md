# CLAUDE.md

Claude Code reads this file automatically when working inside this repository.

The full setup guide and per-tool procedures live in **[AGENTS.md](./AGENTS.md)** — same content, shared across all AI coding agents.

## Quick orientation for Claude Code

- **Goal**: integrate Langfuse tracing into one of 5 AI coding tools (Claude Code, Codex CLI, oh-my-codex, OpenCode, Gemini CLI) without modifying the tool itself.
- **Code lives under**: `tools/<tool>/` — each subdirectory is a self-contained installer + hook.
- **Source of truth**: `tools/<tool>/langfuse_hook.py`. User installations are file copies of these; do not edit the installed copies in `~/.<tool>/hooks/`.
- **SDK constraint**: hooks target Langfuse Python SDK 4.x. Two compat shims live at the top of every hook — do **not** delete them when refactoring (see *SDK 4.x notes* in [AGENTS.md](./AGENTS.md)).
- **When the user asks "set up Langfuse for <tool>"**: follow the Step 1–5 procedure in [AGENTS.md](./AGENTS.md) for that specific tool.

## Conventions specific to Claude Code sessions

- Per-tool `AGENTS.md` files (`tools/<tool>/AGENTS.md`) take precedence over this root file when working inside that subdirectory.
- The `docs/` folder contains the hook event matrix — consult it before claiming "X tool doesn't capture event Y."
- All five tools' hooks are intentionally near-duplicate Python files. Cross-tool patches (e.g. the SDK 4.x migration) are applied uniformly to all five — when you patch one, patch all five.
- **No silent package-manager calls.** Detect Python / pip / langfuse availability and `pip install` the SDK if missing, but for system-level installs (Python itself, `uv`, OS packages) hand the one-liner to the user and wait — a tracing hook auto-running `brew install` or `apt install` reads as a supply-chain backdoor. See *Step 1* in [AGENTS.md](./AGENTS.md).
