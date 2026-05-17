# langfuse-coding-agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![langfuse ≥4.0](https://img.shields.io/badge/langfuse-%E2%89%A54.0-7c3aed.svg)](https://github.com/langfuse/langfuse-python)

[English](README.md) | [한국어](README.ko.md)

> AI 코딩 에이전트를 위한 [Langfuse](https://langfuse.com) 네이티브 트레이싱. 하나의 monorepo, 일관된 통합 패턴, 5개 에이전트 런타임.

코딩 에이전트가 처리하는 모든 대화 turn·tool 호출·모델 응답이 Langfuse 대시보드의 구조화된 trace 로 기록됩니다. 에이전트 자체 코드는 손대지 않습니다.

---

## 목차

- [지원 에이전트](#지원-에이전트)
- [빠른 시작](#빠른-시작)
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

## 지원 에이전트

| Tool | 경로 | Hook 위치 | 캡처 이벤트 |
|------|------|-----------|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [`tools/claude-code/`](tools/claude-code/) | `~/.claude/settings.json` | 4 — `Stop`, `Notification`, `PreToolUse`, `PostToolUse` |
| [Codex CLI 0.128+](https://github.com/openai/codex) | [`tools/codex/`](tools/codex/) | `~/.codex/hooks.json` | 6 — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop` |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | [`tools/oh-my-codex/`](tools/oh-my-codex/) | `~/.omx/hooks/` + `~/.codex/hooks.json` bridge | OMX 네이티브 이벤트 + Codex 네이티브 bridge |
| [OpenCode](https://github.com/sst/opencode) | [`tools/opencode/`](tools/opencode/) | `~/.config/opencode/plugins/` (JS plugin → Python hook) | `session.*`, `message.updated`, `message.part.updated` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | [`tools/gemini-cli/`](tools/gemini-cli/) | `~/.gemini/settings.json` | 11 — 전체 lifecycle (`SessionStart` → `SessionEnd`, 모든 agent/model/tool 단계 + `Notification`, `PreCompress`) |

5개 adapter 모두 v0.1.0 기준 동작 검증 완료. 공통적으로 fail-open 동작, `TRACE_TO_LANGFUSE=true` runtime gate, Langfuse SDK 4.x 호환 (3.x deployment 도 in-hook shim 으로 그대로 작동 — [SDK 호환성](#sdk-호환성) 참조).

---

## 빠른 시작

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/<your-tool>      # 예: tools/opencode
bash install.sh                                  # Windows: ./install.ps1
```

Installer 동작:
- `langfuse_hook.py` 를 tool 의 config 디렉토리로 복사
- Langfuse 자격증명을 받아 `.env` 작성
- tool 의 기존 settings/hooks JSON 에 hook 항목을 **머지** (덮어쓰지 않음)
- tool 별 1회 추가 단계 안내 (예: Codex `/hooks` trust prompt)

### Agent 기반 자동 셋업

installer 프롬프트를 직접 응답하기 싫다면, 이 repo 를 코딩 에이전트 (Claude Code, Codex, Cursor, Gemini CLI …) 에 넘기고 다음과 같이 시키세요:

> "내 `<tool>` 에 Langfuse 트레이싱 셋업해줘."

Agent 가 [`AGENTS.md`](AGENTS.md) (Claude Code 는 [`CLAUDE.md`](CLAUDE.md) 자동 로드) 를 읽고, 자격증명을 인터뷰한 뒤 비대화식으로 설치를 진행합니다. AGENTS.md 는 agent 가 시스템 패키지 매니저 (apt, brew, winget 등) 를 **임의로 실행하지 않도록** 명시 — Python 이 없으면 OS 별 명령을 사용자에게 보여주고 사용자 손으로 실행하게 합니다.

---

## 어떤 tool 을 골라야 하나

| 상황 | 사용 |
|------|------|
| Claude Code 데일리 드라이버 | `tools/claude-code/` |
| Codex CLI 0.128+ standalone (wrapper 없이) | `tools/codex/` |
| Codex CLI 를 `oh-my-codex` npm wrapper 통해 사용 | `tools/oh-my-codex/` — Codex native bridge 도 함께 등록되므로 `tools/codex/` 별도 설치 불필요 |
| OpenCode (Anthropic / OpenAI / OpenRouter / 로컬 LM Studio / Ollama 등 모든 provider) | `tools/opencode/` |
| Gemini CLI (Google OAuth 또는 `GEMINI_API_KEY`) | `tools/gemini-cli/` |

여러 tool 을 함께 쓴다면 하나씩 따로 설치하세요. 각자 자기 config 디렉토리에만 쓰고 global state 를 공유하지 않습니다.

---

## 아키텍처

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
| Python | 3.8 | 3.10+ |
| Langfuse Python SDK | 3.0 | **4.0+** (4.6.x 검증) |
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

본 hook 은 **사용자의 대화 turn·tool 호출·모델 응답을 전부** 설정된 Langfuse 인스턴스로 전송합니다. 여기에는 prompt, 파일 경로, tool 출력 — host agent 가 보는 모든 것이 포함됩니다.

권장 사항:

- **Langfuse self-host 권장**: 대화에 사내 코드·내부 URL·시크릿·PII 가 포함될 가능성이 있다면. `https://cloud.langfuse.com` 은 편리하지만 외부 서비스입니다.
- **`.env` 는 시크릿 취급**: installer 가 권한 제한해서 쓰지만, 절대 commit 금지.
- **`TRACE_TO_LANGFUSE=true` 는 하드 게이트**: unset 하거나 다른 값으로 두면 uninstall 없이 트레이싱만 끔.
- **Fail-open 설계**: hook crash 가 host agent 동작을 막지 않음. 단점은 silent SDK 에러가 trace 를 drop 시킬 수 있다는 점 — `~/.<tool>/state/langfuse_hook.log` 에서 emit 여부 확인.

Hook 은 **`LANGFUSE_BASE_URL` 로 지정한 Langfuse 호스트 외 어떤 외부 호출도 하지 않습니다**. 자동 업데이트도, 시스템 패키지 매니저 호출도 없습니다.

---

## 트러블슈팅

흔한 증상과 조치는 [`AGENTS.md`](AGENTS.md) 하단 *Common failure modes* 표에 정리되어 있습니다. 핵심:

- **Hook log 는 `Processed in X.Xs` 인데 Langfuse 에 trace 가 없음** → SDK 4.x AttributeError 가 silent 하게 삼켜진 경우. Hook 파일이 `start_as_current_observation` 과 `_Langfuse_class_for_compat` shim 을 포함하는지 확인하고 없으면 이 repo 에서 다시 동기화.
- **Trace 는 도착하는데 `userId` / `sessionId` / `tags` 가 비어있음** → 위와 같은 원인.
- **tool 별 `userId` 가 분리되지 않음 (전부 `BAEM1N` 등)** → shell 의 `LANGFUSE_USER_ID` 가 tool 의 `.env` 를 가림. `unset` 하거나 tool 별로 override.
- **Codex CLI 가 trace 를 전혀 보내지 않음** → Codex 0.128+ trust prompt 미승인. 다음 실행 시 prompt 수락.

---

## 기여

PR 환영. 자주 기여하는 영역:

- **새 에이전트 adapter**. 기존 layout (`langfuse_hook.py`, `install.sh`, `install.ps1`, `README.md`, `AGENTS.md`) 미러해서 `tools/<your-agent>/` 추가.
- **Hook event matrix 업데이트**: upstream 에이전트가 이벤트 추가 시. [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) 동기화 유지.
- **Core 파이프라인 개선**: 5 hook 이 의도적으로 거의 동일하므로, 공통 로직을 변경할 때는 **5개 hook 을 한 번에 패치**. 오늘의 SDK 4.x 마이그레이션 (커밋 `8f2db84` + `b08d2ca`) 이 표준 예시.

스타일: 작고 원자적인 커밋, conventional commit prefix (`fix:`, `feat:`, `docs:`, `chore:`), 자동 생성 attribution 푸터 사용 금지.

---

## 연혁

원래 5개 standalone 리포지토리 (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`) 로 배포되었음. 2026년 5월에 본 monorepo 로 통합 — hook 파이프라인·라이선스·CI 를 공유하기 위함. 원본 5 repo 는 폐기됨.

---

## License

[MIT](LICENSE).
