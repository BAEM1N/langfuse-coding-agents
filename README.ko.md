# AI 코딩 에이전트 관측 · Langfuse와 OpenTelemetry

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![Node.js 22.18+](https://img.shields.io/badge/node-22.18+-339933.svg)](https://nodejs.org/)
[![langfuse ≥4.7](https://img.shields.io/badge/langfuse-%E2%89%A54.7-7c3aed.svg)](https://github.com/langfuse/langfuse-python)

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## 프로젝트 소개

Claude Code, OpenAI Codex CLI, Oh My Pi(OMP), Google Antigravity CLI, OpenCode의
대화 턴과 모델 입출력, 토큰 사용량, 도구 호출 순서를 기록합니다. 트레이스는
[Langfuse](https://langfuse.com), OpenTelemetry Collector 또는 두 곳으로 보낼 수 있습니다.

- [공통 훅 설치와 OTLP 설정](ts/README.md)
- [Windows·macOS·Linux 설치 및 Grafana Tempo 설정](docs/setup-agent-observability.md)
- [에이전트 지원 범위와 실측 결과](docs/agent-observability.md)
- [코딩 에이전트 로깅 현황](docs/agent-observability-status.ko.md)

---

## 목차

- [빠른 시작](#빠른-시작)
- [Grafana Tempo 연결](#grafana-tempo-연결)
- [실측 결과](#실측-결과)
- [지원 에이전트](#지원-에이전트)
- [에이전트로 설치](#에이전트로-설치)
- [어떤 tool 을 골라야 하나](#어떤-tool-을-골라야-하나)
- [아키텍처](#아키텍처)
- [호환성](#호환성)
- [문서](#문서)
- [보안 및 프라이버시](#보안-및-프라이버시)
- [트러블슈팅](#트러블슈팅)
- [기여](#기여)
- [연혁](#연혁)
- [License](#license)

---

## 빠른 시작

Node.js 22.18 이상과 관측할 코딩 에이전트를 설치합니다. OpenCode 1.x에는 `venv`와 `ensurepip`가 있는 Python 3.10 이상이 필요합니다. 기본 Python이 더 오래된 버전이면 `--python /path/to/python3`으로 경로를 지정하세요. Windows에서 Copilot CLI 명령 훅을 쓰려면 PowerShell 7을 사용하세요.

```sh
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents
```

### 1. Langfuse 설정

`~/.config/langfuse-agent-hooks/.env` 파일을 만듭니다. Windows에서는 `%USERPROFILE%\.config\langfuse-agent-hooks\.env`입니다. 아래 예시의 주소와 키를 자신의 Langfuse 프로젝트 값으로 바꾸세요. 기존 로컬 설정에 키가 있으면 설치 스크립트가 재사용할 수 있습니다.

```dotenv
TRACE_TO_LANGFUSE=true
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-key
```

공통 Node 런타임은 Langfuse가 지원하는 경로인 OTLP로 보냅니다. `LANGFUSE_HOOK_TRANSPORT`는 필요할 때만 바꿉니다.

| 값 | 전송 경로 | 대상 |
|---|---|---|
| 미설정 또는 `auto` | `/api/public/otel/v1/traces` (OTLP/HTTP JSON, `x-langfuse-ingestion-version: 4`). 서버에 이 엔드포인트가 없으면 그 서버에 한해 `/api/public/ingestion` | 전부: Langfuse Cloud, 자체 호스팅 v4·v3 |
| `otlp` | OTLP만, 폴백 없음 | 주소가 틀렸을 때 폴백 대신 실패하게 하려는 경우 |
| `legacy` | `/api/public/ingestion`만 | Langfuse가 사용 중단한 경로. OTLP 엔드포인트가 없는 v3.22 이전 자체 호스팅 |

Langfuse Cloud는 2026-11-16부터 `/api/public/ingestion`으로 들어온 트레이스 이벤트를 저장하지 않고, 자체 호스팅 v4도 전환용 쓰기 모드(`legacy`, `dual`) 밖에서는 거부합니다. 이 기본값 이전에 설치한 환경은 런타임을 갱신하면 OTLP로 넘어갑니다. 전환 이전에 시작된 턴은 프로젝트를 먼저 조회하므로, legacy로 이미 저장된 턴이 다시 저장되지 않습니다. legacy를 유지하려면 `LANGFUSE_HOOK_TRANSPORT=legacy`를 설정하세요. 이 경우 `doctor`가 사용 중단 경고를 출력합니다. 기준 배포 환경은 자체 호스팅 4.83에서 `LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`를 켠 구성입니다. `/api/public/ingestion`까지 완전히 닫히는 v4에서 가장 엄격한 모드인데, 이 환경에서 `selftest`가 쓰기·조회·삭제까지 전부 통과합니다.

턴은 끝난 뒤에 한 번 보내고, Langfuse가 받은 턴은 다시 보내지 않습니다. Langfuse v4는 같은 스팬 ID를 중복 제거하지 않기 때문입니다. Stop 이벤트 없이 끝난 턴은 트랜스크립트가 1시간 동안 변하지 않으면 종료 처리해 전송합니다. 프롬프트와 도구 본문, 턴 이벤트, 어댑터 메타데이터는 마스킹 후 문자열 길이 제한(`LANGFUSE_HOOK_MAX_CHARS`, 기본 20,000자)을 적용해 전송합니다. 본문을 빼려면 `LANGFUSE_HOOK_CAPTURE_CONTENT=false`를 설정하세요. [수집되지 않는 것](docs/setup-agent-observability.md#what-is-not-captured)과 [사용 중단 현황](docs/setup-agent-observability.md#deprecation-status)도 확인하세요.

서브에이전트(Claude Code 에이전트, Codex 스레드, Oh My Pi 태스크 세션, Copilot CLI·Antigravity 서브에이전트)의 모델·도구 호출은 부모 턴의 트레이스 안에 `Subagent: <유형>` 스팬으로 들어가고, `subagent` 태그가 붙은 별도 트레이스로도 볼 수 있습니다. 토큰은 부모 턴 쪽에만 집계되므로 합계가 두 배가 되지 않습니다. 자세한 내용은 [서브에이전트](docs/setup-agent-observability.md#sub-agents)를 참고하세요.

`tools/` 아래의 Python 단독 통합은 OTLP로 보내는 Langfuse Python SDK를 사용합니다. SDK 4.7 이상과 현행 SDK 5에서 동작합니다.

### 2. 에이전트 훅 설치

저장소 루트에서 운영체제에 맞는 명령을 실행합니다. 예시는 Claude Code와 Codex를 설치합니다. `omp`, `antigravity`, `copilot`, `opencode` 등 필요한 항목을 쉼표로 구분해 지정할 수 있습니다.

```powershell
./scripts/setup.ps1 --agents 'claude,codex'
```

```sh
sh scripts/setup.sh --agents claude,codex
```

이름을 묻는 메시지에서 Enter만 누르면 홈 폴더명을 사용합니다. `--name`으로 직접 지정할 수 있습니다. `--device`는 장비 이름, `--environment`는 `local`이나 `ci` 같은 환경 이름입니다. 설치 후 에이전트를 다시 실행하세요. Codex에서는 `/hooks`에서 새로 등록된 훅을 검토합니다.

### 3. 실제 트레이스 확인

테스트 폴더의 `probe.txt`에 고유한 문구를 적고, 에이전트에게 파일을 읽어 그대로 답하도록 요청하세요. Langfuse의 새 트레이스에서 `모델 → 도구 → 모델` 순서, 도구 인수·결과, 모델별 입력·출력 토큰을 확인합니다. 표시되는 항목은 어댑터와 본문 수집 설정에 따라 달라집니다.

```sh
node ts/src/cli.ts selftest all                      # 에이전트별 형식의 합성 턴(서브에이전트 포함)을 보내고, 조회해 대조한 뒤 삭제
node ts/src/cli.ts selftest all --relay http://127.0.0.1:14318/v1/traces --tempo http://127.0.0.1:13200   # 같은 검사에 Tempo 쪽 복사본 대조 추가
node ts/src/cli.ts doctor claude                     # 설정, 목적지, 최근 24시간 전송 결과
node ts/src/cli.ts delivery claude                   # 실패·부분 전송·미확인 턴
node ts/src/cli.ts verify claude <traceId>           # Langfuse에서 트레이스를 다시 조회
node ts/src/cli.ts verify claude <traceId> --tempo http://127.0.0.1:13200
node ts/src/cli.ts coverage claude --since 2026-11-20T00:00:00Z   # 로컬 트랜스크립트와 저장된 것 대조
node ts/src/cli.ts audit-langfuse claude --limit 10  # 조회 API는 자동 감지, --api v2|legacy로 강제
```

`doctor`의 인증 성공이나 훅 로그의 접수 기록만으로는 트레이스가 저장됐다고 볼 수 없습니다. `verify`가 백엔드에서 트레이스를 읽어 보낸 내용과 비교합니다. `unconfirmed`로 표시된 턴(타임아웃, 응답 유실, 부분 거부)은 확인 없이 다시 보내지 않습니다. Langfuse로 직접 보내는 경로에서는 훅이 스스로 정리합니다. 15분이 지나면(`LANGFUSE_HOOK_RECONCILE_MINUTES`, `0`이면 끔) 다음 훅 실행 때 트레이스를 조회해 저장된 스팬은 확정하고 없는 스팬만 보냅니다. Collector는 조회할 수 없으므로 그쪽의 미확인 턴은 `verify claude <traceId> --reconcile`을 실행할 때까지 대기합니다. `--tempo`를 주면 `verify`가 Tempo에서도 트레이스를 읽고, 같은 스팬이 두 번 저장됐으면 `DUPLICATED`로 알립니다. `coverage`는 기간 내 로컬 턴 전체를 프로젝트와 대조해 누락된 턴, 덜 저장된 턴, 비용이 없는 모델 호출을 알려줍니다.

Codex 설정에 프로젝트 키가 있다면 위 명령에서 `claude`를 `codex`로 바꾸세요. [Deep Agents SDK](tools/deepagents/)와 [Goose](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector)는 각각 콜백과 네이티브 OTLP를 사용합니다.

## Grafana Tempo 연결

훅은 Langfuse로 트레이스를 보내고, Collector는 OTLP 사본을 Tempo로 전달합니다. Grafana는 Tempo에서 트레이스를 조회합니다. Goose는 Collector를 거쳐 두 곳에 전송합니다. Grafana, Tempo, OpenTelemetry Collector 바이너리가 필요합니다. Collector에는 `file`, `transform`, `otlp_http` 구성 요소가 있어야 합니다(core 배포판 0.164 이상 또는 contrib).

**Windows**

```powershell
node scripts/start-grafana.mjs --tempo 'C:\path\tempo.exe' --grafana 'C:\path\grafana-home'
./scripts/setup.ps1 --agents 'claude,codex' --collector 'C:\path\otelcol.exe' --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

**macOS·Linux**

```sh
node scripts/start-grafana.mjs --tempo /path/to/tempo --grafana /path/to/grafana-home
sh scripts/setup.sh --agents claude,codex --collector /path/to/otelcol --tempo http://127.0.0.1:14328/v1/traces --capture-content
```

기본값에서는 훅이 Langfuse로 직접 보내고, Tempo용으로 Collector의 `14318` 수신 포트를 씁니다. `--collector-route both`를 붙이면 훅은 Collector의 `14319` 포트로만 보내고 Collector가 Langfuse와 Tempo 양쪽으로 전달합니다. 이때 설치 스크립트가 직접 전송을 끄므로 프로젝트에는 턴이 한 번만 들어갑니다. `--collector-route tempo`로 되돌립니다. `both` 경로에서는 `--capture-content`를 줘야 본문이 Langfuse에 들어가며, Collector가 요청을 받았다고 해서 두 백엔드에 전달된 것은 아니므로 `verify`로 확인하세요.

`--grafana`에는 압축을 푼 Grafana 폴더를, 설치 스크립트의 `--tempo`에는 OTLP 수신 URL을 지정합니다. 예제 Collector는 필요할 때 시작됩니다. 기존 Collector의 YAML을 바꿨다면 Collector를 재시작하세요. 지원되는 경로에서 프롬프트·응답·도구 본문까지 필요할 때 `--capture-content`를 사용합니다.

로컬 [Coding agent traces 대시보드](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces)에서 트레이스 ID를 선택하고 모델이나 도구 스팬을 펼칩니다. 공통 OTLP 전송기의 본문은 `coding_agent.input`과 `coding_agent.output`, 토큰은 `gen_ai.usage.*`에서 확인할 수 있습니다. 원격 장비나 컨테이너에서 에이전트를 실행하면 그 환경에서 접속할 수 있는 Collector URL을 사용하세요. 기존 Collector가 Langfuse와 Tempo 모두로 보내는 경우 [공용 Collector 설정](docs/setup-agent-observability.md#use-an-existing-collector)을 따르세요.

Grafana 계정으로 로그인하세요. 로컬에서 로그인 없이 읽기 전용으로 보려면 Grafana를 시작할 때 `start-grafana.mjs`에 `--anonymous-viewer`를 추가합니다.

## 실측 결과

**2026년 11월 19일** 기준입니다. ✅는 실제 파일 읽기에서 프롬프트, 도구 인자·결과, 최종 응답, 모델별 토큰, 모델 → 도구 → 모델 순서를 Langfuse와 Grafana Tempo 양쪽에서 확인한 경우입니다.

| 에이전트 | Windows | macOS (Apple Silicon) | Debian 13 (ARM64) |
| --- | :---: | :---: | :---: |
| Claude Code | ✅ | ✅ | ✅ |
| OpenAI Codex CLI | ✅ | ✅ | ✅ |
| Oh My Pi (OMP) | ✅ | ✅ | ✅ |
| Antigravity CLI (`agy`) | ✅ | ✅ | ✅ |
| OpenCode 1.x | ✅ | ✅ | ✅ |
| GitHub Copilot CLI | ✅ | ✅ | ✅ |
| LangChain Deep Agents SDK | ✅ |  |  |
| Goose | ✅ |  |  |

Windows의 Antigravity는 노트북에 저장된 로그인과 훅 설정을 그대로 사용했습니다. Deep Agents는 SDK 콜백으로, Goose는 네이티브 Collector 릴레이로 검증했습니다. [상세 실측 기록](docs/agent-observability-status.ko.md)

**2026년 11월 21일**, OTLP 전송과 서브에이전트 수집으로 바꾼 뒤 셀프 호스팅 Langfuse 4.76 프로젝트를 상대로 셀프테스트를 실행했습니다. 형식마다 서브에이전트가 포함된 합성 턴을 보내고, 두 트레이스를 조회해 대조한 뒤 삭제합니다.

| 검사 | Windows 11 | macOS 26 (Apple Silicon) | Ubuntu 24.04 (x86_64, WSL) |
| --- | :---: | :---: | :---: |
| `npm test` (77개, 1개는 Collector 바이너리 필요) | ✅ | ✅ | ✅ |
| `selftest all`: 여섯 형식이 보낸 그대로 Langfuse에 저장, 서브에이전트는 턴 안과 별도 트레이스 양쪽 | ✅ | ✅ | ✅ |
| `selftest all --relay --tempo`: Langfuse와 Tempo 3.1의 스팬 ID 일치, 중복 없음 | ✅ |  |  |

macOS와 Ubuntu는 테스트가 75개이던 시점에 실행했습니다. Tempo 대조는 core 배포판 0.165에서 예제 Collector 설정으로 진행했습니다.

## 지원 에이전트

Gemini CLI 개인·무료·Google AI Pro/Ultra 계정은 Antigravity CLI로 이전됐습니다.
[Google 마이그레이션 가이드](https://antigravity.google/docs/migrate-gemini-cli)

| 에이전트 | 설정 방법 | 전송 대상 |
| --- | --- | --- |
| Claude Code, Codex CLI, Antigravity CLI | [공통 설치 스크립트](#2-에이전트-훅-설치) | Langfuse, OTLP |
| OMP, OpenCode 1.x, Copilot CLI | [공통 설치 스크립트](#2-에이전트-훅-설치) | Langfuse, OTLP |
| Deep Agents SDK | [Python 콜백](tools/deepagents/) | Langfuse, OTLP |
| Goose | [네이티브 OTLP와 Collector](docs/agent-observability.md#goose-to-langfuse-through-an-opentelemetry-collector) | OTLP, Langfuse |
| oh-my-codex, 기존 Gemini CLI | [OMX 브리지](tools/oh-my-codex/) · [Gemini CLI 훅](tools/gemini-cli/) | Langfuse |

Python 경로의 Langfuse SDK 요구사항은 [SDK 호환성](#sdk-호환성)을 참고하세요.

---

## 에이전트로 설치

설치를 코딩 에이전트에 맡기려면 이 저장소를 열고 다음과 같이 요청하세요.

> "내 `<tool>` 에 Langfuse 트레이싱 셋업해줘."

에이전트는 [`AGENTS.md`](AGENTS.md)에 따라 로컬 설정을 재사용하고, 훅을 등록한 뒤 테스트 트레이스를 확인할 수 있습니다. 새 Langfuse 키가 필요하면 [빠른 시작](#빠른-시작)의 로컬 `.env`에 추가하세요.

---

## 어떤 tool 을 골라야 하나

| 상황 | 사용 |
|------|------|
| Claude Code | [공통 설치 스크립트](#2-에이전트-훅-설치) |
| Codex CLI 단독 실행 | [공통 설치 스크립트](#2-에이전트-훅-설치)와 `/hooks` 검토 |
| Codex CLI 를 `oh-my-codex` npm wrapper 통해 사용 | `tools/oh-my-codex/` — Codex native bridge 도 함께 등록되므로 `tools/codex/` 별도 설치 불필요 |
| OpenCode (Anthropic / OpenAI / OpenRouter / 로컬 LM Studio / Ollama 등 모든 provider) | `tools/opencode/` |
| Gemini CLI (Google OAuth 또는 `GEMINI_API_KEY`) | `tools/gemini-cli/` |

공통 설치 스크립트는 여러 에이전트를 한 번에 등록합니다. 에이전트별 훅 설정은 각 설정 폴더에 저장하고, 전송 대상 설정은 공유할 수 있습니다.

---

## 아키텍처

설치 스크립트가 Claude Code, Codex, Oh My Pi, Antigravity, Copilot CLI, OpenCode 턴에 쓰는 것은 공용 파이프라인(`ts/`, Node.js, 의존성 없음)입니다.

```
에이전트 훅 · 확장 · 플러그인
        │  트랜스크립트 경로 / 턴
        ▼
어댑터 (ts/src/adapters)       에이전트별 트랜스크립트 형식을 읽음
        │  턴, 모델 호출, 도구, 서브에이전트 실행
        ▼
코어 (ts/src/core)             턴마다 트레이스 하나, 서브에이전트는 턴 안과 별도 트레이스
        │  OTLP/HTTP JSON, 끝난 턴마다 한 번
        ├──────────────► Langfuse  /api/public/otel/v1/traces
        └──────────────► OTLP 수신기(Collector) ──► Tempo, Jaeger 등
        │
        ▼
<에이전트 홈>/state/delivery   목적지별·트레이스별 접수 기록
```

전송 기록은 같은 턴이 두 번 저장되지 않게 하고, `doctor`, `delivery`, `verify`, `coverage`가 읽는 근거입니다. `tools/` 아래의 단독 Python 어댑터는 아래의 Langfuse SDK 파이프라인을 씁니다.

```
┌──────────────────────────────────────────────────────────┐
│  Host 에이전트 (Claude Code / Codex / oh-my-codex /      │
│                  OpenCode / Gemini CLI)                   │
└─────────────────────┬─────────────────────────────────────┘
                      │ stdin 으로 JSON payload
                      ▼
              ┌────────────────────┐
              │ langfuse_hook.py   │  ← tool 별 adapter
              │ (tools/<T>/ 내)    │
              └────────┬───────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  In-script 파이프라인:        │
        │  1. Hook 이벤트 감지          │
        │  2. Payload 정규화            │
        │  3. Tool 이벤트 버퍼링        │
        │  4. Turn 종료 시 span emit    │
        │  5. Flush + shutdown          │
        └──────────────┬───────────────┘
                       │ Langfuse SDK
                       ▼
               ┌─────────────────┐
               │    Langfuse     │
               │    Dashboard    │
               └─────────────────┘
```

각 `tools/<tool>/langfuse_hook.py` 는 독립적이고 self-contained 합니다. 5개 hook 은 파이프라인 로직의 **95% 이상을 공유**하지만 현재는 의도적으로 거의 동일한 파일 5개로 유지 — 공통 패치 (예: 오늘의 SDK 4.x 마이그레이션) 는 5개에 동시에 적용합니다.

v0.2 에서 공통 파이프라인을 `core/langfuse_hook_core.py` 로 추출할 수 있음. v0.1.0 은 각 adapter 가 self-contained 유지.

에이전트별 이벤트 매핑은 [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) 참조.

---

## 호환성

| 컴포넌트 | 최소 | 권장 |
|----------|------|------|
| Node.js (공용 런타임) | 22.18 | 최신 LTS |
| Langfuse 서버 | 셀프 호스팅 3.22 (OTLP 엔드포인트가 처음 들어간 버전) | Langfuse Cloud 또는 셀프 호스팅 4.x |
| Python (단독 통합) | 3.8 | 3.10+ |
| Langfuse Python SDK | 4.7 (OTLP로 전송) | **5.x** (4.18, 5.2 검증) |
| OpenTelemetry Collector (선택) | core 0.164 또는 contrib | core 0.165 검증 |
| Grafana Tempo (선택) | — | 3.1 검증 |
| OS | macOS / Linux / Windows | — |

에이전트별 요구사항:

- **Codex CLI 0.128+** — 네이티브 hook 시스템이 0.128 부터 제공.
- **Claude Code** — hook 지원 버전.
- **Gemini CLI** — 11-event hook 시스템 버전.
- **OpenCode** — JS plugin 지원 버전.
- **oh-my-codex** — [`tools/oh-my-codex/README.md`](tools/oh-my-codex/README.md) 호환표 참조.

### SDK 호환성

Langfuse 4.0 에서 원본 hook 이 의존하던 두 API 가 제거됨:

1. `Langfuse.start_as_current_span(...)` → `start_as_current_observation(name=..., as_type="span", ...)` 로 대체.
2. `Langfuse.update_current_trace(...)` → 모듈 레벨 `propagate_attributes(...)` 컨텍스트 매니저로 대체.

본 repo 의 hook 은 두 변경 모두 처리:

- 모든 호출 사이트가 `start_as_current_observation(...)` 사용.
- import 시점에 클래스 레벨 shim 을 설치 → 기존 `client.update_current_trace(...)` 호출이 자동으로 `propagate_attributes` enter/exit 으로 변환. shim 은 native 메서드가 없는 SDK 에서만 활성화 → Langfuse 3.x deployment 도 변경 없이 작동.

이 hook 을 다른 곳에 임베드한다면 shim 을 복사하거나 `propagate_attributes` 로 직접 마이그레이션 권장. 자세한 계약은 [`AGENTS.md`](AGENTS.md) 의 *SDK 4.x notes* 섹션.

---

## 문서

- [`AGENTS.md`](AGENTS.md) — AI 코딩 에이전트용 umbrella 셋업 가이드 (repo 클론 → 에이전트에게 위임 → 완료).
- [`CLAUDE.md`](CLAUDE.md) — Claude Code 의 auto-load 동작용 thin pointer.
- [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) — 5 에이전트 이벤트 매핑 비교표.
- 각 `tools/<name>/README.md` — tool 별 설치·설정·트러블슈팅.
- 각 `tools/<name>/AGENTS.md` — tool 별 AI agent 자동화 절차.

---

## 보안 및 프라이버시

어댑터와 본문 수집 설정에 따라 프롬프트, 응답, 파일 경로, 도구 결과가 지정된 백엔드로 전송될 수 있습니다.

권장 사항:

- **Langfuse self-host 권장**: 대화에 사내 코드·내부 URL·시크릿·PII 가 포함될 가능성이 있다면. `https://cloud.langfuse.com` 은 편리하지만 외부 서비스입니다.
- **`.env` 는 시크릿 취급**: installer 가 권한 제한해서 쓰지만, 절대 commit 금지.
- **`TRACE_TO_LANGFUSE=true`**는 Langfuse 전송을 켭니다. 공통 OTLP 전송은 별도의 수신 URL과 활성화 설정을 사용합니다.
- **Fail-open 설계**: hook crash 가 host agent 동작을 막지 않음. 단점은 silent SDK 에러가 trace 를 drop 시킬 수 있다는 점 — `~/.<tool>/state/langfuse_hook.log` 에서 emit 여부 확인.

훅은 설정된 Langfuse와 OTLP 주소로 트레이스를 전송합니다. 자동 업데이트와 시스템 패키지 설치는 수행하지 않습니다.

---

## 트러블슈팅

흔한 증상과 조치는 [`AGENTS.md`](AGENTS.md) 하단 *Common failure modes* 표에 정리되어 있습니다. 핵심:

- **Langfuse에 턴이 없음** → `node ts/src/cli.ts delivery <agent>`가 실패했거나 미확인인 턴과 사유를 보여 줍니다. `coverage <agent> --since <시각>`은 로컬 턴 전체를 프로젝트와 대조합니다.
- **`doctor`가 레거시 인제스천을 경고함** → 설정에 `LANGFUSE_HOOK_TRANSPORT=legacy`가 남아 있습니다. 서버가 3.22보다 오래되지 않았다면 지우세요.
- **Langfuse에는 있는데 Tempo에는 없음** → Collector는 백엔드보다 먼저 요청을 접수합니다. `selftest all --relay <수신기 URL> --tempo <조회 URL>`을 실행하고, Collector를 띄울 때 지정한 Tempo 수신 URL에 실제로 떠 있는 프로세스가 있는지 확인하세요.
- **모델 호출 비용이 0** → Langfuse 프로젝트에 그 모델 이름의 가격 정의가 없습니다. 프로젝트 설정에서 모델 정의를 추가하세요. 토큰 수는 그와 무관하게 전송됩니다.
- **Hook log 는 `Processed in X.Xs` 인데 Langfuse 에 trace 가 없음** → SDK 4.x AttributeError 가 silent 하게 삼켜진 경우. Hook 파일이 `start_as_current_observation` 과 `_Langfuse_class_for_compat` shim 을 포함하는지 확인하고 없으면 이 repo 에서 다시 동기화.
- **Trace 는 도착하는데 `userId` / `sessionId` / `tags` 가 비어있음** → 위와 같은 원인.
- **tool 별 `userId` 가 분리되지 않음 (전부 `BAEM1N` 등)** → shell 의 `LANGFUSE_USER_ID` 가 tool 의 `.env` 를 가림. `unset` 하거나 tool 별로 override.
- **Codex CLI 가 trace 를 전혀 보내지 않음** → Codex 0.128+ trust prompt 미승인. 다음 실행 시 prompt 수락.

---

## 기여

PR 환영. 자주 기여하는 영역:

- **새 에이전트 adapter**. 기존 layout (`langfuse_hook.py`, `install.sh`, `install.ps1`, `README.md`, `AGENTS.md`) 미러해서 `tools/<your-agent>/` 추가.
- **Hook event matrix 업데이트**: upstream 에이전트가 이벤트 추가 시. [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) 동기화 유지.
- **공통 파이프라인 개선**: `ts/src/core/`를 수정하고 `ts/`에서 `npm test`로 검증합니다. 기존 Python 통합은 독립적으로 동작합니다.

스타일: 작고 원자적인 커밋, conventional commit prefix (`fix:`, `feat:`, `docs:`, `chore:`), 자동 생성 attribution 푸터 사용 금지.

---

## 연혁

원래 5개 standalone 리포지토리 (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`) 로 배포되었음. 2026년 5월에 본 monorepo 로 통합 — hook 파이프라인·라이선스·CI 를 공유하기 위함. 원본 5 repo 는 폐기됨.

---

## License

[MIT](LICENSE).
