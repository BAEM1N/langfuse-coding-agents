# コーディングエージェントの可観測性 · Langfuse と OpenTelemetry

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Claude Code、Codex CLI、Oh My Pi（OMP）、Antigravity CLI、OpenCode 1.x、GitHub Copilot CLI、Deep Agents SDK、Goose のトレースを収集できます。モデルの入出力、トークン使用量、ツール呼び出しの順序を Langfuse や Grafana で調べられます。収集できる項目はエージェントと設定によって異なります。[対応範囲と検証結果](docs/agent-observability.md)

## Langfuse の設定

Node.js 22.18 以上と、観測対象のエージェントを用意します。OpenCode を選ぶ場合は `venv` に対応する Python も必要です。Windows で Copilot CLI のコマンドフックを実行する場合は PowerShell 7 を使用します。

```sh
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents
```

`~/.config/langfuse-agent-hooks/.env` を作成します。Windows では `%USERPROFILE%\.config\langfuse-agent-hooks\.env` です。URL とキーは自分の Langfuse プロジェクトの値に置き換えてください。すでにローカル設定にキーがあれば、セットアップで再利用できます。

```dotenv
TRACE_TO_LANGFUSE=true
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-key
```

## エージェントのフックをインストール

リポジトリのルートで実行します。以下は Claude Code と Codex の例です。`omp`、`antigravity`、`copilot`、`opencode` などをカンマ区切りで指定できます。

**Windows**

```powershell
./scripts/setup.ps1 --agents 'claude,codex'
```

**macOS・Linux**

```sh
sh scripts/setup.sh --agents claude,codex
```

表示名の入力欄で Enter のみを押すと、ホームフォルダー名が使われます。`--name` で表示名、`--device` で端末ラベル、`--environment` で `local` や `ci` などの環境名を指定できます。インストール後はエージェントを再起動し、Codex では `/hooks` で追加したフックを確認してください。

[Deep Agents SDK](tools/deepagents/) には Python コールバックを追加します。[Goose](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector) はネイティブ OTLP エクスポーターを使用します。従来の [Gemini CLI フック](tools/gemini-cli/) と [oh-my-codex ブリッジ](tools/oh-my-codex/) も利用できます。

## Grafana Tempo への送信を追加

Grafana、Tempo、OpenTelemetry Collector の実行ファイルを用意します。Collector には `file`、`resource`、`otlp_http` コンポーネントが必要です。共通フックは Langfuse に直接送信し、Collector は OTLP のコピーを Tempo に送ります。Goose の場合は Collector が両方に送信します。

**Windows**

```powershell
node scripts/start-grafana.mjs --tempo 'C:\path\tempo.exe' --grafana 'C:\path\grafana-home'
./scripts/setup.ps1 --agents 'claude,codex' --collector 'C:\path\otelcol.exe' --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

**macOS・Linux**

```sh
node scripts/start-grafana.mjs --tempo /path/to/tempo --grafana /path/to/grafana-home
sh scripts/setup.sh --agents claude,codex --collector /path/to/otelcol --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

`--grafana` には展開した Grafana のホームディレクトリを指定します。セットアップ側の `--tempo` は OTLP の受信 URL です。プロンプト、応答、ツールの本文が必要なときは `--capture-content` を使用します。すでに Collector が稼働している場合は、YAML の変更後に再起動してください。

## トレースの確認

テスト用の `probe.txt` に固有の文字列を入れ、エージェントに読み取ってそのまま返すよう依頼します。Langfuse とローカルの [Grafana ダッシュボード](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces) で対象のトレースを開き、モデル → ツール → モデルの順序、入出力、トークンを確認します。

Grafana アカウントでサインインします。ログインなしでローカルの読み取り専用アクセスを使う場合は、起動時に `start-grafana.mjs` に `--anonymous-viewer` を追加します。

```sh
node ts/src/cli.ts doctor claude
node ts/src/cli.ts audit-langfuse claude --limit 10
```

Codex 側の設定にキーがある場合は `claude` を `codex` に置き換えてください。認証情報を含む `.env` はローカルで管理してください。[詳細なセットアップとエージェント向けガイド](docs/setup-agent-observability.md) · [ライセンス](LICENSE)
