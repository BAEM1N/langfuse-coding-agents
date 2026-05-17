# Hook Event Matrix

Side-by-side mapping of hook events across the 5 supported agents. Use this to understand which lifecycle moments each agent exposes and how `langfuse-coding-agents` adapts them into a common trace structure.

## Quick comparison

| Lifecycle moment | Claude Code | Codex CLI | oh-my-codex | OpenCode | Gemini CLI |
|---|---|---|---|---|---|
| Session begins | — | `SessionStart` | `session-start` | session start event | `SessionStart` |
| User prompt submitted | — | `UserPromptSubmit` | `user-prompt-submit` | event-stream item | `BeforeAgent` |
| Before model call | (transcript) | (transcript) | (transcript) | (event-stream) | `BeforeModel` |
| Tool about to run | `PreToolUse` | `PreToolUse` | `pre-tool-use` | (event-stream) | `BeforeTool` (+ `BeforeToolSelection`) |
| Permission required | — | `PermissionRequest` | `permission-request` | — | — |
| Tool finished | `PostToolUse` | `PostToolUse` | `post-tool-use` | (event-stream) | `AfterTool` |
| After model returns | (transcript) | (transcript) | (transcript) | (event-stream) | `AfterModel` |
| Turn complete | `Stop` | `Stop` | `turn-complete` | message.updated (assistant) | `AfterAgent` |
| Notification | `Notification` | — (use `PermissionRequest`) | — | — | `Notification` |
| Pre-compaction | — | `PreCompact` | `pre-compact` | — | `PreCompress` |
| Post-compaction | — | `PostCompact` | `post-compact` | — | — |
| Session ends | — | — | — | session end event | `SessionEnd` |
| **Total events** | **4** | **6–8** | **8** | **event-stream** | **11** |

Legend:
- "(transcript)" — the agent does not emit a discrete pre/post-model event, but the same information is recoverable by reading the transcript JSONL on `Stop` / `turn-complete`.
- "(event-stream)" — OpenCode emits a continuous event stream rather than discrete lifecycle hooks; the JS plugin filters and forwards relevant items.
- "—" — the agent does not expose this lifecycle moment at all.

## Hook config location per agent

| Agent | Config path | Format |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | JSON with `hooks` top-level field |
| Codex CLI | `~/.codex/hooks.json` | JSON, top-level `{"hooks": {...}}` (separate file from `config.toml`) |
| oh-my-codex | `~/.omx/hooks/` (auto-discovered) + optional `~/.codex/hooks.json` bridge for direct Codex hook usage | filesystem layout |
| OpenCode | `~/.config/opencode/plugins/langfuse_plugin.js` | JS plugin that forwards to a Python hook |
| Gemini CLI | `~/.gemini/settings.json` | JSON with `hooks` top-level field |

## Payload key convention

| Field | Claude Code | Codex CLI | OMX (via bridge) | OpenCode | Gemini CLI |
|---|---|---|---|---|---|
| Event name | `hook_event_name` | `hook_event_name` (snake_case) or `hookEventName` (camelCase fallback) | normalized via bridge | inferred from event item | `hook_event_name` |
| Session id | `session_id` | `session_id` / `sessionId` | normalized | `session.id` | `session_id` |
| Tool name | `tool_name` | `tool_name` / `toolName` | normalized | tool item field | `tool_name` |
| Tool input | `tool_input` | `tool_input` / `toolInput` | normalized | tool item field | `tool_input` |
| Tool result | `tool_response` | `tool_response` / `tool_output` / `toolOutput` | normalized to `tool_response` | tool item field | `tool_response` |
| Prompt | `prompt` (on UserPromptSubmit, where present) | `prompt` | `prompt` | message.updated user payload | `prompt` |
| Transcript path | `transcript_path` | `transcript_path` / `transcriptPath` (often absent — fallback active) | normalized | n/a (event stream is authoritative) | `transcript_path` |
| Last assistant msg | n/a (read from transcript) | `last_assistant_message` (when transcript absent) | normalized | message.updated assistant payload | n/a (read from transcript) |

The Codex adapter inlines a `KEY_ALIASES` table to translate camelCase keys into the snake_case names the common pipeline expects. The same table lives in oh-my-codex's `codex-native-bridge.py`; v0.2 will pull both into a shared `core/` module.

## Tracing strategy per agent

| Agent | Strategy | Notes |
|---|---|---|
| Claude Code | Transcript-based turn assembly | `Stop` triggers transcript parsing; `PreToolUse`/`PostToolUse` buffer for span enrichment |
| Codex CLI | Transcript-based + fallback | If `transcript_path` is absent or missing, emit a minimal `Stop` trace with buffered tool events + `last_assistant_message` |
| oh-my-codex | OMX-native events; native-bridge forwards Codex hook payloads | Same downstream pipeline as Claude Code |
| OpenCode | Event-stream reassembly | JS plugin buffers per-turn events and emits at `message.updated` (assistant) |
| Gemini CLI | Explicit per-event capture | `AfterAgent` is the trace-emit point; everything else buffers; `SessionEnd` flushes |

## When in doubt

If your agent fires an event that isn't in this matrix yet, the adapter falls back to emitting a single-span trace tagged with the raw event name. File an issue or PR against [`langfuse-coding-agents`](https://github.com/BAEM1N/langfuse-coding-agents) and we'll fold it in.
