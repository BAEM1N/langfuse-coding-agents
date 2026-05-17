# Agent Setup Guide — langfuse-coding-agents (monorepo)

This file briefs an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, etc.) on how to wire **Langfuse** tracing into a user's AI coding tool stack from this single monorepo.

It supersedes the five previously-standalone repos. Every supported tool now lives under `tools/<tool>/` and shares the same Langfuse 4.x compatibility layer.

---

## When to use which sub-tool

| User's tool | Install path | Captures |
|---|---|---|
| **Claude Code** | `tools/claude-code/install.sh` | 4 events (Stop, Notification, PreToolUse, PostToolUse) → turns, tool calls, thinking, tokens |
| **Codex CLI 0.128+** (standalone) | `tools/codex/install.sh` | 6 events via native `~/.codex/hooks.json` (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop) |
| **oh-my-codex (OMX)** wrapper | `tools/oh-my-codex/install.sh` | 8 OMX events + Codex native bridge (covers Codex CLI when invoked through OMX) |
| **OpenCode** | `tools/opencode/install.sh` | event-stream plugin (`session.created` / `message.updated` / `message.part.updated` / `session.idle` / `session.error` / `session.compacted`) |
| **Gemini CLI** | `tools/gemini-cli/install.sh` | 11 events (full lifecycle from SessionStart → SessionEnd, including all agent/model/tool phases) |

**Codex vs oh-my-codex**: if the user already drives Codex through `oh-my-codex` (npm wrapper), `tools/oh-my-codex/` registers the bridge in `~/.codex/hooks.json` and reuses the same Python hook — no separate `tools/codex/` install needed. Only install `tools/codex/` if the user runs `codex` *without* OMX.

---

## Setup procedure

### Step 1 — confirm prerequisites

```bash
python3 --version      # 3.8+
python3 -m pip --version
```

The installer pins `langfuse>=4.0` (currently 4.6.x). Older Langfuse 3.x SDKs also work; both code paths are exercised by the same hooks via a compatibility shim — see *SDK 4.x notes* below.

### Step 2 — clone the monorepo

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents
```

### Step 3 — run the installer for the user's tool

```bash
cd tools/<tool>          # one of: claude-code, codex, oh-my-codex, opencode, gemini-cli
bash install.sh          # Windows: ./install.ps1
```

Each installer is interactive: it asks for `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, and `LANGFUSE_USER_ID`. If the user has these in an env file already, surface them in the prompt rather than asking again.

### Step 4 — credentials

The installer writes a tool-scoped `.env`:

| Tool | `.env` path |
|---|---|
| claude-code | `~/.claude/.env` |
| codex | `~/.codex/.env` |
| oh-my-codex | `~/.omx/.env` |
| opencode | `~/.config/opencode/.env` |
| gemini-cli | `~/.gemini/.env` |

Required keys:

```env
TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com    # or self-hosted, e.g. https://lf.example.com
LANGFUSE_USER_ID=<arbitrary string for trace attribution>
```

**Precedence rule (important)**: the hook reads `os.environ` first, then falls back to the tool's `.env`. If a parent shell already exports `LANGFUSE_USER_ID=alice`, the per-tool `.env` value is ignored. For per-tool user segmentation (e.g. `BAEM1N-opencode` vs `BAEM1N-gemini`), instruct the user to `unset LANGFUSE_USER_ID` in the shell that launches the tool, or to override explicitly when invoking the tool.

### Step 5 — verify

After running the tool once, traces should appear at `${LANGFUSE_BASE_URL}/traces`. The hooks also write a local log; useful when debugging:

| Tool | Log path | State path |
|---|---|---|
| claude-code | `~/.claude/state/langfuse_hook.log` | `~/.claude/state/langfuse_state.json` |
| codex | `~/.codex/state/langfuse_hook.log` | `~/.codex/state/langfuse_state.json` |
| oh-my-codex | (stderr only) | `~/.omx/hooks/langfuse_state.json` |
| opencode | `~/.config/opencode/state/langfuse/langfuse_hook.log` | `~/.config/opencode/state/langfuse/state.json` |
| gemini-cli | `~/.gemini/state/langfuse_hook.log` | `~/.gemini/state/langfuse_state.json` |

Quick API check (replace credentials):

```bash
curl -sS -u "<PK>:<SK>" "https://lf.ddok.ai/api/public/traces?limit=5"
```

---

## Architecture

Each hook is a single Python script (`langfuse_hook.py`). The runtime layout:

```
<tool-runtime>           → spawns subprocess        → langfuse SDK
  events on stdin                  Python hook            HTTP egress
                                                          ↓
                                                       Langfuse
```

For OpenCode there is one extra hop: a Node plugin (`langfuse_plugin.js`) forwards `event` stream payloads to the Python hook over stdin.

All hooks share:

- **Fail-open** design — a hook crash never blocks the host tool.
- A `TRACE_TO_LANGFUSE=true` runtime gate.
- A persistent `langfuse_state.json` for dedup across restarts.
- A turn-reconstruction layer that consolidates fine-grained events (e.g. `message.part.updated`, `AfterModel`) into a single `Turn` trace.

See `docs/hook-event-matrix.md` for the full per-tool event mapping.

---

## SDK 4.x notes (critical when modifying hooks)

Langfuse Python SDK 4.0 broke two APIs the hooks were originally written against:

1. **`Langfuse.start_as_current_span(...)` → removed.** Replaced by `start_as_current_observation(name=..., as_type="span", ...)`. All 5 hooks were migrated in commit `8f2db84`.
2. **`Langfuse.update_current_trace(...)` → removed.** Replaced by the module-level `propagate_attributes(...)` context manager. Hooks install a class-level shim at import time (commit `b08d2ca`) so the existing `client.update_current_trace(...)` call sites translate transparently to `propagate_attributes` enter/exit.

The shim is opt-in: it only activates when the installed SDK lacks `update_current_trace`. Hooks therefore stay compatible with Langfuse 3.x deployments unchanged.

**If you add a new call site**, prefer `start_as_current_observation(..., as_type="span")` directly and skip `update_current_trace` — write trace attributes through `langfuse.propagate_attributes(session_id=..., user_id=..., tags=...)` instead.

---

## Repo conventions

- Single source of truth: `tools/<tool>/langfuse_hook.py`. Local installs are file copies — when patching, edit here and re-run `install.sh` (or `cp` manually).
- Per-tool `AGENTS.md` lives at `tools/<tool>/AGENTS.md` and contains tool-specific procedures. This root `AGENTS.md` is the umbrella entry point.
- Per-tool `README.md` / `README.ko.md` is user-facing documentation.
- `docs/hook-event-matrix.md` documents the lifecycle events captured per tool — keep it in sync when adding new hook coverage.

---

## Common failure modes the agent should recognise

| Symptom | Likely cause | Fix |
|---|---|---|
| Hook log shows `Processed in X.Xs` but Langfuse has no trace for that session | SDK 4.x AttributeError silently swallowed | Confirm `langfuse_hook.py` contains `start_as_current_observation` AND `_Langfuse_class_for_compat` shim; if not, re-sync from monorepo. |
| Traces arrive without `session_id` / `user_id` / `tags` | `update_current_trace` no-oping on SDK 4.x without the shim | Same fix as above. |
| Trace `userId` is wrong per-tool | Shell env `LANGFUSE_USER_ID` shadows the tool's `.env` | `unset LANGFUSE_USER_ID` in the launching shell or override at invocation. |
| Codex CLI runs but no trace | `~/.codex/hooks.json` not trusted (Codex 0.128+ trust model) | User must run `codex` once and accept the hook trust prompt, or pre-seed `trusted_hash` entries. |
| OpenCode `model not loaded` from LM Studio | LM Studio auto-unloaded model | User must reload model in LM Studio UI before invoking via OpenCode. |

---

## License

MIT. See `LICENSE`.
