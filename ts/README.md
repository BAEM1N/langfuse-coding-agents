# langfuse-agent-hooks (TypeScript)

Zero-dependency Langfuse tracing for **Claude Code** and **Codex CLI**, written in TypeScript and run directly by Node.js (no build step, no `node_modules` at runtime).

This is an alternative to the Python hooks under `tools/`. It reads the same credential files (`~/.claude/.env`, `~/.codex/.env`), so you can switch between them freely.

## Why a TypeScript version

| | Python hooks (`tools/`) | TypeScript hooks (`ts/`) |
|---|---|---|
| Runtime | Python 3.8+ + `langfuse` SDK 4.x | Node.js ≥ 22.18 only (runs `.ts` natively) |
| Dependencies | pip / venv | none |
| Transport | Langfuse Python SDK (OTel) | Langfuse public ingestion API (`/api/public/ingestion`) |
| Duplicates on re-send | offset bookkeeping | deterministic ids → re-sending a turn **upserts** it |
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

## Commands

```bash
node src/cli.ts doctor                    # config, auth check, registered hooks, recent log
node src/cli.ts backfill claude <file.jsonl> [--dry-run]   # send (or preview) a whole transcript
node src/cli.ts backfill codex  <rollout.jsonl> [--session ID] [--dry-run]
node src/cli.ts uninstall all
```

Logs: `~/.claude/state/langfuse_agent_hooks.log`, `~/.codex/state/langfuse_agent_hooks.log`.

The hook never writes to stdout and always exits 0 — a tracing failure can't break or block the agent.

## How it works

1. The agent calls `node cli.ts hook <agent>` with a JSON payload on stdin.
2. The transcript is read **from the start of the last turn seen before** (byte offset kept in `<agent home>/state/langfuse_agent_hooks_state.json`), so each run parses only new data.
3. The adapter (`src/adapters/claude.ts`, `src/adapters/codex.ts`) turns transcript lines into agent-neutral `Turn` objects.
4. `src/core/batch.ts` converts turns into ingestion events with deterministic ids, sanitizing every field.
5. One batched POST to `/api/public/ingestion`. State advances only on success.

Codex without a `transcript_path` in the payload: the rollout is located under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl`; if it can't be found, a minimal trace is built from the payload (`last_assistant_message`).

## Develop

```bash
npm install          # dev only: typescript + @types/node
npm test             # node:test, fixtures under test/fixtures
npm run typecheck
```

`test/fixtures/codex-rollout.jsonl` is a real Codex 0.167 rollout with system prompts and paths removed.

## Roadmap

- pi / oh-my-pi adapter (TypeScript extension that reuses `src/core`)
- Claude Code subagent transcripts as nested agent observations
- Gemini CLI / OpenCode adapters
