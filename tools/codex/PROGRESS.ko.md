# Progress

## v0.1.0 (2026-05-17) — Codex CLI 네이티브 baseline

### 완료
- `langfuse-claude-code` 에서 fork → Codex schema 적응
- 모든 경로 `~/.claude/*` → `~/.codex/*` 마이그레이션
- Inline `camelCase` → `snake_case` payload 정규화 (9개 키 alias)
- 이벤트 커버리지 6종 확장: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- `transcript_path` fallback — Codex 가 transcript 안 넘겨도 minimal trace 발행
- `settings.json` hooks 필드 in-place merge → `~/.codex/hooks.json` 별도 파일 (Codex 네이티브 형식)
- `install.sh` / `install.ps1` 업데이트: Codex 0.128+ 버전 체크, trust 안내, ChatGPT 계정 모델 override 안내

### 검증
- `langfuse_hook.py` syntax check (1500+ 줄, Python 3.9)
- 6 이벤트 + camelCase 변형 단위 테스트 (`TRACE_TO_LANGFUSE=false` exit 0)
- `install.sh` bash syntax (`bash -n`)
- macOS 26.3.1 / Codex CLI v0.130.0 에서 테스트

### v0.1.0 범위 외 (후속)
- 실제 Codex 세션에서 trust + transcript_path 동작 관찰 (사용자 TUI 접속 의존)
- PreCompact / PostCompact 이벤트 payload 탐색 (v0.2)
- 자매 repo README 에 `langfuse-codex` 링크 추가 (별도 PR)
