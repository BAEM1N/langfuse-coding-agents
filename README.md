# Langfuse and OpenTelemetry for AI coding agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![langfuse ≥4.0](https://img.shields.io/badge/langfuse-%E2%89%A54.0-7c3aed.svg)](https://github.com/langfuse/langfuse-python)

[English](README.md) | [한국어](README.ko.md)

`langfuse-coding-agents` adds LLM observability to Claude Code, OpenAI Codex CLI,
Oh My Pi (OMP), Google Antigravity CLI, and OpenCode. It captures coding agent turns,
model input/output and token usage, and tool execution spans that link each call to
the model requests around it. Export to [Langfuse](https://langfuse.com), an
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), or both.

- [Installation and OTLP configuration](ts/README.md)
- [Windows, macOS, and Linux setup with Grafana Tempo](docs/setup-agent-observability.md)
- [Agent compatibility and live verification](docs/agent-observability.md)
- [Capture controls and privacy](#security--privacy)

---

## Contents

- [Supported AI coding agents](#supported-ai-coding-agents)
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

## Supported AI coding agents

| Agent | Installation | Trace destination |
| --- | --- | --- |
| Claude Code | [Native hooks](ts/README.md) | Langfuse and OTLP |
| OpenAI Codex CLI | [Native hooks](ts/README.md) | Langfuse and OTLP |
| Oh My Pi (OMP) | [Extension](ts/README.md#oh-my-pi-extension) | Langfuse and OTLP |
| Google Antigravity CLI (`agy`) | [Native hooks](ts/README.md#antigravity) | Langfuse and OTLP |
| OpenCode 1.x | [Plugin and turn exporter](tools/opencode/) | Langfuse and OTLP turn traces |
| GitHub Copilot CLI | [User-level hook](ts/README.md#github-copilot-cli) | Langfuse and OTLP |
| LangChain Deep Agents SDK | [Python callback](tools/deepagents/) | Langfuse and OTLP |
| Goose | [Native OTLP via Collector](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector) | OTLP and Langfuse |
| oh-my-codex (OMX) | [Native bridge](tools/oh-my-codex/) | Langfuse |
| Gemini CLI (legacy) | [Compatibility integration](tools/gemini-cli/) | Langfuse |

Use Antigravity CLI for eligible personal Google accounts. Google migrated free
individual, Google AI Pro, and Google AI Ultra access on June 18, 2026. The Gemini
CLI adapter remains available for existing compatible deployments. [Google migration guide](https://antigravity.google/docs/migrate-gemini-cli)

---

## Quick start

With Node.js 22.18+:

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/ts
node src/cli.ts install claude     # or: codex, antigravity
```

Configure an exporter in the agent's environment. For example, use a local
OpenTelemetry Collector HTTP receiver:

```dotenv
CODING_AGENT_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

For Langfuse keys, OpenCode and OMP setup, and model/tool body capture controls,
follow the [runtime configuration guide](ts/README.md).

### Python integrations

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
| Antigravity CLI for Google personal accounts | [Antigravity hooks](ts/README.md#antigravity) |
| Existing Gemini CLI deployment | `tools/gemini-cli/` |

If you run multiple tools, install them one by one — each writes to its own config directory and shares no global state.

---

## Architecture

The shared pipeline combines native hooks or a transcript/extension with turn
reconstruction, token usage, and tool-call correlation. It sends spans to Langfuse
or an OTLP/HTTP JSON receiver. The standalone Python adapters use their legacy
Langfuse pipeline below.

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

### What can I verify in a coding-agent trace?

The [Langfuse audit commands](ts/README.md#verify-call-order-and-monitoring-coverage) report observed
model and tool input/output coverage, token usage, timing anomalies, and call-ID
links. Counts show which fields were present. They work with the shared hook runtime
and recognize the GenAI metadata in Goose's native Langfuse spans.

### Can I send coding-agent traces to Grafana Tempo or Jaeger?

Yes. Configure the hooks to send OTLP/HTTP JSON to an OpenTelemetry Collector or a
compatible traces endpoint. The Collector can route the same spans to Tempo,
Jaeger, Honeycomb, or a Datadog intake. [Export configuration](ts/README.md#opentelemetry-traces)

### What is the difference between a supported adapter and an evaluated agent?

A supported adapter ships with a configured path to a trace destination. An evaluated
agent has a documented signal source, a local smoke test, or both. The
[compatibility matrix](docs/agent-observability.md) lists evidence and limits by agent.

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
- **Core pipeline improvements.** Make shared changes in `ts/src/core/` and verify them with `npm test` from `ts/`. Legacy Python integrations remain self-contained.

Style: small, atomic commits; conventional commit prefix (`fix:`, `feat:`, `docs:`, `chore:`); no auto-generated attribution footers.

---

## History

Previously distributed as five standalone repositories (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`). Unified into this monorepo in May 2026 to share the hook pipeline, license, and CI. The original repos have been retired.

---

## License

[MIT](LICENSE).
