# langfuse-coding-agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![langfuse ≥4.0](https://img.shields.io/badge/langfuse-%E2%89%A54.0-7c3aed.svg)](https://github.com/langfuse/langfuse-python)

[English](README.md) | [한국어](README.ko.md)

> Native [Langfuse](https://langfuse.com) tracing for AI coding agents. One monorepo, one integration pattern, five agent runtimes.

Every conversation turn, tool call, and model response from your coding agent becomes a structured trace in Langfuse — without modifying the agent itself.

---

## Contents

- [Supported agents](#supported-agents)
- [Quick start](#quick-start)
- [Choose your tool](#choose-your-tool)
- [Architecture](#architecture)
- [Compatibility](#compatibility)
- [Documentation](#documentation)
- [Security & privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [History](#history)
- [License](#license)

---

## Supported agents

| Tool | Path | Hook config | Events captured |
|------|------|-------------|-----------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [`tools/claude-code/`](tools/claude-code/) | `~/.claude/settings.json` | 4 — `Stop`, `Notification`, `PreToolUse`, `PostToolUse` |
| [Codex CLI 0.128+](https://github.com/openai/codex) | [`tools/codex/`](tools/codex/) | `~/.codex/hooks.json` | 6 — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop` |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | [`tools/oh-my-codex/`](tools/oh-my-codex/) | `~/.omx/hooks/` + `~/.codex/hooks.json` bridge | OMX-native events + Codex native bridge |
| [OpenCode](https://github.com/sst/opencode) | [`tools/opencode/`](tools/opencode/) | `~/.config/opencode/plugins/` (JS plugin → Python hook) | `session.*`, `message.updated`, `message.part.updated` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | [`tools/gemini-cli/`](tools/gemini-cli/) | `~/.gemini/settings.json` | 11 — full lifecycle (`SessionStart` → `SessionEnd`, all agent/model/tool phases, `Notification`, `PreCompress`) |

All five adapters are verified working as of v0.1.0. They share fail-open behavior, a `TRACE_TO_LANGFUSE=true` runtime gate, and Langfuse SDK 4.x compatibility (with a built-in shim for 3.x deployments — see [SDK compatibility](#sdk-compatibility)).

---

## Quick start

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/<your-tool>      # e.g. tools/opencode
bash install.sh                                  # Windows: ./install.ps1
```

The installer:
- copies `langfuse_hook.py` to the tool's config dir,
- writes a `.env` with your Langfuse credentials,
- merges the hook entries into the tool's existing settings/hooks JSON (no overwrite),
- prints any tool-specific one-time steps (e.g. Codex `/hooks` trust prompt).

### Agent-driven setup

If you don't want to read installer prompts, hand this repo to an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, ...) and say:

> "Set up Langfuse tracing for my `<tool>`."

The agent will read [`AGENTS.md`](AGENTS.md) (or [`CLAUDE.md`](CLAUDE.md) for Claude Code), interview you for credentials, and run the setup non-interactively. The guide is explicit about *not* auto-installing system packages — the agent surfaces one-liners for you to run, never `sudo apt install`s on its own.

---

## Choose your tool

| Your situation | Use |
|---|---|
| Daily-driver Claude Code session | `tools/claude-code/` |
| Codex CLI 0.128+ standalone (no wrapper) | `tools/codex/` |
| Codex CLI through the `oh-my-codex` npm wrapper | `tools/oh-my-codex/` — its installer also registers the Codex native bridge, so a separate `tools/codex/` install is unnecessary |
| OpenCode (any provider: Anthropic, OpenAI, OpenRouter, local LM Studio / Ollama, ...) | `tools/opencode/` |
| Gemini CLI (Google OAuth or `GEMINI_API_KEY`) | `tools/gemini-cli/` |

If you run multiple tools, install them one by one — each writes to its own config directory and shares no global state.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Host agent (Claude Code / Codex / oh-my-codex /         │
│              OpenCode / Gemini CLI)                       │
└─────────────────────┬─────────────────────────────────────┘
                      │ JSON payload on stdin
                      ▼
              ┌────────────────────┐
              │ langfuse_hook.py   │  ← per-tool adapter
              │ (in tools/<T>/)    │
              └────────┬───────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  In-script pipeline:         │
        │  1. Detect hook event        │
        │  2. Normalize payload        │
        │  3. Buffer tool events       │
        │  4. On turn end: emit spans  │
        │  5. Flush + shutdown         │
        └──────────────┬───────────────┘
                       │ Langfuse SDK
                       ▼
               ┌─────────────────┐
               │    Langfuse     │
               │    Dashboard    │
               └─────────────────┘
```

Each `tools/<tool>/langfuse_hook.py` is independent and self-contained. The five hooks share **~95% of their pipeline logic** but are kept as near-duplicate files for now — every cross-tool patch (e.g. the SDK 4.x migration) is applied uniformly to all five.

A future v0.2 may extract the shared pipeline into `core/langfuse_hook_core.py`. v0.1.0 keeps each adapter standalone.

For per-event mapping across agents, see [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md).

---

## Compatibility

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Python | 3.8 | 3.10+ |
| Langfuse Python SDK | 3.0 | **4.0+** (4.6.x tested) |
| OS | macOS / Linux / Windows | — |

Agent-specific requirements:

- **Codex CLI 0.128+** — native hook system shipped in 0.128.
- **Claude Code** — any release with hook support.
- **Gemini CLI** — any release with the 11-event hook system.
- **OpenCode** — any release with JS plugin support.
- **oh-my-codex** — see [`tools/oh-my-codex/README.md`](tools/oh-my-codex/README.md) for the support matrix.

### SDK compatibility

Langfuse 4.0 removed two APIs the original hooks relied on:

1. `Langfuse.start_as_current_span(...)` → use `start_as_current_observation(name=..., as_type="span", ...)`.
2. `Langfuse.update_current_trace(...)` → use the module-level `propagate_attributes(...)` context manager.

Hooks in this repo handle both:

- All call sites use `start_as_current_observation(...)`.
- A class-level shim installed at import time translates legacy `client.update_current_trace(...)` calls into `propagate_attributes` enter/exit. The shim only activates when the installed SDK lacks the native method, so Langfuse 3.x deployments work unchanged.

If you're embedding these hooks elsewhere, replicate the shim or migrate to `propagate_attributes` directly. See the *SDK 4.x notes* section in [`AGENTS.md`](AGENTS.md) for the contract.

---

## Documentation

- [`AGENTS.md`](AGENTS.md) — umbrella setup guide for AI coding agents (clone repo → hand to agent → done).
- [`CLAUDE.md`](CLAUDE.md) — thin pointer for Claude Code's auto-load behavior.
- [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) — side-by-side event mapping across all five agents.
- Each `tools/<name>/README.md` — per-tool installation, configuration, and troubleshooting.
- Each `tools/<name>/AGENTS.md` — tool-specific automation procedure for AI agents.

---

## Security & privacy

These hooks **forward every conversation turn, tool call, and model response** to the Langfuse instance you configure. That includes prompts, file paths, and tool outputs — whatever the host agent sees.

Recommendations:

- **Self-host Langfuse** if conversations may include proprietary code, internal URLs, secrets, or PII. The cloud `https://cloud.langfuse.com` is convenient but external.
- **Treat `.env` files as secrets** — installers write them with restrictive permissions; don't commit them.
- **`TRACE_TO_LANGFUSE=true` is a hard gate.** Unset it (or set to anything else) to disable tracing without uninstalling.
- **Fail-open by design**: a hook crash never blocks the host agent. The trade-off is that silent SDK errors can drop traces — check `~/.<tool>/state/langfuse_hook.log` to confirm delivery.

The hooks make **no outbound network call other than to the Langfuse host** specified in `LANGFUSE_BASE_URL`. They never auto-update themselves and never invoke a system package manager.

---

## Troubleshooting

Common symptoms and fixes are catalogued in the *Common failure modes* table at the bottom of [`AGENTS.md`](AGENTS.md). Highlights:

- **Hook log says `Processed in X.Xs` but no trace in Langfuse** → SDK 4.x AttributeError swallowed. Confirm hook contains `start_as_current_observation` and the `_Langfuse_class_for_compat` shim; re-sync from this repo if not.
- **Traces arrive without `userId` / `sessionId` / `tags`** → same root cause; same fix.
- **Per-tool `userId` not isolated (e.g. all show `BAEM1N`)** → shell env `LANGFUSE_USER_ID` shadows the tool's `.env`. `unset` it or override per-tool.
- **Codex CLI silently emits zero traces** → `~/.codex/hooks.json` not trusted by the user yet (Codex 0.128+ trust prompt); accept the prompt on next run.

---

## Contributing

PRs welcome. Common contribution targets:

- **New agent adapter.** Drop a `tools/<your-agent>/` subdir mirroring the existing layout (`langfuse_hook.py`, `install.sh`, `install.ps1`, `README.md`, `AGENTS.md`).
- **Hook event matrix updates** as upstream agents add events. Keep [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) in sync.
- **Core pipeline improvements.** The five hooks are intentionally near-duplicates — **patch all five at once** when changing shared logic. The SDK 4.x migration in commits `8f2db84` + `b08d2ca` is a worked example.

Style: small, atomic commits; conventional commit prefix (`fix:`, `feat:`, `docs:`, `chore:`); no auto-generated attribution footers.

---

## History

Previously distributed as five standalone repositories (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`). Unified into this monorepo in May 2026 to share the hook pipeline, license, and CI. The original repos have been retired.

---

## License

[MIT](LICENSE).
