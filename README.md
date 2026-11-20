# Langfuse and OpenTelemetry for AI coding agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![langfuse ≥4.0](https://img.shields.io/badge/langfuse-%E2%89%A54.0-7c3aed.svg)](https://github.com/langfuse/langfuse-python)

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## Project overview

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

- [Quick start](#quick-start)
- [Add Grafana Tempo](#add-grafana-tempo)
- [Live test results](#live-test-results)
- [Supported AI coding agents](#supported-ai-coding-agents)
- [Standalone Python integrations](#standalone-python-integrations)
- [Agent-driven setup](#agent-driven-setup)
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

## Quick start

Install Node.js 22.18 or later and the coding agents you want to trace. OpenCode 1.x needs Python 3.10 or later with `venv` and `ensurepip`. Use `--python /path/to/python3` if the default interpreter is older. On Windows, use PowerShell 7 for Copilot CLI command hooks.

```sh
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents
```

### 1. Configure Langfuse

Create `~/.config/langfuse-agent-hooks/.env` (`%USERPROFILE%\.config\langfuse-agent-hooks\.env` on Windows). Use your Langfuse project's keys and base URL. The installer can reuse already configured keys.

```dotenv
TRACE_TO_LANGFUSE=true
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-key
```

The shared Node runtime sends to Langfuse over OTLP, the route Langfuse supports. `LANGFUSE_HOOK_TRANSPORT` changes that only if you need to.

| Value | Sends to | Use with |
|---|---|---|
| unset or `auto` | `/api/public/otel/v1/traces` (OTLP/HTTP JSON, `x-langfuse-ingestion-version: 4`). If the server has no such endpoint, `/api/public/ingestion` for that server | Everything: Langfuse Cloud, self-hosted v4, self-hosted v3 |
| `otlp` | OTLP only, no fallback | When a wrong URL should fail instead of falling back |
| `legacy` | `/api/public/ingestion` only | Deprecated by Langfuse. Self-hosted before v3.22, which has no OTLP endpoint |

Langfuse Cloud stopped storing trace events sent to `/api/public/ingestion` on 2026-11-16, and self-hosted v4 rejects them outside its transitional `legacy` and `dual` write modes. An install made before this default existed moves to OTLP when its runtime is updated. For turns that began before the move, the project is read first, so a turn already stored through legacy ingestion is not stored again. To stay on legacy ingestion, set `LANGFUSE_HOOK_TRANSPORT=legacy`; `doctor` then prints a deprecation warning.

A turn is sent once it has finished, and never sent again after Langfuse accepts it, because Langfuse v4 does not deduplicate span IDs. A turn left without a Stop event is closed and sent after its transcript has been idle for an hour. Prompt and tool bodies, turn events and adapter metadata are sent redacted, with the per-string limit `LANGFUSE_HOOK_MAX_CHARS` (default 20,000). Set `LANGFUSE_HOOK_CAPTURE_CONTENT=false` to leave bodies out. See [what is not captured](docs/setup-agent-observability.md#what-is-not-captured) and [deprecation status](docs/setup-agent-observability.md#deprecation-status).

Sub-agent work (Claude Code agents, threads spawned by Codex, Oh My Pi task sessions) is read from its own files and sent as a `Subagent: <type>` span inside the turn that started it, and also as a trace of its own tagged `subagent`. Tokens are counted on the turn only, so totals do not double. See [sub-agents](docs/setup-agent-observability.md#sub-agents).

The standalone Python integrations under `tools/` use the Langfuse Python SDK, which sends over OTLP. They run on SDK 4.7 or later and on the current SDK 5.

### 2. Install hooks for your agents

Run the script for your OS from the repository root. The example installs Claude Code and Codex hooks. Use a comma-separated list to select other agents such as `omp`, `antigravity`, `copilot`, or `opencode`.

```powershell
./scripts/setup.ps1 --agents 'claude,codex'
```

```sh
sh scripts/setup.sh --agents claude,codex
```

Press Enter at the trace name prompt to use your home folder name, or pass `--name` to set it. `--device` adds a machine label and `--environment` sets an environment such as `local` or `ci`. Restart the agent after installing. In Codex, review newly registered commands with `/hooks`.

### 3. Verify a real trace

In a test directory, create `probe.txt` with a unique marker and ask the agent to read it and return its contents. In Langfuse, find the new trace and check the model call, tool execution, and following model call. Inspect the tool arguments and result plus the input/output token fields. Availability depends on the adapter and capture settings.

```sh
node ts/src/cli.ts selftest all                      # synthetic turn with a sub-agent in Claude, Codex and OMP formats: send, read back, compare, delete
node ts/src/cli.ts doctor claude                     # settings, destinations, last 24h of delivery results
node ts/src/cli.ts delivery claude                   # turns that are failed, partial or unconfirmed
node ts/src/cli.ts verify claude <traceId>           # read the trace back from Langfuse
node ts/src/cli.ts verify claude <traceId> --tempo http://127.0.0.1:13200
node ts/src/cli.ts coverage claude --since 2026-11-20T00:00:00Z   # local transcripts vs. what is stored
node ts/src/cli.ts audit-langfuse claude --limit 10  # read API is detected; force with --api v2|legacy
```

`doctor` reporting valid keys, or a hook logging that a request was accepted, does not show that a trace is stored. `verify` does: it reads the trace from the backend and compares it with what was sent. A turn listed as `unconfirmed` (timeout, lost response, or a partial rejection) is not sent again automatically; check it with `verify`, then `verify claude <traceId> --reconcile` to accept what is stored and resend only what is missing. `coverage` compares every local turn in a period with the project and lists turns that are missing, stored short, or have model calls without a cost.

Use `codex` in those diagnostic commands if its configuration holds the project keys. See the [platform setup guide](docs/setup-agent-observability.md) for [Deep Agents SDK](tools/deepagents/) and [Goose](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector) setup.

## Add Grafana Tempo

The hooks send directly to Langfuse. The Collector sends the OTLP copy to Tempo, and Grafana reads Tempo. Goose's native exporter goes through the Collector to both destinations. Provide existing Grafana, Tempo, and OpenTelemetry Collector binaries. The Collector distribution needs `file`, `transform`, and `otlp_http` (core distribution 0.164 or later, or contrib).

**Windows**

```powershell
node scripts/start-grafana.mjs --tempo 'C:\path\tempo.exe' --grafana 'C:\path\grafana-home'
./scripts/setup.ps1 --agents 'claude,codex' --collector 'C:\path\otelcol.exe' --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

**macOS and Linux**

```sh
node scripts/start-grafana.mjs --tempo /path/to/tempo --grafana /path/to/grafana-home
sh scripts/setup.sh --agents claude,codex --collector /path/to/otelcol --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

By default the hooks keep sending to Langfuse themselves and use the Collector's `14318` receiver for Tempo. Add `--collector-route both` to send only to the Collector's `14319` receiver, which forwards to Langfuse and Tempo; setup then turns off direct export so the project gets each turn once. `--collector-route tempo` switches back. On the `both` route, bodies reach Langfuse only with `--capture-content`, and the Collector accepting a request does not confirm delivery to either backend, so check with `verify`.

`--grafana` points to the extracted Grafana home directory, and `--tempo` on the setup script is the OTLP ingest URL. The example Collector starts on demand. Restart an existing Collector after updating its YAML. Use `--capture-content` only when you want supported exporters to include prompt, response, and tool bodies.

Open the local [Coding agent traces dashboard](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces), select a trace ID, and expand its model or tool spans. `coding_agent.input`, `coding_agent.output`, and `gen_ai.usage.*` expose the payload and token fields in the shared OTLP exporter. If the agents run on another machine or inside a container, use a Collector URL reachable from that environment. If the existing Collector already forwards to both destinations, follow the [shared Collector setup](docs/setup-agent-observability.md#use-an-existing-collector).

Sign in with your Grafana account. For a local read-only session without sign-in, pass `--anonymous-viewer` to `start-grafana.mjs` when starting Grafana.

## Live test results

On **November 19, 2026**, each ✅ marks a real file-read run whose prompt, tool arguments and result, final response, model token counts, and model → tool → model order were verified in both Langfuse and Grafana Tempo.

| Agent | Windows | macOS (Apple Silicon) | Debian 13 (ARM64) |
| --- | :---: | :---: | :---: |
| Claude Code | ✅ | ✅ | ✅ |
| OpenAI Codex CLI | ✅ | ✅ | ✅ |
| Oh My Pi (OMP) | ✅ | ✅ | ✅ |
| Antigravity CLI (`agy`) | ✅ | ✅ | ✅ |
| OpenCode 1.x | ✅ | ✅ | ✅ |
| GitHub Copilot CLI | ✅ | ✅ | ✅ |
| LangChain Deep Agents SDK | ✅ |  |  |
| Goose | ✅ |  |  |

Windows Antigravity was checked with the laptop’s existing login and hooks. Deep Agents used the SDK callback, and Goose used the native Collector relay. [Verification details](docs/agent-observability.md)

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

## Standalone Python integrations

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

## Agent-driven setup

If you don't want to read installer prompts, hand this repo to an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, ...) and say:

> "Set up Langfuse tracing for my `<tool>`."

The agent can follow [`AGENTS.md`](AGENTS.md) to reuse your local configuration, register hooks, and verify a small trace. If it needs a new Langfuse key, put the key in the local `.env` from the [Quick start](#quick-start).

---

## Choose your tool

| Your situation | Use |
|---|---|
| Daily-driver Claude Code session | [Shared setup script](#2-install-hooks-for-your-agents) |
| Codex CLI standalone | [Shared setup script](#2-install-hooks-for-your-agents) and `/hooks` review |
| Codex CLI through the `oh-my-codex` npm wrapper | `tools/oh-my-codex/` — its installer also registers the Codex native bridge, so a separate `tools/codex/` install is unnecessary |
| OpenCode (any provider: Anthropic, OpenAI, OpenRouter, local LM Studio / Ollama, ...) | `tools/opencode/` |
| Antigravity CLI for Google personal accounts | [Antigravity hooks](ts/README.md#antigravity) |
| Existing Gemini CLI deployment | `tools/gemini-cli/` |

The shared installer accepts multiple agents and reuses a common exporter configuration. Each agent's hook registration lives in its own configuration directory.

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

Depending on the adapter and capture settings, prompt text, responses, file paths, and tool output can be sent to your configured backends.

Recommendations:

- **Self-host Langfuse** if conversations may include proprietary code, internal URLs, secrets, or PII. The cloud `https://cloud.langfuse.com` is convenient but external.
- **Treat `.env` files as secrets** — installers write them with restrictive permissions; don't commit them.
- **`TRACE_TO_LANGFUSE=true` enables the Langfuse exporter.** The shared OTLP exporter uses its own endpoint and enable settings.
- **Fail-open by design**: a hook crash never blocks the host agent. The trade-off is that silent SDK errors can drop traces — check `~/.<tool>/state/langfuse_hook.log` to confirm delivery.

Trace destinations come from the configured Langfuse and OTLP endpoints. The hooks never auto-update themselves and never invoke a system package manager.

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
