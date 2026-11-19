#!/usr/bin/env python3
"""
OpenCode -> Langfuse hook (fail-open).

Input: JSON payload on stdin, usually forwarded by langfuse_plugin.js:
{
  "source": "opencode-plugin",
  "captured_at": "...",
  "event": { "type": "...", "properties": {...} }
}
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import socket
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Langfuse SDK 4.x compatibility shim
# In Langfuse 4.x the `Langfuse.update_current_trace` method was removed in
# favor of the module-level `propagate_attributes()` context manager. This
# shim restores `update_current_trace` so existing hook code that calls
# `client.update_current_trace(...)` keeps emitting trace-level attributes
# (session_id, user_id, tags, trace_name, metadata). Older SDKs already have
# the native method and are left untouched.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - executes once at import time
    from langfuse import Langfuse as _Langfuse_class_for_compat  # type: ignore
    from langfuse import propagate_attributes as _lf_propagate_attributes  # type: ignore

    if not hasattr(_Langfuse_class_for_compat, "update_current_trace"):
        def _v4_update_current_trace_shim(  # type: ignore[no-redef]
            self,
            *,
            name=None,
            session_id=None,
            user_id=None,
            tags=None,
            metadata=None,
            version=None,
            **_kwargs,
        ):
            filtered_meta = None
            if metadata and isinstance(metadata, dict):
                tmp = {}
                for k, v in metadata.items():
                    if not isinstance(k, str):
                        continue
                    key = k[:200]
                    if isinstance(v, str):
                        tmp[key] = v[:200]
                    elif isinstance(v, (int, float, bool)):
                        tmp[key] = str(v)[:200]
                if tmp:
                    filtered_meta = tmp
            try:
                cm = _lf_propagate_attributes(
                    session_id=session_id if isinstance(session_id, str) else None,
                    user_id=user_id if isinstance(user_id, str) else None,
                    tags=tags if isinstance(tags, list) else None,
                    trace_name=name if isinstance(name, str) else None,
                    metadata=filtered_meta,
                    version=version if isinstance(version, str) else None,
                )
                cm.__enter__()
                cm.__exit__(None, None, None)
            except Exception:
                pass

        _Langfuse_class_for_compat.update_current_trace = _v4_update_current_trace_shim
except Exception:
    pass
# ---------------------------------------------------------------------------

try:
    import fcntl  # type: ignore
except Exception:  # pragma: no cover
    fcntl = None

try:
    import msvcrt  # type: ignore
except ImportError:
    msvcrt = None


CONFIG_DIR = Path.home() / ".config" / "opencode"
STATE_DIR = Path(os.environ["OPENCODE_LANGFUSE_STATE_DIR"]) if os.environ.get("OPENCODE_LANGFUSE_STATE_DIR") else CONFIG_DIR / "state" / "langfuse"
STATE_FILE = STATE_DIR / "state.json"
STATE_LOCK_FILE = STATE_DIR / "state.lock"
LOG_FILE = STATE_DIR / "langfuse_hook.log"
MAX_CHARS = int(os.environ.get("OPENCODE_LANGFUSE_MAX_CHARS", "20000"))
MAX_MESSAGE_EVENTS_PER_MESSAGE = int(os.environ.get("OPENCODE_LANGFUSE_MAX_MESSAGE_EVENTS_PER_MESSAGE", "30"))

_LOG_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "WARNING": 30, "ERROR": 40}


def _load_dotenv() -> None:
    for env_path in (CONFIG_DIR / ".env", CONFIG_DIR.parent / "langfuse-agent-hooks" / ".env"):
        try:
            for line in env_path.read_text(encoding="utf-8-sig").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key.startswith("export "):
                    key = key[7:].lstrip()
                value = value.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            continue


def _user_id() -> str:
    return (os.environ.get("CC_LANGFUSE_USER_ID") or os.environ.get("CODING_AGENT_USER_NAME")
            or os.environ.get("LANGFUSE_USER_ID") or Path.home().name or "local-user")


def _device() -> dict:
    if os.environ.get("CODING_AGENT_DEVICE_METADATA") == "false":
        return {}
    fields = {"host.name": socket.gethostname(), "os.type": sys.platform, "os.version": platform.release(),
              "host.arch": platform.machine(), "host.cpu.logical_count": os.cpu_count()}
    label = os.environ.get("CODING_AGENT_DEVICE_LABEL")
    if label:
        fields["coding_agent.device.label"] = label
    return fields


def _log(level: str, message: str) -> None:
    level_name = str(level or "INFO").strip().upper()
    level_value = _LOG_LEVELS.get(level_name, _LOG_LEVELS["INFO"])

    env_level = os.environ.get("OPENCODE_LANGFUSE_LOG_LEVEL", "INFO").strip().upper()
    env_value = _LOG_LEVELS.get(env_level, _LOG_LEVELS["INFO"])
    debug_enabled = os.environ.get("OPENCODE_LANGFUSE_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    if debug_enabled:
        env_value = _LOG_LEVELS["DEBUG"]

    if level_value < env_value:
        return
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} [{level_name}] {message}\n")
    except Exception:
        pass


def _truncate(value: Any, limit: int = MAX_CHARS) -> Any:
    if not isinstance(value, str):
        return value
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n...[truncated {len(value) - limit} chars]"


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_json(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # OpenCode timestamps are milliseconds since epoch.
        if value > 10_000_000_000:
            return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        v = value.strip()
        if not v:
            return None
        try:
            if v.endswith("Z"):
                return datetime.fromisoformat(v[:-1] + "+00:00")
            dt = datetime.fromisoformat(v)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None
    return None


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _msg_key(session_id: str, message_id: str) -> str:
    return f"{session_id}:{message_id}"


def _turn_key(session_id: str, message_id: str) -> str:
    raw = f"{session_id}:{message_id}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


@contextmanager
def _state_lock():
    lock_fd = None
    locked = False
    try:
        if fcntl is not None or msvcrt is not None:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            lock_fd = STATE_LOCK_FILE.open("a+", encoding="utf-8")
            if fcntl is not None:
                fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX)
            else:
                lock_fd.seek(0)
                msvcrt.locking(lock_fd.fileno(), msvcrt.LK_LOCK, 1)
            locked = True
    except Exception:
        locked = False
        if lock_fd is not None:
            try:
                lock_fd.close()
            except Exception:
                pass
            lock_fd = None

    try:
        yield
    finally:
        if locked and lock_fd is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
                else:
                    lock_fd.seek(0)
                    msvcrt.locking(lock_fd.fileno(), msvcrt.LK_UNLCK, 1)
            except Exception:
                pass
        if lock_fd is not None:
            try:
                lock_fd.close()
            except Exception:
                pass


def _load_state() -> Dict[str, Any]:
    try:
        if not STATE_FILE.exists():
            return {
                "messages": {},
                "message_events": {},
                "user_parts": {},
                "assistant_parts": {},
                "assistant_finish_seen": {},
                "pending_parts": {},
                "message_last_seen": {},
                "part_last_seen": {},
                "emitted": {},
                "session_lifecycle": {},
            }
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("messages", {})
            data.setdefault("message_events", {})
            data.setdefault("user_parts", {})
            data.setdefault("assistant_parts", {})
            data.setdefault("assistant_finish_seen", {})
            data.setdefault("pending_parts", {})
            data.setdefault("message_last_seen", {})
            data.setdefault("part_last_seen", {})
            data.setdefault("emitted", {})
            data.setdefault("session_lifecycle", {})
            return data
    except Exception:
        pass
    return {
        "messages": {},
        "message_events": {},
        "user_parts": {},
        "assistant_parts": {},
        "assistant_finish_seen": {},
        "pending_parts": {},
        "message_last_seen": {},
        "part_last_seen": {},
        "emitted": {},
        "session_lifecycle": {},
    }


def _save_state(state: Dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except Exception:
        pass


def _read_payload() -> Dict[str, Any]:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _event_obj(payload: Dict[str, Any]) -> Dict[str, Any]:
    ev = payload.get("event")
    if isinstance(ev, dict):
        return ev
    return payload


def _event_name(payload: Dict[str, Any]) -> str:
    ev = _event_obj(payload)
    name = ev.get("type") or ev.get("event") or ev.get("name") or payload.get("type")
    return str(name or "unknown").strip().lower()


def _event_props(payload: Dict[str, Any]) -> Dict[str, Any]:
    ev = _event_obj(payload)
    return _as_dict(ev.get("properties"))


def _session_id(payload: Dict[str, Any]) -> str:
    props = _event_props(payload)
    info = _as_dict(props.get("info"))
    part = _as_dict(props.get("part"))

    for candidate in (
        props.get("sessionID"),
        props.get("sessionId"),
        info.get("sessionID"),
        info.get("sessionId"),
        info.get("id"),  # session.created/info.id
        part.get("sessionID"),
        payload.get("session_id"),
        payload.get("sessionId"),
    ):
        if candidate:
            return str(candidate)
    return "unknown-session"


def _event_captured_at(payload: Dict[str, Any]) -> datetime:
    dt = _parse_dt(payload.get("captured_at"))
    if dt:
        return dt
    ev = _event_obj(payload)
    dt = _parse_dt(ev.get("timestamp"))
    if dt:
        return dt
    return datetime.now(timezone.utc)


def _is_older_event(last_seen: Dict[str, Any], key: str, event_dt: datetime) -> bool:
    prev = _parse_dt(last_seen.get(key))
    if prev is None:
        return False
    return event_dt < prev


def _build_client():
    try:
        from langfuse import Langfuse  # type: ignore
    except Exception:
        return None

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
    base_url = os.environ.get("LANGFUSE_BASE_URL", "").strip()
    if not public_key or not secret_key:
        return None

    try:
        kwargs: Dict[str, Any] = {"public_key": public_key, "secret_key": secret_key}
        if base_url:
            kwargs["base_url"] = base_url
        return Langfuse(**kwargs)
    except TypeError:
        try:
            kwargs = {"public_key": public_key, "secret_key": secret_key}
            if base_url:
                kwargs["host"] = base_url
            return Langfuse(**kwargs)
        except Exception:
            return None
    except Exception:
        return None


def _extract_text_from_parts(parts_map: Dict[str, Any]) -> str:
    rows: List[Tuple[datetime, str, str]] = []
    for part in parts_map.values():
        p = _as_dict(part)
        if p.get("type") != "text":
            continue
        text = p.get("text")
        if not isinstance(text, str) or not text:
            continue
        ts = _parse_dt(_as_dict(p.get("time")).get("start")) or datetime.now(timezone.utc)
        rows.append((ts, str(p.get("id") or ""), text))
    rows.sort(key=lambda x: (x[0], x[1]))
    return "\n".join([r[2] for r in rows]).strip()


def _serialize_part(part: Dict[str, Any]) -> Dict[str, Any]:
    p = _as_dict(part)
    time_obj = _as_dict(p.get("time"))
    state_obj = _as_dict(p.get("state"))

    out: Dict[str, Any] = {
        "id": p.get("id"),
        "message_id": p.get("messageID"),
        "type": p.get("type"),
        "time": _safe_json(time_obj) if time_obj else {},
    }

    if isinstance(p.get("text"), str):
        out["text"] = _truncate(p.get("text"))
    if p.get("tool"):
        out["tool"] = p.get("tool")
    if p.get("metadata") is not None:
        out["metadata"] = _safe_json(p.get("metadata"))
    if state_obj:
        out["state"] = {
            "status": state_obj.get("status"),
            "input": _safe_json(state_obj.get("input")),
            "output": _truncate(state_obj.get("output")) if isinstance(state_obj.get("output"), str) else _safe_json(state_obj.get("output")),
            "error": _truncate(state_obj.get("error")) if isinstance(state_obj.get("error"), str) else _safe_json(state_obj.get("error")),
            "metadata": _safe_json(state_obj.get("metadata")),
        }
    return out


def _append_message_event(state: Dict[str, Any], key: str, info: Dict[str, Any]) -> None:
    state["message_events"].setdefault(key, [])
    state["message_events"][key].append(
        {
            "captured_at": _iso_now(),
            "info": _safe_json(info),
        }
    )
    if len(state["message_events"][key]) > MAX_MESSAGE_EVENTS_PER_MESSAGE:
        state["message_events"][key] = state["message_events"][key][-MAX_MESSAGE_EVENTS_PER_MESSAGE:]


def _parts_type_counts(parts_map: Dict[str, Any]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for part in parts_map.values():
        ptype = str(_as_dict(part).get("type") or "unknown")
        counts[ptype] = counts.get(ptype, 0) + 1
    return counts


def _build_turn_details(parts_map: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    text_rows: List[Tuple[datetime, str, str]] = []
    reasoning_rows: List[Dict[str, Any]] = []
    tools: List[Dict[str, Any]] = []

    for part in parts_map.values():
        p = _as_dict(part)
        ptype = str(p.get("type") or "")
        pid = str(p.get("id") or "")
        time_obj = _as_dict(p.get("time"))
        ts = _parse_dt(time_obj.get("start")) or datetime.now(timezone.utc)

        if ptype == "text":
            txt = p.get("text")
            if isinstance(txt, str) and txt:
                text_rows.append((ts, pid, txt))
            continue

        if ptype == "reasoning":
            txt = p.get("text")
            if isinstance(txt, str) and txt:
                reasoning_rows.append({"id": pid, "text": txt, "timestamp": ts, "meta": _safe_json(p.get("metadata"))})
            continue

        if ptype == "tool":
            state = _as_dict(p.get("state"))
            status = str(state.get("status") or "")
            # Emit once tool reaches a terminal state.
            if status not in {"completed", "error"}:
                continue
            tool_time = _as_dict(state.get("time"))
            source_start = _parse_dt(tool_time.get("start")) or _parse_dt(time_obj.get("start"))
            source_end = _parse_dt(tool_time.get("end")) or _parse_dt(time_obj.get("end"))
            input_obj = state.get("input")
            output_txt = state.get("output") if status == "completed" else state.get("error")
            tools.append(
                {
                    "id": pid,
                    "name": p.get("tool") or "tool",
                    "timestamp": source_start,
                    "end_time": source_end,
                    "call_id": p.get("callID") or pid,
                    "status": status,
                    "input": json.dumps(input_obj, ensure_ascii=False) if isinstance(input_obj, (dict, list)) else str(input_obj or ""),
                    "output": str(output_txt or ""),
                    "meta": _safe_json(state.get("metadata")),
                }
            )

    text_rows.sort(key=lambda x: (x[0], x[1]))
    reasoning_rows.sort(key=lambda x: (x["timestamp"], x["id"]))
    tools.sort(key=lambda x: (x["timestamp"] or datetime.max.replace(tzinfo=timezone.utc), x["id"]))
    output_text = "\n".join([r[2] for r in text_rows]).strip()
    return output_text, reasoning_rows, tools


def _emit_lifecycle_trace(client: Any, payload: Dict[str, Any], event_name: str, session_id: str) -> None:
    name = f"OpenCode {event_name}"
    user_id = _user_id()
    metadata = {
        "product": "opencode",
        "reconstruction": "plugin-event-lifecycle",
        "source": "opencode",
        "event": event_name,
        "session_id": session_id,
        "user_id": user_id,
        "hostname": socket.gethostname(),
        "payload": _safe_json(_event_obj(payload)),
    }
    try:
        with client.start_as_current_observation(as_type="span", name=name, metadata=metadata, input=_event_obj(payload)):
            if hasattr(client, "update_current_trace"):
                client.update_current_trace(
                    name=name,
                    session_id=session_id,
                    user_id=user_id,
                    tags=["opencode", "hook-only", "lifecycle"],
                    metadata=metadata,
                )
        client.flush()
    except Exception as exc:
        _log("DEBUG", f"lifecycle emit failed: {exc}")


def _stable_id(*parts: str) -> str:
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:32]


def _otlp_enabled() -> bool:
    return os.environ.get("CODING_AGENT_OTLP_ENABLED") != "false" and bool(
        os.environ.get("CODING_AGENT_OTLP_TRACES_ENDPOINT") or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    )


def _shared_cli() -> str:
    deployed = Path.home() / ".local" / "share" / "langfuse-agent-hooks" / "src" / "cli.ts"
    repo_cli = Path(__file__).resolve().parents[2] / "ts" / "src" / "cli.ts"
    return os.environ.get("OPENCODE_LANGFUSE_OTLP_CLI") or str(deployed if deployed.is_file() else repo_cli)


def _github_context() -> Optional[Dict[str, Any]]:
    try:
        result = subprocess.run(["node", _shared_cli(), "github-context", "opencode"],
                                capture_output=True, timeout=5, check=False)
        if result.returncode == 0:
            context = json.loads(result.stdout)
            if isinstance(context, dict):
                return context
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def _export_otlp(events: List[Dict[str, Any]]) -> bool:
    try:
        result = subprocess.run(["node", _shared_cli(), "export-otlp", "opencode"], input=json.dumps(events).encode(),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired) as exc:
        _log("DEBUG", f"OTLP export failed: {type(exc).__name__}")
        return False


def _export_langfuse(events: List[Dict[str, Any]]) -> bool:
    base_url = os.environ.get("LANGFUSE_BASE_URL", "").strip().rstrip("/")
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
    credentials = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    try:
        request = Request(base_url + "/api/public/ingestion", data=json.dumps({"batch": events}).encode(),
                          headers={"Content-Type": "application/json", "Authorization": f"Basic {credentials}"})
        with urlopen(request, timeout=6) as response:
            return not json.load(response).get("errors")
    except Exception as exc:
        _log("DEBUG", f"turn ingestion failed: {type(exc).__name__}")
        return False


def _emit_turn_trace(state: Dict[str, Any], session_id: str, parent_id: str, messages: List[Tuple[str, Dict[str, Any]]]) -> bool:
    trace_id = _stable_id("opencode", session_id, parent_id)
    root_id = _stable_id(trace_id, "agent")
    user_parts = _as_dict(state["user_parts"].get(_msg_key(session_id, parent_id)))
    prompt = _extract_text_from_parts(user_parts)
    events: List[Dict[str, Any]] = []
    now = _iso_now()

    def add(kind: str, **body: Any) -> None:
        events.append({"id": str(uuid.uuid4()), "timestamp": now, "type": kind,
                       "body": {k: v for k, v in body.items() if v is not None}})

    generation_ids = [_stable_id(trace_id, key) for key, _ in messages]
    start = _as_dict(messages[0][1].get("time")).get("created")
    completed = _parse_dt(_as_dict(messages[-1][1].get("time")).get("completed"))
    first = _parse_dt(start)
    final = ""
    carried: List[Dict[str, Any]] = [{"role": "user", "content": _truncate(prompt)}]
    for index, (key, info) in enumerate(messages):
        parts = _as_dict(state["assistant_parts"].get(key))
        final, reasoning, tools = _build_turn_details(parts)
        created = _parse_dt(_as_dict(info.get("time")).get("created"))
        finished = _parse_dt(_as_dict(info.get("time")).get("completed"))
        started = next((_parse_dt(p.get("_captured_at")) for p in parts.values() if p.get("type") == "step-start"), None)
        starts = [t["timestamp"] for t in tools if t["timestamp"]]
        ended = min(starts) if starts else finished
        usage = _as_dict(info.get("tokens"))
        cache = _as_dict(usage.get("cache"))
        generation = generation_ids[index]
        add("generation-create", id=generation, traceId=trace_id, parentObservationId=root_id,
            name=info.get("modelID") or "OpenCode model", model=info.get("modelID"),
            startTime=(started or created).isoformat() if (started or created) else now,
            endTime=ended.isoformat() if ended else None, input=carried,
            output={"text": _truncate(final), "toolCalls": [
                {"id": t["call_id"], "name": t["name"], "input": _truncate(t["input"])} for t in tools]},
            usageDetails={"input": usage.get("input", 0), "output": usage.get("output", 0),
                          "total": usage.get("total", 0), "reasoning": usage.get("reasoning", 0),
                          "input_cached_tokens": cache.get("read", 0), "input_cache_creation": cache.get("write", 0)},
            metadata={"provider": info.get("providerID"), "messageId": info.get("id"),
                      "finish": info.get("finish"), "reasoning": [_truncate(r["text"]) for r in reasoning]})
        carried = []
        for tool in tools:
            tool_start, tool_end = tool["timestamp"], tool["end_time"]
            call_id = tool["call_id"]
            add("tool-create", id=_stable_id(generation, str(call_id)), traceId=trace_id,
                parentObservationId=root_id, name="tool:" + tool["name"],
                startTime=tool_start.isoformat() if tool_start else None,
                endTime=tool_end.isoformat() if tool_end else None,
                input=_truncate(tool["input"]), output=_truncate(tool["output"]),
                level="ERROR" if tool["status"] == "error" else None,
                metadata={"toolCallId": call_id, "issuedByObservationId": generation,
                          "consumedByObservationId": generation_ids[index + 1] if index + 1 < len(messages) else None})
            carried.append({"role": "tool", "call_id": call_id, "content": _truncate(tool["output"])})

    title = f"OpenCode turn {parent_id}"
    start_time = first.isoformat() if first else now
    end_time = completed.isoformat() if completed else None
    input_data, output_data = _truncate(prompt), _truncate(final)
    metadata = {"source": "opencode", "generationCount": len(messages), "device": _device()}
    github = _github_context()
    if github:
        metadata["github"] = github
    add("trace-create", id=trace_id, name=title, sessionId=session_id,
        userId=_user_id(), timestamp=start_time, environment=os.environ.get("LANGFUSE_TRACING_ENVIRONMENT"),
        input=input_data, output=output_data, tags=["opencode", socket.gethostname()],
        metadata=metadata)
    add("agent-create", id=root_id, traceId=trace_id, name="OpenCode", startTime=start_time,
        endTime=end_time, input=input_data, output=output_data)

    batch = events[-2:] + events[:-2]
    with ThreadPoolExecutor(max_workers=2) as pool:
        sends = []
        if os.environ.get("TRACE_TO_LANGFUSE", "").strip().lower() == "true":
            sends.append(pool.submit(_export_langfuse, batch))
        if _otlp_enabled():
            sends.append(pool.submit(_export_otlp, batch))
        return all([future.result() for future in sends])


def _maybe_emit_assistant_turn(state: Dict[str, Any], session_id: str, message_id: str, info: Dict[str, Any]) -> None:
    parent_id = str(info.get("parentID") or "")
    if not parent_id or info.get("finish") in {None, "tool-calls", "unknown"}:
        return
    if not _as_dict(info.get("time")).get("completed"):
        return
    turn_id = _turn_key(session_id, message_id)
    if state["emitted"].get(turn_id):
        return
    prefix = f"{session_id}:"
    group = [(key, msg) for key, msg in state["messages"].items()
             if key.startswith(prefix) and msg.get("role") == "assistant" and msg.get("parentID") == parent_id]
    group.sort(key=lambda item: (_as_dict(item[1].get("time")).get("created") or 0, item[0]))
    final_key = _msg_key(session_id, message_id)
    final_index = next((index for index, (key, _) in enumerate(group) if key == final_key), -1)
    if final_index < 0 or not state["assistant_parts"].get(final_key):
        return
    group = group[:final_index + 1]
    if not _emit_turn_trace(state, session_id, parent_id, group):
        return
    for key, msg in group:
        state["emitted"][_turn_key(session_id, str(msg["id"]))] = _iso_now()
        state["assistant_parts"].pop(key, None)
        state["message_events"].pop(key, None)
        state["assistant_finish_seen"].pop(key, None)
    user_key = _msg_key(session_id, parent_id)
    state["user_parts"].pop(user_key, None)
    state["message_events"].pop(user_key, None)
    _log("INFO", f"turn emitted session={session_id} turn_id={turn_id} generations={len(group)}")


def _cleanup_emitted_message_buffers(state: Dict[str, Any], session_id: str, message_id: str) -> None:
    key = _msg_key(session_id, message_id)
    state["assistant_parts"].pop(key, None)
    state["message_events"].pop(key, None)
    state["assistant_finish_seen"].pop(key, None)


def _flush_pending_assistant_turns(state: Dict[str, Any], session_id: str, reason: str) -> None:
    if not session_id or session_id == "unknown-session":
        return

    prefix = f"{session_id}:"
    emitted_now = 0
    scanned = 0
    assistant_parts_map = _as_dict(state.get("assistant_parts"))

    for key in list(assistant_parts_map.keys()):
        if not isinstance(key, str) or not key.startswith(prefix):
            continue
        scanned += 1
        message_id = key[len(prefix):]
        if not message_id:
            continue

        turn_id = _turn_key(session_id, message_id)
        if state["emitted"].get(turn_id):
            _cleanup_emitted_message_buffers(state, session_id, message_id)
            continue

        parts_map = _as_dict(assistant_parts_map.get(key))
        if not parts_map:
            continue

        info = _as_dict(_as_dict(state.get("messages")).get(key))
        if not info:
            info = {"id": message_id, "role": "assistant", "time": {}, "parentID": ""}

        before = bool(state["emitted"].get(turn_id))
        _maybe_emit_assistant_turn(state, session_id, message_id, info)
        after = bool(state["emitted"].get(turn_id))
        if after and not before:
            emitted_now += 1

    if emitted_now > 0:
        _log("INFO", f"flush emitted pending turns session={session_id} reason={reason} scanned={scanned} emitted={emitted_now}")


def _handle_message_updated(state: Dict[str, Any], payload: Dict[str, Any], session_id: str) -> None:
    info = _as_dict(_event_props(payload).get("info"))
    message_id = str(info.get("id") or "")
    if not message_id:
        return

    key = _msg_key(session_id, message_id)
    event_dt = _event_captured_at(payload)
    message_last_seen = _as_dict(state.get("message_last_seen"))
    state["message_last_seen"] = message_last_seen
    if _is_older_event(message_last_seen, key, event_dt):
        return
    message_last_seen[key] = event_dt.isoformat()

    state["messages"][key] = info

    role = str(info.get("role") or "").lower()
    if role == "assistant":
        turn_id = _turn_key(session_id, message_id)
        if state["emitted"].get(turn_id):
            _cleanup_emitted_message_buffers(state, session_id, message_id)
            return

    _append_message_event(state, key, info)

    # Reconcile out-of-order message.part.updated events.
    pending = _as_dict(state["pending_parts"].pop(key, {}))
    if pending:
        if role in {"assistant", "user"}:
            bucket = "assistant_parts" if role == "assistant" else "user_parts"
            state[bucket].setdefault(key, {}).update(pending)
        else:
            state["pending_parts"][key] = pending

    if role != "assistant":
        return

    completed = bool(_as_dict(info.get("time")).get("completed"))
    if completed:
        state["assistant_finish_seen"][key] = _iso_now()
        _maybe_emit_assistant_turn(state, session_id, message_id, info)


def _handle_message_part_updated(state: Dict[str, Any], payload: Dict[str, Any], session_id: str) -> None:
    part = _as_dict(_event_props(payload).get("part"))
    message_id = str(part.get("messageID") or "")
    part_id = str(part.get("id") or "")
    if not message_id or not part_id:
        return

    key = _msg_key(session_id, message_id)
    event_dt = _event_captured_at(payload)
    part_key = f"{key}:{part_id}"
    part_last_seen = _as_dict(state.get("part_last_seen"))
    state["part_last_seen"] = part_last_seen
    if _is_older_event(part_last_seen, part_key, event_dt):
        return
    part_last_seen[part_key] = event_dt.isoformat()

    turn_id = _turn_key(session_id, message_id)
    if state["emitted"].get(turn_id):
        _cleanup_emitted_message_buffers(state, session_id, message_id)
        return

    msg = _as_dict(state["messages"].get(key))
    role = str(msg.get("role") or "").lower()
    part_type = str(part.get("type") or "")
    part["_captured_at"] = event_dt.isoformat()

    # Fallback inference when message.updated has not arrived yet.
    if not role:
        if part_type in {"reasoning", "tool", "step-start", "step-finish", "patch", "agent", "retry", "compaction"}:
            role = "assistant"
        elif part_type == "text":
            # Keep text parts pending until we know whether this message is user/assistant.
            state["pending_parts"].setdefault(key, {})
            state["pending_parts"][key][part_id] = part
            return

    bucket = "assistant_parts" if role == "assistant" else "user_parts"
    state[bucket].setdefault(key, {})
    state[bucket][key][part_id] = part

    if role == "assistant":
        if part_type == "step-finish":
            state["assistant_finish_seen"][key] = _iso_now()
        completed = bool(_as_dict(msg.get("time")).get("completed")) if msg else False
        finish_seen = bool(_as_dict(state.get("assistant_finish_seen")).get(key))
        if completed and finish_seen:
            _maybe_emit_assistant_turn(state, session_id, message_id, msg or {"id": message_id, "role": "assistant"})


def main() -> None:
    _load_dotenv()

    langfuse_enabled = os.environ.get("TRACE_TO_LANGFUSE", "").strip().lower() == "true"
    if not langfuse_enabled and not _otlp_enabled():
        return

    payload = _read_payload()
    if not payload:
        return

    client = _build_client() if langfuse_enabled else None
    if client is None and not _otlp_enabled():
        return

    event_name = _event_name(payload)
    session_id = _session_id(payload)
    _log("DEBUG", f"event={event_name} session={session_id}")
    with _state_lock():
        state = _load_state()
        lifecycle_map = _as_dict(state.get("session_lifecycle"))
        state["session_lifecycle"] = lifecycle_map

        if event_name == "message.updated":
            _handle_message_updated(state, payload, session_id)
        elif event_name == "message.part.updated":
            _handle_message_part_updated(state, payload, session_id)
            last = _as_dict(lifecycle_map.get(session_id))
            last_event = str(last.get("event") or "")
            if last_event in {"session.idle", "session.error", "session.compacted"}:
                _flush_pending_assistant_turns(state, session_id, f"{last_event}:post-part")
        elif event_name in {"message.removed", "message.part.removed"}:
            # Best-effort cleanup events can be handled later if needed.
            pass

        if event_name in {"session.created", "session.idle", "session.error", "session.compacted"}:
            event_dt = _event_captured_at(payload)
            prev = _as_dict(lifecycle_map.get(session_id))
            prev_dt = _parse_dt(prev.get("at"))
            if prev_dt is None or event_dt >= prev_dt:
                lifecycle_map[session_id] = {"event": event_name, "at": event_dt.isoformat()}

        if event_name in {"session.idle", "session.error", "session.compacted"}:
            _flush_pending_assistant_turns(state, session_id, event_name)

        if client is not None and event_name in {"session.created", "session.idle", "session.error", "session.compacted"}:
            _emit_lifecycle_trace(client, payload, event_name, session_id)

        _save_state(state)
        _log(
            "DEBUG",
            (
                "state-saved "
                f"messages={len(_as_dict(state.get('messages')))} "
                f"message_events={len(_as_dict(state.get('message_events')))} "
                f"user_parts={len(_as_dict(state.get('user_parts')))} "
                f"assistant_parts={len(_as_dict(state.get('assistant_parts')))} "
                f"assistant_finish_seen={len(_as_dict(state.get('assistant_finish_seen')))} "
                f"pending_parts={len(_as_dict(state.get('pending_parts')))} "
                f"emitted={len(_as_dict(state.get('emitted')))}"
            ),
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            _load_dotenv()
            _log("ERROR", f"fatal exception: {exc}")
        except Exception:
            pass
        # fail-open: never block OpenCode
        pass
