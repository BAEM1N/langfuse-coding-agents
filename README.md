# langfuse-coding-agents

[English](README.md) | [한국어](README.ko.md)

> Native [Langfuse](https://langfuse.com) tracing for AI coding agents. One monorepo, one consistent integration pattern, five different agent runtimes.

Every conversation turn, tool call, and model response from your favorite coding agent becomes a structured trace in your Langfuse dashboard — without modifying the agent itself.

## Supported Agents

| Tool | Path | Hook Config | Events | Status |
|------|------|-------------|--------|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [`tools/claude-code/`](tools/claude-code/) | `~/.claude/settings.json` | 4 (Stop, Notification, PreToolUse, PostToolUse) | stable |
| [Codex CLI](https://github.com/openai/codex) | [`tools/codex/`](tools/codex/) | `~/.codex/hooks.json` | 6 (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop) | v0.1.0 |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | [`tools/oh-my-codex/`](tools/oh-my-codex/) | `~/.omx/hooks/` + optional `~/.codex/hooks.json` bridge | OMX-native events + Codex bridge | stable |
| [OpenCode](https://github.com/sst/opencode) | [`tools/opencode/`](tools/opencode/) | `~/.config/opencode/plugins/` (JS plugin → Python hook) | event-stream | stable |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | [`tools/gemini-cli/`](tools/gemini-cli/) | `~/.gemini/settings.json` | **11** (full lifecycle: SessionStart/End, all tool events, Notification, PreCompression, ...) | stable |

Each tool subdirectory is self-contained and works exactly like the original standalone repo — just one `cd` deeper.

## Quick Start

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/<your-tool>      # e.g. tools/codex
bash install.sh
```

The installer asks for your Langfuse credentials, copies the hook script to the agent's config directory, registers all hook events, and prints any agent-specific one-time steps (e.g. Codex `/hooks` trust, ChatGPT account model override).

Windows users: replace `bash install.sh` with `.\install.ps1`.

## Why a Monorepo?

These integrations share **>95% of their core hook logic** — Langfuse SDK setup, transcript parsing, turn assembly, span emission, token accounting, fail-open behavior. They diverge mostly in:

- Hook event names and payload shapes (each agent has its own list)
- Config file locations (`~/.<agent>/...`)
- Transcript / session JSONL format

Keeping them in one repo lets us:
- Share a single `LICENSE`, contribution guide, and CI
- Cross-reference event mapping in [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md)
- Land hook engine improvements once and propagate to all adapters
- Avoid the "which repo is canonical?" question users had with five sibling repos

The five original repos (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`) remain on GitHub for backward compatibility with existing installations and bookmarks. New work happens here.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Agent (Claude Code / Codex /             │
│                  oh-my-codex / OpenCode / Gemini CLI)     │
└─────────────────────┬────────────────────────────────────┘
                      │ JSON payload on stdin
                      ▼
              ┌────────────────────┐
              │ langfuse_hook.py   │   ← per-tool adapter
              │  (in tools/<T>/)   │
              └────────┬───────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  Common pipeline (in-script): │
        │  1. Detect hook event         │
        │  2. Normalize payload (sync)  │
        │  3. Buffer tool events        │
        │  4. On turn end: emit traces  │
        │  5. Flush + shutdown          │
        └──────────────┬───────────────┘
                       │ Langfuse SDK
                       ▼
               ┌─────────────────┐
               │    Langfuse     │
               │    Dashboard    │
               └─────────────────┘
```

A future v0.2 will extract the shared pipeline into `core/langfuse_hook_core.py` so each tool adapter shrinks to schema normalization + dispatch. v0.1.0 (this release) keeps each tool fully self-contained.

## Compatibility

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Python | 3.8 | 3.10+ (for nested-span Langfuse SDK) |
| langfuse SDK | 2.0 | 3.12+ |
| OS | macOS, Linux, Windows | — |

Agent-specific version requirements:
- **Codex CLI 0.128+** (native hook system shipped in 0.128)
- **Claude Code** — any version with hook support
- **Gemini CLI** — any version with 11-event hook system
- **OpenCode** — any version supporting JS plugins
- **oh-my-codex** — see [`tools/oh-my-codex/`](tools/oh-my-codex/) for compatibility table

## Documentation

- 📚 [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) — Side-by-side event mapping across all 5 agents
- 📄 Per-tool README inside each `tools/<name>/` directory
- 🤖 Per-tool `AGENTS.md` for AI-driven setup automation

## Sibling / Legacy Repos

The five original standalone repos:
- [`langfuse-claude-code`](https://github.com/BAEM1N/langfuse-claude-code) → now [`tools/claude-code/`](tools/claude-code/)
- [`langfuse-codex`](https://github.com/BAEM1N/langfuse-codex) → now [`tools/codex/`](tools/codex/)
- [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex) → now [`tools/oh-my-codex/`](tools/oh-my-codex/)
- [`langfuse-opencode`](https://github.com/BAEM1N/langfuse-opencode) → now [`tools/opencode/`](tools/opencode/)
- [`langfuse-gemini-cli`](https://github.com/BAEM1N/langfuse-gemini-cli) → now [`tools/gemini-cli/`](tools/gemini-cli/)

Existing installations of the standalone repos continue to work unchanged; new fixes and features land here first.

## Contributing

Pull requests welcome. Common contribution targets:
- New agent adapter (drop a `tools/<your-agent>/` subdir mirroring the existing structure)
- Hook event matrix updates as upstream agents add events
- Core pipeline improvements (will propagate to all adapters in v0.2)

## License

[MIT](LICENSE)
