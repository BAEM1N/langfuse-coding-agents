# 코딩 에이전트 로깅 현황

기준일은 2026년 11월 19일(KST)입니다. Windows 노트북에서 8개 에이전트·SDK의 트레이스 수집을 실측했습니다. macOS와 Debian ARM64에서는 같은 Collector에 연결해 6개를 재검증했습니다. 아래에서 **실측**은 실제 모델이 테스트 파일을 도구로 읽은 뒤, 새 트레이스를 Langfuse와 Grafana의 Tempo 데이터소스에서 각각 조회한 경우를 의미합니다.

## 어디에 기록되는가

| 실행 경로 | 수집과 전송 |
| --- | --- |
| Windows의 공통 훅·확장·플러그인 | Langfuse로 직접 전송합니다. OTLP 사본은 로컬 Collector의 `14318` 포트로 들어가 Tempo와 로컬 파일에 저장됩니다. Windows 노트북의 평소 `agy` 실행에서 이 경로를 재확인했습니다. |
| Goose 네이티브 OTLP | Goose → Collector `14320` → Langfuse, Tempo, 로컬 파일. Collector의 이 수신 경로는 두 백엔드로 전달합니다. |
| macOS·Debian 검증 | 각 에이전트 → SSH로 연결한 공용 Collector 수신 경로 → Langfuse와 Tempo. Debian은 내부 Mac의 임시 VM에서 실행했습니다. 검증 후 임시 VM과 SSH 연결을 정리했습니다. |

[Grafana Coding agent traces 대시보드](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces)는 Windows의 Tempo에 저장된 트레이스를 조회합니다. Collector의 로컬 사본은 `~/.local/share/langfuse-agent-hooks/collector/traces.ndjson`에 기록됩니다. OpenTelemetry(OTLP)는 트레이스 전송 형식이고 Tempo는 저장·조회 백엔드입니다.

## 무엇을 기록하는가

- **턴과 모델 호출** — 사용자 프롬프트, 모델 응답, 모델명, 시작·종료 시각, 호출별 입력·출력 토큰을 기록합니다. 모델이 제공하는 경우 캐시 읽기·생성 토큰도 기록합니다.
- **도구 호출** — 도구명, 인자, 결과, 호출 ID와 시각을 기록합니다. 호출을 요청한 모델과 결과를 받은 모델을 연결합니다. Antigravity는 네이티브 훅의 단계 번호로 도구 결과를 연결합니다.
- **순서 이상** — 공통 런타임은 호출보다 먼저 기록된 결과, 중복 결과, 완료된 턴에서 누락된 호출·결과를 경고로 남깁니다. 병렬 도구는 겹치는 시각을 허용하며, 호출 근거가 부족하면 불확실성을 기록합니다.
- **사용자·장비** — 설치 시 이름을 입력할 수 있고 빈 입력은 홈 폴더명으로 처리합니다. 공통 런타임은 호스트명, OS, 아키텍처와 가용한 장비 메타데이터를 기록합니다. 본문은 수집을 켠 경로에서 마스킹과 길이 제한을 적용합니다.
- **GitHub** — 공통 런타임은 작업 저장소의 URL, 체크아웃한 커밋의 SHA·URL, 브랜치를 기록합니다. 일치하는 PR이 확인되면 번호와 URL도 기록합니다. Goose는 같은 정보를 네이티브 OTLP 리소스 속성으로 전달할 수 있습니다. [GitHub 연결 및 조회 방법](setup-agent-observability.md#github-repository-commit-and-pull-request)

## 에이전트별 완료 범위

| 에이전트 | 연결 방식 | Windows | macOS·Debian ARM64 |
| --- | --- | --- | --- |
| Claude Code | `Stop` 등 네이티브 훅과 대화 로그 | 실측 | 실측 |
| Codex CLI | 사용자 훅과 세션 롤아웃 | 실측 | 실측 |
| OMP | 일반 실행에서 로드하는 사용자 확장 | 실측 | 실측 |
| Antigravity CLI | 모델·도구 네이티브 훅과 대화 로그 | 노트북의 평소 설정으로 재실측 | 기존 Gemini API 키로 실측 |
| OpenCode 1.x | 사용자 플러그인과 턴 전송기 | 실측 | 실측 |
| GitHub Copilot CLI | `agentStop` 사용자 훅, API 호출 ID로 토큰 연결 | 실측 | 실측 |
| Deep Agents SDK | Python 앱 실행 설정에 연결하는 콜백 | SDK 샘플 앱 실측 | 미실측 |
| Goose | 네이티브 OTLP와 Collector 릴레이 | 릴레이 경로 실측 | 미실측 |
| Cursor CLI, Kiro CLI | 훅·이벤트 지원 범위 조사 | 실행이 인증 단계에서 종료 | 미실측 |

기존 Gemini CLI와 oh-my-codex(OMX)는 별도 호환 경로가 있습니다. 이번 공통 경로의 Google 에이전트는 Antigravity입니다. Qwen Code, Factory Droid, OpenHands, Aider, Cline, Deep Agents Code CLI는 [지원 범위와 검증표](agent-observability.md#integration-routes-to-evaluate)에 조사 결과를 정리했습니다.

## 이번에 고친 것

- 공용 Collector를 쓰는 경로에서 Langfuse의 모델·도구 스팬 입출력 필드를 채우고, Grafana에서도 같은 본문을 확인했습니다.
- Copilot CLI와 Claude Code에서 종료 훅 시점에 최종 모델 응답이나 토큰이 늦게 작성되는 경우를 처리했습니다. Claude Code 헤드리스의 종료 훅 취소도 수정했습니다.
- OpenCode 설치 스크립트가 Python 3.10 이상과 가상환경 요건을 확인하고, 호환되지 않는 기존 가상환경을 백업한 뒤 재설치하도록 수정했습니다.
- Windows, macOS, Linux 설치 래퍼, 에이전트용 가이드, 4개 언어 README, Tempo 데이터소스와 Grafana 대시보드 설정을 저장소에 정리했습니다.

## 노트북의 최근 확인 사례

Windows에서 평소 로그인과 훅 설정을 그대로 두고 `agy` 1.5.12를 실행했습니다. `gemini-4-neon-xhigh`의 첫 호출은 입력 9,893 / 출력 230 토큰, `read_file` 이후의 호출은 입력 10,230 / 출력 153 토큰이었습니다. 후속 입력 중 7,836 토큰은 캐시 읽기로 기록됐습니다. 두 백엔드에서 같은 토큰과 입출력 및 `모델 → read_file → 모델` 순서를 확인했습니다. [Grafana의 노트북 검증 트레이스](http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces?var-traceId=b96bde17e48f33ea8c1508ad3d52a7af)

GitHub 연동은 [PR #1](https://github.com/BAEM1N/langfuse-coding-agents/pull/1)의 병합 커밋 체크아웃에서 Antigravity, OpenCode, Goose로 실측했습니다. 저장소, 커밋, PR 정보를 Langfuse와 Grafana 양쪽에서 확인했습니다. 노트북의 트레이스는 x64이며, 앞서 기록된 ARM64는 Apple Silicon Mac과 해당 Mac의 Debian VM 환경입니다.

## 남은 범위

- **다른 관측 솔루션** — Jaeger, Honeycomb, Datadog은 OTLP 연결 경로를 [문서화](../ts/README.md#opentelemetry-traces)했습니다. 실측한 백엔드는 Langfuse와 Grafana Tempo입니다.
- **운영 범위** — 이 검증은 개별 턴 트레이스에 대한 것입니다. 중앙 경보, 상시 수집 성공률, Cursor·Kiro 인증 후 끝단 실측, 구독 한도 차감 비교는 별도 검증 범위입니다.

운영 설정을 재현하거나 다시 확인하려면 [플랫폼별 설치 및 검증 가이드](setup-agent-observability.md)와 [순서·수집 범위 감사 명령](../ts/README.md#verify-call-order-and-monitoring-coverage)을 참고하세요.
