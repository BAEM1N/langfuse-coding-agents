# 编程代理可观测性 · Langfuse 与 OpenTelemetry

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## 项目简介

采集 Claude Code、Codex CLI、Oh My Pi（OMP）、Antigravity CLI、OpenCode 1.x、GitHub Copilot CLI、Deep Agents SDK 和 Goose 的链路。在 Langfuse 或 Grafana 中查看模型输入输出、令牌用量和工具调用顺序。可采集的字段取决于代理及采集设置。[兼容性与实测结果](docs/agent-observability.md)

## 安装和配置

### 配置 Langfuse

先安装 Node.js 22.18 或更高版本及要观测的编程代理。OpenCode 需要 Python 3.10 或更高版本，并支持 `venv` 和 `ensurepip`。如果默认 Python 版本较旧，请用 `--python /path/to/python3` 指定解释器。在 Windows 上使用 Copilot CLI 命令钩子时，请使用 PowerShell 7。

```sh
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents
```

创建 `~/.config/langfuse-agent-hooks/.env`。Windows 路径为 `%USERPROFILE%\.config\langfuse-agent-hooks\.env`。将下面的地址和密钥替换为你的 Langfuse 项目配置。安装脚本可以复用已有的本地密钥。

```dotenv
TRACE_TO_LANGFUSE=true
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-key
```

共用 Node 运行时通过 Langfuse 支持的 OTLP（`/api/public/otel/v1/traces`）发送数据。自 2026-11-16 起，Langfuse Cloud 不再保存发送到 `/api/public/ingestion` 的链路事件，自托管 v4 在过渡写入模式之外也会拒绝。只有当服务器没有 OTLP 端点（v3.22 之前的自托管）时，才会改用旧的 `/api/public/ingestion`。设置 `LANGFUSE_HOOK_TRANSPORT=legacy` 可固定使用旧路径，但 Langfuse 已将其弃用。子代理（Claude Code 代理、Codex 线程、Oh My Pi 任务会话）既作为父轮次链路中的 span 记录，也作为带 `subagent` 标签的独立链路记录，令牌只在父轮次一侧统计。用 `node ts/src/cli.ts verify claude <traceId>` 确认数据已保存，用 `node ts/src/cli.ts coverage claude` 与本地记录对照。详见 [README.md](README.md#quick-start)。

### 安装代理钩子

在仓库根目录运行命令。以下示例选择 Claude Code 和 Codex。也可用逗号分隔指定 `omp`、`antigravity`、`copilot`、`opencode` 等代理。

**Windows**

```powershell
./scripts/setup.ps1 --agents 'claude,codex'
```

**macOS 和 Linux**

```sh
sh scripts/setup.sh --agents claude,codex
```

提示输入显示名称时，直接按 Enter 将使用用户主目录的名称。可通过 `--name` 设置显示名称，通过 `--device` 设置设备标签，通过 `--environment` 设置 `local` 或 `ci` 等环境。安装后重新启动代理。在 Codex 中，使用 `/hooks` 审查新注册的钩子。

[Deep Agents SDK](tools/deepagents/) 使用 Python 回调。[Goose](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector) 使用原生 OTLP 导出器。仓库也提供 [Gemini CLI 兼容钩子](tools/gemini-cli/) 和 [oh-my-codex 桥接](tools/oh-my-codex/)。

### 接入 Grafana Tempo

准备 Grafana、Tempo 和 OpenTelemetry Collector 二进制文件。Collector 需要包含 `file`、`transform` 和 `otlp_http` 组件（core 发行版 0.164 及以上，或 contrib）。通用钩子直接发送到 Langfuse，Collector 将 OTLP 副本发送到 Tempo。Goose 则通过 Collector 发送到两个目标。

**Windows**

```powershell
node scripts/start-grafana.mjs --tempo 'C:\path\tempo.exe' --grafana 'C:\path\grafana-home'
./scripts/setup.ps1 --agents 'claude,codex' --collector 'C:\path\otelcol.exe' --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

**macOS 和 Linux**

```sh
node scripts/start-grafana.mjs --tempo /path/to/tempo --grafana /path/to/grafana-home
sh scripts/setup.sh --agents claude,codex --collector /path/to/otelcol --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

`--grafana` 指向解压后的 Grafana 主目录，安装脚本中的 `--tempo` 指定 OTLP 接收 URL。需要采集提示词、响应和工具调用正文时，使用 `--capture-content`。对于已经运行的 Collector，修改 YAML 后请重启它。

如果代理在另一台机器或容器中运行，请使用该环境可以访问的 Collector URL。如果现有 Collector 已经向 Langfuse 和 Tempo 转发，请参阅[共享 Collector 配置](docs/setup-agent-observability.md#use-an-existing-collector)。

### 验证链路

新建测试文件 `probe.txt`，写入唯一标记，请代理读取文件并原样返回。打开 Langfuse 和本地 [Grafana 仪表板](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces)，检查模型 → 工具 → 模型的顺序及对应的输入输出和令牌数。

使用 Grafana 账号登录。如需在本机免登录进行只读查看，启动 Grafana 时给 `start-grafana.mjs` 添加 `--anonymous-viewer`。

```sh
node ts/src/cli.ts doctor claude
node ts/src/cli.ts audit-langfuse claude --limit 10
```

如果项目密钥保存在 Codex 配置中，请将 `claude` 替换为 `codex`。请在本地妥善保管包含密钥的 `.env`。[详细配置与代理安装指南](docs/setup-agent-observability.md) · [许可证](LICENSE)

## 实测结果

截至 **2026 年 11 月 19 日**，✅ 表示通过实际文件读取，在 Langfuse 和 Grafana Tempo 中都验证了提示词、工具参数和结果、最终响应、每次模型调用的令牌数，以及模型 → 工具 → 模型的调用顺序。

| 代理 | Windows | macOS (Apple Silicon) | Debian 13 (ARM64) |
| --- | :---: | :---: | :---: |
| Claude Code | ✅ | ✅ | ✅ |
| OpenAI Codex CLI | ✅ | ✅ | ✅ |
| Oh My Pi (OMP) | ✅ | ✅ | ✅ |
| Antigravity CLI (`agy`) | ✅ | ✅ | ✅ |
| OpenCode 1.x | ✅ | ✅ | ✅ |
| GitHub Copilot CLI | ✅ | ✅ | ✅ |
| LangChain Deep Agents SDK | ✅ |  |  |
| Goose | ✅ |  |  |

Windows 上的 Antigravity 使用笔记本中原有的登录和钩子配置。Deep Agents 通过 SDK 回调验证，Goose 通过原生 Collector 中继验证。[验证详情](docs/agent-observability.md)
