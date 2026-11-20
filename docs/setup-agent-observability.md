# Install coding agent hooks on Windows, macOS, and Linux

Use Node.js 22.18 or later. Install the agents you plan to trace. OpenCode needs
Python 3.10 or later with `venv` and `ensurepip`. macOS may provide an older
system Python. Pass `--python /path/to/python3` if needed. On Debian, install the
`python3-venv` package for the system interpreter. Select the Python interpreter
used by the Deep Agents application when installing its callback.

## Install hooks and choose a trace identity

Run from the repository root. Supply Langfuse credentials through the process
environment or an existing local Langfuse `.env`. The setup copies existing keys
to shared local settings when those keys are missing there.

```powershell
# Windows, PowerShell 7
./scripts/setup.ps1 --agents 'claude,codex,omp,antigravity,copilot,opencode'
```

```sh
# macOS or Linux
sh scripts/setup.sh --agents claude,codex,omp,antigravity,copilot,opencode
```

On a terminal the script asks for a trace user name. A blank answer uses the last
component of the user's home directory. `--name` sets it explicitly for automation.
Use `--device` for a machine label and `--environment` for labels such as `local` or
`ci`. The shared configuration lives at `~/.config/langfuse-agent-hooks/.env`.

The shared runtime adds hostname, OS type and release, architecture, logical CPU
count, and RAM to Langfuse trace metadata and OTLP resource attributes. Each adapter
reports the fields available in its runtime. `CODING_AGENT_DEVICE_METADATA=false`
disables the shared runtime's additional hardware attributes. `--capture-content`
enables bodies for sources that support configurable capture. Native exporters can
have their own capture and device metadata settings.

New or changed Codex hook definitions require review in `/hooks`. OMP's native
extension discovery applies to normal invocations. OpenCode uses the 1.x plugin
surface. For SDK applications, select `--agents deepagents --python /path/to/python`
and [add the callback to the run configuration](../tools/deepagents/).

For a headless Antigravity CLI run using the Gemini API, set
`"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and
export `GEMINI_API_KEY` in the shell that launches `agy`.
[Antigravity CLI authentication](https://antigravity.google/docs/install?tab=cli#using-a-gemini-api-key)

## GitHub repository, commit, and pull request

The shared hooks attach the GitHub `origin` URL, checked-out commit SHA and
commit URL, and the branch when available. Run the agent in the repository
checkout you want to trace. The exported URL excludes remote credentials and
query strings.

For a pull request, the runtime uses a matching GitHub Actions checkout
(`GITHUB_REPOSITORY`, `GITHUB_SHA` and `GITHUB_REF`) or queries GitHub with an
authenticated `gh` CLI. A local lookup selects a single PR whose head or merge
commit matches the checked-out SHA. A missing or ambiguous match leaves the PR
fields empty. The trace still exports when Git or GitHub is unavailable.

Open the trace metadata in Langfuse and look for `github`. In Grafana, open the
root agent span and look for `vcs.repository.url.full`, `vcs.ref.head.revision`,
`vcs.change.id`, and `github.pull_request.url`. You can search in Tempo with
`{ span.github.repository = "owner/repo" && span.vcs.change.id = "123" }`.
[OpenTelemetry VCS attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/)

Set `CODING_AGENT_GITHUB_PR_LOOKUP=false` to disable the GitHub API request.
Set `CODING_AGENT_GITHUB_METADATA=false` to disable all GitHub fields. The
standalone Langfuse integrations and historical transcript backfill retain
their existing metadata behavior. OpenCode's turn exporter uses the installed
shared Node runtime to obtain GitHub context.

Native OTLP exporters such as Goose can take the same fields as resource
attributes. Run the command from the checkout before starting the agent.
In Tempo search, use `resource.github.repository` and `resource.vcs.change.id`
for this route.

```sh
github_attrs=$(node /path/to/langfuse-coding-agents/ts/src/cli.ts github-context --otlp)
if [ -n "$github_attrs" ]; then
  export OTEL_RESOURCE_ATTRIBUTES="${OTEL_RESOURCE_ATTRIBUTES:+$OTEL_RESOURCE_ATTRIBUTES,}$github_attrs"
fi
```

```powershell
$githubAttrs = node C:/path/to/langfuse-coding-agents/ts/src/cli.ts github-context --otlp
if ($githubAttrs) {
  $env:OTEL_RESOURCE_ATTRIBUTES = (@($env:OTEL_RESOURCE_ATTRIBUTES, $githubAttrs) | Where-Object { $_ }) -join ','
}
```

## Send to Tempo and Langfuse

The [Collector example](examples/collector.yaml) has one receiver per route.

| Receiver | From | Forwards to | Langfuse reached by |
|---|---|---|---|
| `14318` | shared hooks | local file, Tempo | the hooks, directly |
| `14319` | shared hooks | local file, Langfuse, Tempo | the Collector |
| `14320` | native Goose | local file, Langfuse, Tempo | the Collector |

Pick `14318` or `14319` for the shared hooks. `14318` is the default: the hooks
send to Langfuse themselves, using `LANGFUSE_HOOK_TRANSPORT` from the
[quick start](../README.md#quick-start). With `--collector-route both` the hooks
send only to `14319`, and setup sets `TRACE_TO_LANGFUSE=false` and
`CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE=true` so a project is not sent each turn
twice. If both are left on, the hook reports a configuration error and skips the
direct route. `--collector-route tempo` restores the default, and each setup run
that changes the settings saves the previous file as `.env.bak-<timestamp>`.

Do not point the shared hooks at `14320`. That pipeline fills in missing resource
attributes (`user.id`, OS, architecture) with the Collector host's values, which
is right for a local Goose process and wrong for hook spans arriving from another
user or machine. On `14319` the Langfuse exporter adds
`x-langfuse-ingestion-version: 4`; the Tempo exporter carries no Langfuse header
or credential on any route.

The hook treats a Collector's 2xx as "accepted by a relay", not as stored. The
Collector retries from an in-memory queue, so spans it accepted are lost if it
stops before delivering them. Add a persistent queue if you need that guarantee;
this repository has not tested one. Confirm storage with
`node ts/src/cli.ts verify <agent> <traceId> --tempo http://127.0.0.1:13200`.

Supply an existing OpenTelemetry Collector binary with the `file`, `resource`, and
`otlp_http` components. `--tempo` accepts the complete Tempo OTLP HTTP URL.

```powershell
./scripts/setup.ps1 --collector 'C:\path\otelcol.exe' --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

```sh
sh scripts/setup.sh --collector /path/to/otelcol --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

Restart an existing Collector after changing its YAML. The shared hooks can start
the deployed example Collector on demand. Follow the [Goose exporter setup](agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector)
to route native Goose telemetry through port `14320`.

For a loopback dashboard with existing Grafana and Tempo binaries:

```sh
node scripts/start-grafana.mjs --tempo /path/to/tempo --grafana /path/to/grafana-home
```

On Windows, pass the path to `tempo.exe` and the Grafana archive's extracted home
directory. The launcher binds both services to loopback. `--anonymous-viewer` enables
local read-only dashboard access without a login.

For manual setup, start Tempo with
[tempo.yaml](examples/grafana/tempo.yaml), and set Grafana's provisioning path to
[`examples/grafana/provisioning`](examples/grafana/provisioning). Set
`CODING_AGENT_GRAFANA_DASHBOARDS` in Grafana's environment to the absolute path of
[`examples/grafana/dashboards`](examples/grafana/dashboards), then restart Grafana.
The Tempo data source queries port `13200`. Open the **Coding agent traces** dashboard,
then use a trace ID to inspect individual model and tool spans. `coding_agent.input`
and `coding_agent.output` hold the shared exporters' captured bodies. Native exporters
such as Goose use `gen_ai.input.messages`, `gen_ai.output.messages`, and tool attributes.

### Use an existing Collector

When an existing Collector routes traces to both Langfuse and Tempo, put these
settings in the agent user's `~/.config/langfuse-agent-hooks/.env` and install
with the platform wrapper above. Keep the Langfuse project credentials on the
Collector. The Collector URL must be reachable from the agent's own host or container.

```dotenv
TRACE_TO_LANGFUSE=false
CODING_AGENT_OTLP_TRACES_ENDPOINT=https://collector.example.com/v1/traces
CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE=true
```

Use the full OTLP/HTTP traces URL for the receiver that forwards to both services.
For the repository's Collector example, this is the receiver on port `14319`.
On that Collector, send Langfuse the `x-langfuse-ingestion-version: 4` header for
this pipeline, as the example's `otlp_http/langfuse-v4` exporter does.
The `14318` receiver forwards to Tempo and the local file. If you use that
receiver, enable direct Langfuse export and configure the project keys on the
agent host as described in the [quick start](../README.md#quick-start).

## Delivery state, retries, and backfill

Each turn's delivery is recorded per destination under
`<agent home>/state/delivery/`, apart from the transcript read position. The
records hold trace IDs, span IDs, content hashes and status, and no prompt text
or credentials.

| Status | Meaning | Next run |
|---|---|---|
| `confirmed` | the destination accepted every span | not sent again |
| `failed`, `partial` | the destination refused some or all spans | the refused spans are retried |
| `unconfirmed` | timeout, lost response, or an OTLP partial rejection | held until you decide |

Langfuse v4 and Tempo keep both copies when a span ID is sent twice, so an
`unconfirmed` turn is not resent on its own. Read it back with `verify`. If it is
missing, `node ts/src/cli.ts delivery <agent> clear <traceId>` lets the next run
send it. Legacy ingestion upserts by ID, so that route simply retries.

A final response that reaches the transcript after the Stop event is sent as a
new span on the next hook run. A span that changed after it was accepted cannot
be updated in Langfuse v4; `delivery <agent>` lists it under `changed-after`.

To resend a gap, backfill a transcript for an explicit time range. It sends
finished turns only, skips turns already confirmed locally, and reads Langfuse
before writing so a stored turn is not duplicated. Start with `--dry-run`, which
makes no network request.

```sh
node ts/src/cli.ts backfill claude /path/to/transcript.jsonl --from 2026-11-16T00:00:00Z --to 2026-11-17T00:00:00Z --dry-run
```

For a smoke test, install with `--capture-content` and use a synthetic
`probe.txt` containing a unique marker. Ask the agent to read the file with
its file-reading tool and return the exact contents. Find the trace in Langfuse
and use the same trace ID in Grafana. Check that the issuing model span ends
before the tool span begins and the next model span begins after the tool ends.
Compare the prompt, file path, result, final response, and both model calls'
input and output token counts. The shared exporter sends captured bodies in
the Langfuse observation input and output fields and in the Grafana span
attributes `coding_agent.input` and `coding_agent.output`.

## Agent setup checklist

1. Read the user's existing agent and exporter configuration. Reuse configured
   credentials in process memory and preserve unrelated user hooks and plugins.
2. Ask for the trace user name. An empty answer selects the home-folder default.
3. Run the platform setup wrapper for the selected agents. Check Codex hook trust
   and whether each installed version supports the indicated integration.
4. Run a read-only synthetic file probe containing a unique marker. Look up its
   trace in the configured Langfuse project and in Tempo through Grafana.
5. Verify the prompt, tool arguments/result, final response, per-call token fields,
   tool call ID, and timing. Report coverage gaps at the affected layer.
