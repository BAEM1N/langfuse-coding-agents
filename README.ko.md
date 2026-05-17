# langfuse-coding-agents

[English](README.md) | [한국어](README.ko.md)

> AI 코딩 에이전트를 위한 [Langfuse](https://langfuse.com) 네이티브 트레이싱. 하나의 monorepo, 일관된 통합 패턴, 5개의 에이전트 런타임.

각 에이전트의 대화 turn, tool 호출, 모델 응답이 Langfuse 대시보드의 구조화된 trace 로 자동 기록됩니다. 에이전트 코드는 손대지 않습니다.

## 지원 에이전트

| Tool | 경로 | Hook Config | 이벤트 | 상태 |
|------|------|-------------|--------|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [`tools/claude-code/`](tools/claude-code/) | `~/.claude/settings.json` | 4 (Stop, Notification, PreToolUse, PostToolUse) | stable |
| [Codex CLI](https://github.com/openai/codex) | [`tools/codex/`](tools/codex/) | `~/.codex/hooks.json` | 6 (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop) | v0.1.0 |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | [`tools/oh-my-codex/`](tools/oh-my-codex/) | `~/.omx/hooks/` + optional `~/.codex/hooks.json` bridge | OMX 네이티브 + Codex bridge | stable |
| [OpenCode](https://github.com/sst/opencode) | [`tools/opencode/`](tools/opencode/) | `~/.config/opencode/plugins/` (JS plugin → Python hook) | event-stream | stable |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | [`tools/gemini-cli/`](tools/gemini-cli/) | `~/.gemini/settings.json` | **11** (전체 lifecycle) | stable |

각 tool 디렉토리는 독립적입니다 — 기존 standalone repo 와 동일하게 동작합니다. 단 `cd` 한 단계 더 들어갈 뿐.

## 빠른 시작

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/<your-tool>      # 예: tools/codex
bash install.sh
```

installer 가 Langfuse 자격증명을 받고, hook script 를 에이전트 config 디렉토리에 복사하고, 모든 hook 이벤트를 등록하고, 에이전트별 1회 단계 (예: Codex `/hooks` trust, ChatGPT 계정 모델 override)를 안내합니다.

Windows: `bash install.sh` → `.\install.ps1`

## 왜 monorepo 인가?

5개 통합은 **핵심 hook 로직의 95% 이상을 공유**합니다 — Langfuse SDK 셋업, transcript 파싱, turn 조립, span emit, 토큰 집계, fail-open 동작. 갈라지는 부분은:

- Hook 이벤트 이름과 payload 형식 (각 에이전트마다 다름)
- Config 파일 위치 (`~/.<agent>/...`)
- Transcript / session JSONL 형식

monorepo 의 이점:
- LICENSE, contribution guide, CI 단일화
- [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) 에서 이벤트 매핑 cross-reference
- hook 엔진 개선을 한 번에 적용 → 모든 adapter 에 자동 전파
- 사용자가 "어느 repo 가 정식?" 묻지 않아도 됨

기존 5개 repo (`langfuse-claude-code`, `langfuse-codex`, `langfuse-oh-my-codex`, `langfuse-opencode`, `langfuse-gemini-cli`) 는 backward compatibility 를 위해 GitHub 에 유지됩니다. 새 작업은 여기서.

## 아키텍처

```
┌──────────────────────────────────────────────────────────┐
│                  Agent (Claude Code / Codex /             │
│                  oh-my-codex / OpenCode / Gemini CLI)     │
└─────────────────────┬────────────────────────────────────┘
                      │ stdin 으로 JSON payload
                      ▼
              ┌────────────────────┐
              │ langfuse_hook.py   │   ← tool 별 adapter
              │  (tools/<T>/ 내)    │
              └────────┬───────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  공통 파이프라인 (in-script): │
        │  1. Hook 이벤트 감지          │
        │  2. Payload 정규화            │
        │  3. Tool 이벤트 buffering      │
        │  4. Turn 종료 시 trace emit   │
        │  5. Flush + shutdown          │
        └──────────────┬───────────────┘
                       │ Langfuse SDK
                       ▼
               ┌─────────────────┐
               │    Langfuse     │
               │    Dashboard    │
               └─────────────────┘
```

v0.2 에서 공통 파이프라인을 `core/langfuse_hook_core.py` 로 추출 예정. 그러면 각 tool adapter 는 schema 정규화 + dispatch 만 남게 됨. v0.1.0 (이 릴리스) 은 각 tool 이 완전히 self-contained.

## 호환성

| 컴포넌트 | 최소 | 권장 |
|-----------|------|------|
| Python | 3.8 | 3.10+ (Langfuse nested span SDK 용) |
| langfuse SDK | 2.0 | 3.12+ |
| OS | macOS, Linux, Windows | — |

에이전트별:
- **Codex CLI 0.128+** (네이티브 hook 시스템이 0.128 부터)
- **Claude Code** — hook 지원 버전
- **Gemini CLI** — 11 이벤트 hook 시스템 버전
- **OpenCode** — JS plugin 지원 버전
- **oh-my-codex** — [`tools/oh-my-codex/`](tools/oh-my-codex/) 호환표 참조

## 문서

- 📚 [`docs/hook-event-matrix.md`](docs/hook-event-matrix.md) — 5 에이전트 이벤트 매핑 비교표
- 📄 각 `tools/<name>/` 의 자체 README
- 🤖 각 tool 의 `AGENTS.md` (AI 자동 셋업용)

## 기존 / Legacy Repos

5개 standalone repo:
- [`langfuse-claude-code`](https://github.com/BAEM1N/langfuse-claude-code) → [`tools/claude-code/`](tools/claude-code/)
- [`langfuse-codex`](https://github.com/BAEM1N/langfuse-codex) → [`tools/codex/`](tools/codex/)
- [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex) → [`tools/oh-my-codex/`](tools/oh-my-codex/)
- [`langfuse-opencode`](https://github.com/BAEM1N/langfuse-opencode) → [`tools/opencode/`](tools/opencode/)
- [`langfuse-gemini-cli`](https://github.com/BAEM1N/langfuse-gemini-cli) → [`tools/gemini-cli/`](tools/gemini-cli/)

기존 설치는 그대로 동작합니다. 새 수정/기능은 이 repo 부터.

## 기여

PR 환영. 자주 기여하는 영역:
- 새 에이전트 adapter (기존 구조 미러해서 `tools/<your-agent>/` 추가)
- Hook event matrix 업데이트 (upstream 에이전트가 이벤트 추가 시)
- Core 파이프라인 개선 (v0.2 에서 모든 adapter 에 전파)

## License

[MIT](LICENSE)
