# langfuse-codex

> 📦 [`langfuse-coding-agents`](../../README.md) monorepo의 일부입니다. 다른 도구: [`claude-code`](../claude-code/) · [`codex`](../codex/) · [`oh-my-codex`](../oh-my-codex/) · [`opencode`](../opencode/) · [`gemini-cli`](../gemini-cli/)

[English](README.md) | [한국어](README.ko.md)

[Codex CLI](https://github.com/openai/codex) 의 네이티브 hook 시스템을 이용한 [Langfuse](https://langfuse.com) 자동 트레이싱. wrapper 없이 모든 대화 turn, tool call, 모델 응답이 Langfuse 대시보드에 구조화된 trace 로 기록됩니다.

## Status (2026-05-17)

- ✅ `v0.1.0` — Codex CLI 네이티브 baseline
- ✅ Codex CLI 0.128+ 의 네이티브 hook 시스템 (`~/.codex/hooks.json`)
- ✅ 6개 hook 이벤트 커버: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- ✅ `snake_case` payload 우선 + `camelCase` alias inline fallback
- ✅ `transcript_path` fallback — Codex 가 transcript 를 안 넘겨도 minimal trace 생성
- ✅ Codex CLI v0.130.0 단위 테스트 통과
- 🔗 자매 repo: [`langfuse-claude-code`](https://github.com/BAEM1N/langfuse-claude-code) · [`langfuse-gemini-cli`](https://github.com/BAEM1N/langfuse-gemini-cli) · [`langfuse-opencode`](https://github.com/BAEM1N/langfuse-opencode) · [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex)

## 왜 Codex 용이 두 개인가요?

| Repo | 대상 | 의존성 |
|---|---|---|
| **`langfuse-codex`** (이 repo) | 순수 Codex CLI 0.128+ 사용자 | Codex CLI only |
| [`langfuse-oh-my-codex`](https://github.com/BAEM1N/langfuse-oh-my-codex) | [oh-my-codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex) wrapper 사용자 | OMX 필수 (native-bridge 옵션) |

Codex CLI 만 쓴다면 **이 repo**. OMX 로 감싸 쓴다면 `langfuse-oh-my-codex`.

## 핵심 기능

- **네이티브 Codex hooks** — Codex 자체 hook 시스템 사용. 3rd-party wrapper 없음.
- **6개 이벤트 커버** — `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PermissionRequest` / `Stop`
- **Turn 단위 trace** — 사용자 prompt + assistant 응답이 한 Langfuse trace 로
- **Tool call 추적** — 모든 tool 사용을 input/output 과 함께 기록
- **Thinking blocks** — 모델 reasoning 을 별도 span 으로
- **토큰 사용량** — input/output/cache 토큰 generation 마다 기록
- **세션 그룹핑** — Codex session ID 로 자동 그룹
- **중복 방지** — 증분 처리
- **Schema-tolerant** — `snake_case` (v0.130+) / `camelCase` 둘 다 처리
- **Transcript fallback** — JSONL transcript 없을 때 minimal trace
- **Fail-open** — hook 문제 생겨도 Codex 는 막히지 않음
- **크로스 플랫폼** — macOS, Linux, Windows

## 요구사항

- **Codex CLI 0.128+** ([설치](https://github.com/openai/codex)) — 네이티브 hook 시스템이 0.128 부터 들어감
- **Python 3.8+** with `pip`
- **Langfuse 계정** — [cloud.langfuse.com](https://cloud.langfuse.com) 또는 self-hosted

## 빠른 설치

```bash
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/codex
bash install.sh
```

Windows (PowerShell):

```powershell
git clone https://github.com/BAEM1N/langfuse-coding-agents.git
cd langfuse-coding-agents/tools/codex
.\install.ps1
```

installer 가 하는 일:
1. Codex CLI 0.128+ 와 Python 3.8+ 확인
2. `langfuse` Python 패키지 설치
3. hook script 를 `~/.codex/hooks/` 에 복사
4. Langfuse 자격증명 입력 받아 `~/.codex/.env` 작성
5. `~/.codex/hooks.json` 에 6 이벤트 등록
6. **1회만 필요한 trust 단계 안내**

## 1회 Trust 단계 (필수)

Codex 는 보안상 non-managed command hook 에 명시적 trust 를 요구합니다. installer 메시지에도 있지만 중요해서 다시 적어둡니다:

```
$ codex                # interactive TUI
> /hooks               # slash command
# langfuse_hook 항목 확인 → 승인
> exit
```

**호스트당 1회**. 이후 `codex` / `codex exec` 호출에서 hook 이 자동 발화합니다.

이 단계 건너뛰면 hook script 는 설치되지만 절대 호출되지 않습니다 — `~/.codex/state/langfuse_hook.log` 에 아무 entry 도 안 들어갑니다.

## ChatGPT 계정 사용자 주의

`codex login` 으로 **ChatGPT 계정** (Plus/Pro) 인증했다면, `~/.codex/config.toml` 기본 모델 `gpt-5-codex` 가 API 에서 **거부**됩니다. 지원되는 모델 사용:

```bash
codex exec -c model="gpt-5.5" "프롬프트"
```

또는 영구 설정 (`~/.codex/config.toml`):

```toml
model = "gpt-5.5"
```

API key 사용자 (ChatGPT 계정 아님) 는 `gpt-5-codex` 그대로 사용 가능.

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `TRACE_TO_LANGFUSE` | ✅ | - | `"true"` 로 trace 활성 |
| `LANGFUSE_PUBLIC_KEY` | ✅ | - | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | ✅ | - | Langfuse secret key |
| `LANGFUSE_BASE_URL` | - | `https://cloud.langfuse.com` | self-hosted Langfuse URL |
| `LANGFUSE_USER_ID` | - | `codex-user` | trace attribution (호스트 이름 권장) |
| `CC_LANGFUSE_DEBUG` | - | `false` | verbose log → `~/.codex/state/langfuse_hook.log` |
| `CC_LANGFUSE_MAX_CHARS` | - | `20000` | 텍스트 truncation 임계값 |

`CC_LANGFUSE_*` prefix 도 동일 키들에 적용 가능 (우선순위 높음).

## 동작 원리

```
┌─────────────────────────────────────────────────────────┐
│                    Codex CLI                            │
│                                                         │
│  User prompt ──► Model 응답 ──► Tool 호출 ──► ...       │
│       │                                                 │
│       │  ┌──── 6 lifecycle hooks ──────────────┐        │
│       └─►│ langfuse_hook.py (stdin = JSON)      │        │
│          │                                      │        │
│          │ • camelCase → snake_case 정규화      │        │
│          │ • event_type 판별                    │        │
│          │ • PreToolUse / PostToolUse buffer    │        │
│          │ • Stop 시: transcript 또는 fallback  │        │
│          └───────┬──────────────────────────────┘        │
│                  │                                       │
└──────────────────┼───────────────────────────────────────┘
                   │
                   ▼
          ┌─────────────────────┐
          │      Langfuse        │
          │  Trace (Codex - Turn N) │
          │  ├─ System Prompt    │
          │  ├─ Generation       │
          │  ├─ Thinking [1]     │
          │  ├─ Text [1]         │
          │  ├─ Tool: Bash       │
          │  └─ Tool: apply_patch│
          │  Session: <codex_id> │
          └─────────────────────┘
```

## 트러블슈팅

### Trace 가 안 들어옴
1. Trust 단계 완료했는지 확인 — `codex` → `/hooks`
2. `~/.codex/.env` 의 `TRACE_TO_LANGFUSE=true` + 키 valid 확인
3. debug 활성: `CC_LANGFUSE_DEBUG=true codex exec "test"`
4. 로그 확인: `tail -f ~/.codex/state/langfuse_hook.log`

### Hook 자체가 안 발화함
1. `codex` → `/hooks` 에 langfuse 항목 안 보이면 hooks.json 인식 실패 — 파일 syntax 확인
2. ChatGPT 계정 모델 에러? `-c model="gpt-5.5"` 로 override (위 섹션 참조)
3. 직접 테스트: `echo '{"session_id":"t","hook_event_name":"PostToolUse","tool_name":"Bash"}' | python3 ~/.codex/hooks/langfuse_hook.py` → exit 0 + log entry 예상

### Stop trace 비어있음 / transcript_path 부재
Codex 의 transcript 처리는 아직 변하고 있어요. 로그에 `Transcript path does not exist` 보이면 hook 이 자동으로 **fallback trace** 를 생성 (last_assistant_message + buffered tool events). v0.1.0 의도된 동작. 풀 transcript 기반 trace 는 Codex 가 `transcript_path` 를 hook payload 에 채워줘야 가능.

### 중복 trace
`~/.codex/state/langfuse_state.json` 에 file offset 저장. 이 파일 지우면 이전 turn 이 재전송. 처음부터 다시 원할 때만 삭제.

## 제거

```bash
rm ~/.codex/hooks/langfuse_hook.py
rm ~/.codex/hooks.json   # 또는 langfuse 항목만 편집해서 제거
rm ~/.codex/.env
rm -rf ~/.codex/state
```

이후 `codex` → `/hooks` 로 langfuse 항목 없는지 확인.

## License

[MIT](LICENSE)
