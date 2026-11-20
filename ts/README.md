# langfuse-agent-hooks (TypeScript)

Shared Langfuse and OpenTelemetry tracing for **Claude Code**, **Codex CLI**, **Oh My Pi**, and **Antigravity CLI**. The **OpenCode** turn exporter uses this runtime for OTLP. Node.js runs the TypeScript directly.

This is an alternative to the Python hooks under `tools/`. It reads the same credential files (`~/.claude/.env`, `~/.codex/.env`), so you can switch between them freely.

## Why a TypeScript version

| | Python hooks (`tools/`) | TypeScript hooks (`ts/`) |
|---|---|---|
| Runtime | Python 3.8+ + `langfuse` SDK 4.x | Node.js ≥ 22.18 only (runs `.ts` natively) |
| Dependencies | pip / venv | none |
| Transport | Langfuse Python SDK (OTel) | OTLP/HTTP to `/api/public/otel/v1/traces`. The deprecated `/api/public/ingestion` is used only for a server with no OTLP endpoint, or with `LANGFUSE_HOOK_TRANSPORT=legacy` |
| Duplicates on re-send | offset bookkeeping | deterministic ids plus a per-destination delivery record. Legacy ingestion upserts a re-sent turn; over OTLP a confirmed turn is not sent again, because Langfuse v4 keeps both copies |
| Secret redaction | — | built in (Langfuse/OpenAI/Anthropic/GitHub/GitLab/AWS/Slack keys, JWTs, private keys, WireGuard keys, `*_SECRET=` style values) |
| Tool events | `PreToolUse` / `PostToolUse` buffer | reconstructed from the transcript — no per-tool hooks needed |
| Codex | generic transcript parsing | native rollout parser (turn ids, per-response token usage, executed commands) |

## Trace structure

```
trace  "Claude Code - Turn 3"            userId, sessionId, tags [agent, hostname]
└─ agent "Claude Code"                   turn input → final answer
   ├─ generation "Claude (claude-opus-5-5)"   model, usage (incl. cache tokens), output blocks
   ├─ tool "Bash"                              input, output, ERROR level on failure
   ├─ generation …                             input = tool results it received
   └─ event "Notification" / "Permission request"
```

Usage keys follow Langfuse's price tables:
- Claude: `input`, `output`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- Codex: `input` (excl. cached), `input_cached_tokens`, `output` (excl. reasoning), `output_reasoning_tokens`

Each key counts its tokens once, and `total` is their sum. Over OTLP the same object is sent as
`langfuse.observation.usage_details`. The `gen_ai.usage.*` attributes follow OpenTelemetry instead:
`input_tokens` includes cached input and `output_tokens` includes reasoning, with
`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens` and
`gen_ai.usage.reasoning.output_tokens` as breakdowns (the names in the current GenAI conventions). Do not add a breakdown to its total.

## Install

```bash
cd ts
node src/cli.ts install all --dry-run   # preview
node src/cli.ts install all             # or: install claude | install codex
```

This copies `src/` to `~/.local/share/langfuse-agent-hooks/` (so the hooks keep working if you move or delete the repo) and registers hooks, replacing any Python `langfuse_hook.py` entries. Existing files are backed up as `*.bak-<timestamp>`.

| Agent | File | Events |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Stop`, `Notification` (async, exec form — no shell) |
| Codex CLI | `~/.codex/hooks.json` | `UserPromptSubmit`, `PermissionRequest`, `Stop` |

**Codex:** new hooks must be trusted once — run `codex`, type `/hooks`, approve the entries.

## Configure

`~/.claude/.env` and/or `~/.codex/.env` (or `~/.config/langfuse-agent-hooks/.env` for both):

```ini
TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_USER_ID=your-name
```

Optional:

| Variable | Default | |
|---|---|---|
| `LANGFUSE_HOOK_REDACT` | `true` | set `false` to disable secret masking |
| `LANGFUSE_HOOK_MAX_CHARS` | `20000` | per-string truncation (`CC_LANGFUSE_MAX_CHARS` also works) |
| `LANGFUSE_HOOK_DEBUG` | `false` | verbose log (`CC_LANGFUSE_DEBUG` also works) |
| `LANGFUSE_TRACING_ENVIRONMENT` | — | Langfuse environment |
| `LANGFUSE_HOOK_TIMEOUT_MS` | `15000` | HTTP timeout |
| `LANGFUSE_HOOK_TRANSPORT` | `auto` | `auto`: OTLP, with legacy ingestion only if the server has no OTLP endpoint. `otlp`: OTLP only. `legacy`: the deprecated ingestion API only |
| `LANGFUSE_HOOK_CAPTURE_CONTENT` | — | `false` leaves prompt and tool bodies out of the direct OTLP route |
| `CODING_AGENT_SUBAGENTS` | `true` | `false` stops reading Claude Code sub-agent transcripts and Codex spawned-thread rollouts |
| `CODING_AGENT_SUBAGENT_TRACES` | `true` | `false` keeps sub-agent runs only as spans inside the turn, without a trace of their own |
| `LANGFUSE_HOOK_STALE_TURN_MINUTES` | `60` | a turn with no end marker whose transcript has been idle this long is closed and sent with `endedWithoutStop: true`; `0` disables |
| `CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE` | `false` | `true` when the OTLP endpoint is a Collector that also feeds Langfuse; direct export is then refused |
| `LANGFUSE_HOOK_ALLOW_DUAL_ROUTE` | `false` | `true` to send direct and through such a Collector anyway (the project stores each turn twice) |

## Commands

```bash
node src/cli.ts selftest all [--keep]     # claude | codex | omp | all: synthetic turn with a sub-agent, sent, read back, compared, deleted
node src/cli.ts doctor                    # config, destinations, auth check, recent delivery results, hooks, log
node src/cli.ts delivery claude           # turns not confirmed; `delivery claude clear <traceId>` allows a resend
node src/cli.ts verify claude <traceId> [--tempo http://127.0.0.1:13200] [--reconcile]   # read the trace back; settle an unconfirmed turn
node src/cli.ts coverage claude [--since <ISO>] [--deep N]   # local transcripts vs. stored: missing turns, short turns, uncosted model calls
node src/cli.ts backfill claude <file.jsonl> --from <ISO> --to <ISO> [--dry-run]
node src/cli.ts backfill codex  <rollout.jsonl> --from <ISO> --to <ISO> [--session ID] [--dry-run]
node src/cli.ts uninstall all
```

Backfill sends finished turns whose start time is inside the range, skips turns already confirmed, and
reads Langfuse before writing over OTLP. `--dry-run` makes no network request.

Logs: `~/.claude/state/langfuse_agent_hooks.log`, `~/.codex/state/langfuse_agent_hooks.log`.

The hook never writes to stdout and always exits 0 — a tracing failure can't break or block the agent.

## How it works

1. The agent calls `node cli.ts hook <agent>` with a JSON payload on stdin.
2. The transcript is read **from the start of the last turn seen before** (byte offset kept in `<agent home>/state/langfuse_agent_hooks_state.json`), so each run parses only new data.
3. The adapter (`src/adapters/claude.ts`, `src/adapters/codex.ts`) turns transcript lines into agent-neutral `Turn` objects.
4. `src/core/batch.ts` converts turns into ingestion events with deterministic ids, sanitizing every field.
5. `src/core/export.ts` sends each turn to every configured destination and records the outcome per trace and destination in `<agent home>/state/delivery/`. The read offset stops at the first turn a destination still needs, so a failed destination is retried without resending to one that succeeded. A hook failure is logged and never returned to the agent.

Codex without a `transcript_path` in the payload: the rollout is located under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl`; if it can't be found, a minimal trace is built from the payload (`last_assistant_message`).

## Verify call order and monitoring coverage

The Claude and Codex exporters link tool spans to the issuing and consuming generation
with `toolCallId`, `issuedByObservationId`, and `consumedByObservationId`. Timeline warnings
flag duplicate results, results before calls, and missing pairs in completed turns.
Parallel tool spans may overlap. When Codex cannot safely associate a command completion,
it records the ambiguity instead of assigning the command to the first overlapping tool.

```bash
node src/cli.ts audit-langfuse claude --limit 20
node src/cli.ts audit claude <transcript.jsonl>
node src/cli.ts audit codex <rollout.jsonl>
node src/cli.ts audit omp <omp-session.jsonl>
node src/cli.ts audit antigravity <transcript.jsonl>
```

The audits print counts and issue codes. The Langfuse audit also counts model and tool
input/output and model token coverage. It recognizes GenAI attributes in Goose's native
Langfuse spans and counts provider calls once. The audit reads up to the requested number
of traces from the previous 24 hours in the configured project. If a legacy tool span
lacks a call ID, it is counted as reduced coverage. Calls and results still present in
its generation input and output can be correlated. Antigravity's local transcript
exposes step indices, model usage and reported tool calls. The `GENERIC` records
in the tested CLI format do not expose a stable tool-call ID for matching results.

### Oh My Pi extension

```bash
omp -e /absolute/path/to/ts/src/omp-extension.ts
```

The extension reads an explicit tracing configuration from `~/.omp/agent/.env`, the
shared `~/.config/langfuse-agent-hooks/.env`, or the process environment. It sends the
latest turn from the active branch at `agent_end` when `TRACE_TO_LANGFUSE=true`. It
exports token counts, timing, tool IDs and lifecycle warnings. Set
`LANGFUSE_HOOK_CAPTURE_CONTENT=true` to include prompts, responses, and tool bodies.

For regular sessions, add the absolute path to `omp-extension.ts` to the existing
`extensions` list in `~/.omp/agent/config.yml`. With OMP 18.22.2, `--offline` can skip
configured extensions. Pass `-e /absolute/path/to/omp-extension.ts` for an offline probe.
[OMP extension discovery](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)

### Antigravity

```bash
node src/cli.ts install antigravity --dry-run
node src/cli.ts install antigravity
```

The installer merges a named hook into `~/.gemini/config/hooks.json`. Put the Langfuse
configuration in `~/.gemini/antigravity-cli/.env` or the shared
`~/.config/langfuse-agent-hooks/.env` and set `TRACE_TO_LANGFUSE=true`. The native
invocation and tool hooks record timing as work happens. At `Stop`, the exporter joins
tool results to the matching transcript step index and delivers a turn to Langfuse.
Set `LANGFUSE_HOOK_CAPTURE_CONTENT=true` to include prompt, response, and tool bodies.

### OpenCode

The Python exporter groups assistant messages linked to the same user prompt into one
trace. It waits for the terminal assistant message so an intermediate tool call cannot
close the trace early. Model observations include token usage and the tool results passed
to the next generation. Tool observations preserve native call IDs, observed start and
end times, and links to the issuing and consuming generations.

## OpenTelemetry traces

Claude Code, Codex, OMP, Antigravity, Copilot CLI, Deep Agents SDK, and the OpenCode turn exporter can send
OTLP/HTTP JSON traces. Use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` for the complete
traces URL or `OTEL_EXPORTER_OTLP_ENDPOINT` for the base URL. Trace-specific
headers and timeout take precedence over the generic `OTEL_EXPORTER_OTLP_HEADERS`
and `OTEL_EXPORTER_OTLP_TIMEOUT`. Header values can be percent-encoded.
[OTLP specification](https://opentelemetry.io/docs/specs/otlp/)

```dotenv
TRACE_TO_LANGFUSE=true
CODING_AGENT_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
OTEL_CAPTURE_CONTENT=false
```

`CODING_AGENT_OTLP_TRACES_ENDPOINT` selects an endpoint for these hooks without
enabling the host CLI's native OpenTelemetry exporter. Set
`CODING_AGENT_OTLP_ENABLED=false` when the native exporter already covers the same
agent. Langfuse and OTLP can run together or independently. The backend maps each
completed turn to a root span with model and tool spans, including usage, call IDs,
and links from each tool span to its issuing and consuming model spans. Delivery
failures are logged and the agent continues. Replays use stable trace and span IDs.

Set `OTEL_CAPTURE_CONTENT=true` to add redacted, bounded input/output attributes.
OMP and Antigravity also require `LANGFUSE_HOOK_CAPTURE_CONTENT=true` to collect
those bodies at the source. OpenCode uses the shared Node runtime for OTLP turns.
Install the runtime with `node src/cli.ts install` or specify its path in
`OPENCODE_LANGFUSE_OTLP_CLI`. OpenCode lifecycle traces use the existing Langfuse path.

| Destination | Route |
| --- | --- |
| OpenTelemetry Collector | Send to an OTLP HTTP receiver, then configure one or more downstream exporters. [Collector configuration](https://opentelemetry.io/docs/collector/configuration/) |
| Jaeger | Send directly to the OTLP HTTP traces endpoint or through a Collector. [Jaeger write APIs](https://www.jaegertracing.io/docs/latest/apis/) |
| Grafana Tempo | Route traces through a Collector to Tempo's OTLP receiver. [Tempo configuration](https://grafana.com/docs/tempo/latest/configuration/) |
| Honeycomb | Send OTLP HTTP JSON directly or use a Collector. [Honeycomb Collector setup](https://docs.honeycomb.io/send-data/opentelemetry/collector) |
| Datadog | Use a Collector with the Datadog OTLP intake configuration. [Datadog Collector setup](https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/) |

### GitHub Copilot CLI

```bash
node src/cli.ts install copilot
```

The installer adds a user-level `agentStop` hook in `~/.copilot/hooks/`. The hook
reads the current transcript, joins model usage by API call ID, and joins tool
results by tool call ID. Provider system prompts are outside transcript coverage.
Put exporter settings in `~/.copilot/.env`. The Windows hook uses PowerShell 7.
[Copilot user hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)

### Deep Agents SDK and Goose

For Python, attach the [Deep Agents callback](../tools/deepagents/README.md) to
the run config. For Goose, use the native [Collector route](../docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector).

The [example Collector](../docs/examples/collector.yaml) writes traces to a rotating
local OTLP JSON file. Port `14318` stores traces already sent to Langfuse by the
hooks. Port `14320` also forwards native Goose traces to Langfuse. The optional
`CODING_AGENT_COLLECTOR_LAUNCHER` setting starts the Collector on demand. Copy the
[launcher](../docs/examples/start-collector.mjs), Collector binary, and YAML into
the deployed hook runtime's `collector/` directory. Provide the Langfuse project
credentials through the local configuration.

OpenTelemetry describes and transports spans. To browse them in a dashboard, route
the Collector to that dashboard's storage backend. The local `file` exporter writes
JSON records for inspection and replay.

## Additional agent candidates

See the [coding agent compatibility matrix](../docs/agent-observability.md) for live
results from Copilot CLI, Goose, and Deep Agents, plus integration paths for other
agents. The shared Google path uses Antigravity CLI. The standalone Gemini CLI
adapter remains available for existing deployments.

## Develop

```bash
npm install          # dev only: typescript + @types/node
npm test             # node:test, fixtures under test/fixtures
npm run typecheck
```

`test/fixtures/codex-rollout.jsonl` is a real Codex 0.167 rollout with system prompts and paths removed.

## Roadmap

- Claude Code subagent transcripts as nested agent observations
- Gemini CLI adapter
