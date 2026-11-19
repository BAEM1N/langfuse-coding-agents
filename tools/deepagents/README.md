# Deep Agents tracing with Langfuse and OpenTelemetry

Add the callback to a Python Deep Agents SDK invocation. The callback captures
model and tool timing and call IDs, and exports completed turns through the shared
Node.js runtime. Use a fresh callback per invocation. Reuse a session ID across
turns to group them in Langfuse.

```bash
python -m pip install ./tools/deepagents
node ts/src/cli.ts install
```

```python
from agent_observability import DeepAgentsObserver

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Read probe.txt"}]},
    config={"callbacks": [DeepAgentsObserver(session_id="my-conversation")]},
)
```

Add the observer to the run config alongside any existing callbacks. Put exporter
settings in `~/.config/deepagents-observability/.env` or the shared configuration
directory. Set `CODING_AGENT_HOOKS_CLI` when the runtime is installed in a different
location. [Exporter configuration](../../ts/README.md#opentelemetry-traces)
