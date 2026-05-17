#!/usr/bin/env python3
"""codex-native-bridge — Codex 자체 hook payload → omx native event payload 정규화 후 langfuse_hook.py 위임.

Codex CLI의 hook 시스템이 보내는 stdin (hook_event_name / sessionId / toolName / cwd 등)을
~/.omx/hooks/langfuse_hook.py 가 기대하는 omx native event 형식 (event / session_id / tool_name 등)
으로 변환한다. 그 외 모든 키는 그대로 통과.

이 스크립트를 ~/.codex/hooks.json 의 각 이벤트 hooks 배열에 추가하면 codex 자체 hook 시스템이
직접 langfuse 트레이싱을 트리거할 수 있다 (oh-my-codex 의존 없이).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

EVENT_MAP = {
    "Stop": "turn-complete",
    "PreToolUse": "pre-tool-use",
    "PostToolUse": "post-tool-use",
    "SessionStart": "session-start",
    "UserPromptSubmit": "user-prompt-submit",
    "PermissionRequest": "permission-request",
    "PreCompact": "pre-compact",
    "PostCompact": "post-compact",
}

KEY_ALIASES = [
    ("sessionId", "session_id"),
    ("threadId", "thread_id"),
    ("turnId", "turn_id"),
    ("toolName", "tool_name"),
    ("toolInput", "tool_input"),
    ("toolOutput", "tool_output"),
    ("current_directory", "cwd"),
    ("workingDirectory", "cwd"),
    ("transcriptPath", "transcript_path"),
]

PYTHON = os.environ.get("LANGFUSE_HOOK_PYTHON", "/usr/bin/python3")
HOOK_PATH = Path(os.environ.get("LANGFUSE_HOOK_PATH", str(Path.home() / ".omx" / "hooks" / "langfuse_hook.py")))
TIMEOUT_S = int(os.environ.get("LANGFUSE_HOOK_TIMEOUT_S", "10"))


def normalize(payload: dict) -> dict:
    out = dict(payload)
    hook_event = payload.get("hook_event_name") or payload.get("event") or "Stop"
    out["hook_event_name"] = hook_event
    out["event"] = EVENT_MAP.get(hook_event, str(hook_event).lower().replace("_", "-"))
    for src, dst in KEY_ALIASES:
        if src in out and dst not in out:
            out[dst] = out[src]
    return out


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0

    if not isinstance(data, dict):
        return 0

    # gate — TRACE_TO_LANGFUSE off면 즉시 종료
    if os.environ.get("TRACE_TO_LANGFUSE", "true").lower() == "false":
        return 0

    if not HOOK_PATH.exists():
        return 0

    payload = json.dumps(normalize(data))
    try:
        subprocess.run(
            [PYTHON, str(HOOK_PATH)],
            input=payload,
            text=True,
            capture_output=True,
            timeout=TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return 0
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
