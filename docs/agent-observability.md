# Coding agent observability and hook compatibility

Use this matrix to choose between application hooks, native OpenTelemetry, a CLI
event stream, or SDK instrumentation. A file-read probe checks that the prompt,
tool arguments, tool result, final answer, and model token counts reach the stated
surface. Tool order is checked by call ID and timestamps. The CLI probes use local
synthetic files and ordinary agent execution paths.

## Live verification

On November 19, 2026, Claude Code, OpenAI Codex CLI, OMP, Antigravity CLI, and
OpenCode 1.x each ran a file-read probe on macOS (Apple Silicon) and Debian 13
(ARM64). For each run, Langfuse and the Grafana Tempo data source returned
matching model input and output token counts, the prompt, tool arguments and
result, and final response. The model and tool timestamps agreed with the tool
call IDs. Claude Code, Codex, OMP, and OpenCode used LiteLLM. Antigravity used
the Gemini API.

Results below were verified on Windows on November 19, 2026. A signal observed in
an event stream or SDK result is listed separately from a signal verified at a trace
destination.

| Agent and surface | Model and tool input/output | Tokens | Tool order and destination |
| --- | --- | --- | --- |
| Google Antigravity CLI 1.5.11 | Prompt, tool arguments/result, final response | Input/output for both model calls | Native hook and transcript step index linked two generations and one tool in Langfuse and an OpenTelemetry Collector. |
| Claude Code, OpenAI Codex CLI, OMP, OpenCode 1.x | Prompt, tool arguments/result, final response | Model input/output | Shared pipeline verified in Langfuse and an OpenTelemetry Collector. See the [runtime guide](../ts/README.md). |
| GitHub Copilot CLI 1.0.114 | Prompt, tool arguments/result, and final response from the transcript exposed by `agentStop` | Per-model-call usage from `session.usage_record`, matched by API call ID | The installed user hook exported the model → tool → model sequence to Langfuse and the Collector. [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference) |
| Goose 1.60.1 | Native OTLP includes model messages and tool arguments/result with content capture enabled | Model input/output and cache fields in OTLP | Collector → Langfuse OTLP preserved both model calls and tool order. Goose's separate direct Langfuse integration delivered partial final-call coverage in the short probe. [Goose OpenTelemetry](https://goose-docs.ai/docs/guides/environment-variables/#observability-configuration) · [Goose Langfuse](https://goose-docs.ai/docs/tutorials/langfuse/) |
| LangChain Deep Agents SDK 0.7.40, Python | Human/AI/tool/AI messages and actual tool arguments, result and response | `usage_metadata` on both AI messages | The [callback](../tools/deepagents/) exported the full sequence and matched tool call ID to Langfuse and the Collector. [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) |
| Cursor CLI `2026.11.19-f005e9d` | Local probe stopped at authentication | Unverified | The documented hook surface includes tool hooks and `afterAgentResponse`. [Cursor hooks](https://cursor.com/docs/hooks) |
| Kiro CLI 3.5.0 | Local probe stopped at authentication | Unverified | Use the V3 harness and record tool hooks with headless `stream-json` after login. [Kiro CLI](https://kiro.dev/docs/cli/) · [Kiro hooks](https://kiro.dev/docs/hooks/) |

## Integration routes to evaluate

| Agent | Signal source | Integration boundary |
| --- | --- | --- |
| Gemini CLI (legacy) | `BeforeModel`, streamed `AfterModel`, `BeforeTool`, and `AfterTool` | Keep the existing Langfuse integration for compatible deployments. Use `agy` for migrated personal accounts. [Google migration](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) · [Gemini hook schemas](https://geminicli.com/docs/hooks/reference/) |
| Qwen Code | Prompt, tool, batch, message stream, and stop/failure hooks | Use `tool_use_id` and provider `tool_call_id` when present. Use `submitted_prompt` for a fresh user prompt when available. Verify usage independently from the transcript or provider. [Qwen Code hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) |
| Deep Agents Code | Terminal agent built on the Deep Agents SDK | The SDK probe applies to the harness. Check the CLI's event and callback boundaries before reusing it as a CLI integration. [Deep Agents ecosystem](https://docs.langchain.com/oss/javascript/deepagents/overview) |
| Factory Droid | Native OpenTelemetry in `droid.*` and GenAI formats | Prefer its native exporter. Configure message-content capture and verify how the selected format maps to the destination. [Droid telemetry reference](https://docs.factory.com/enterprise/telemetry/data-reference) |
| OpenHands | Conversation trajectory and event API | Preserve source event IDs, tool action/observation pairs, and retries. Test model provider usage separately. [OpenHands trajectory API](https://docs.openhands.dev/api-reference/get-trajectory) |
| Aider | Chat history, optional model message logging, and token reporting | Associate model usage with turns and test edit outcomes from the repo. Shell or MCP causality requires explicit evidence. [Aider options](https://aider.chat/docs/config/options.html) |
| Cline | Task history and IDE workflow | Check model usage and stable tool IDs in the installed task schema before writing a local transcript adapter. [Cline tasks](https://docs.cline.bot/core-workflows/task-management) |
| oh-my-codex (OMX) | Existing Langfuse bridge and native Codex hooks | Verify one emitted turn per execution when both layers are enabled. [OMX bridge](../tools/oh-my-codex/) |

For an agent with native OTLP, start with a direct Collector route and measure its
payload before adding a hook. For a hook-only agent, use the stable session and tool
IDs to join evidence across events. SDK agents can expose tool results and token
usage through callbacks or middleware. Keep session-level counters at session scope
when the source does not expose per-generation usage.

### Goose to Langfuse through an OpenTelemetry Collector

Point Goose's native OTLP exporter at your Collector. Configure the Collector's
`otlp_http` exporter with `traces_endpoint` set to the Langfuse
`/api/public/otel/v1/traces` URL and Basic auth from your project's keys. This route
was verified with both model responses, the file read tool result, and model token
usage. The [Langfuse audit](../ts/README.md#verify-call-order-and-monitoring-coverage)
joins provider and tool events by ID and counts the provider calls once.
[Langfuse OpenTelemetry endpoint](https://langfuse.com/integrations/native/opentelemetry)

For the [local Collector example](examples/collector.yaml), set these in the Goose
process environment. Remove direct Langfuse credentials from that process when
using the Collector relay to avoid sending duplicate traces.

```dotenv
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:14320/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_TRACES_EXPORTER=otlp
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```
