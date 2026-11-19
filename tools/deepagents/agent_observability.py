"""Export one Deep Agents invocation using its LangChain callbacks."""

import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _message(message: Any) -> dict:
    if isinstance(message, dict):
        return {"role": message.get("role"), "content": message.get("content")}
    role = {"human": "user", "ai": "assistant"}.get(message.type, message.type)
    value = {"role": role, "content": message.content}
    if role == "tool":
        value["call_id"] = message.tool_call_id
    return value


def _usage(message: Any) -> dict | None:
    value = getattr(message, "usage_metadata", None)
    if not value or not all(isinstance(value.get(key), int) for key in ("input_tokens", "output_tokens")):
        return None
    details = value.get("input_token_details") or {}
    cached = details.get("cache_read") or 0
    created = details.get("cache_creation") or 0
    return {"input": max(0, value["input_tokens"] - cached - created), "output": value["output_tokens"],
            "input_cached_tokens": cached, "input_cache_creation": created,
            "total": value.get("total_tokens", value["input_tokens"] + value["output_tokens"])}


class DeepAgentsObserver(BaseCallbackHandler):
    """Pass a fresh instance in the run config's callbacks for each invocation."""

    def __init__(self, session_id: str | None = None, cli: Path | None = None):
        self.session_id = session_id
        self.cli = cli or Path(os.environ.get("CODING_AGENT_HOOKS_CLI") or
                               Path.home() / ".local/share/langfuse-agent-hooks/src/cli.ts")
        self.lock = RLock()
        self.root = None
        self.turn: dict = {}
        self.models: dict = {}
        self.tools: dict = {}

    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is not None or self.root is not None:
            return
        self.root = run_id
        messages = inputs.get("messages", []) if isinstance(inputs, dict) else []
        self.turn = {"key": str(run_id), "index": 1, "offset": 0,
                     "sessionId": self.session_id or str(run_id), "startTime": _now(),
                     "input": [_message(message) for message in messages], "steps": [],
                     "toolResults": [], "events": [], "metadata": {"agent": "deepagents"}}

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        if not self.turn:
            return
        step = {"kind": "generation", "key": str(run_id), "name": "Deep Agents model", "startTime": _now(),
                "input": [_message(message) for group in messages for message in group]}
        with self.lock:
            self.models[run_id] = step

    def on_llm_end(self, response, *, run_id, **kwargs):
        with self.lock:
            step = self.models.pop(run_id, None)
            if not step or not response.generations or not response.generations[0]:
                return
            message = getattr(response.generations[0][0], "message", None)
            if message is None:
                return
            model = (message.response_metadata or {}).get("model_name")
            calls = [{"type": "tool_call", "id": call["id"], "name": call["name"], "input": call["args"]}
                     for call in getattr(message, "tool_calls", []) if call.get("id")]
            step.update(endTime=_now(), output={"text": message.content, "content": calls})
            if model:
                step.update(model=model, name=model)
            usage = _usage(message)
            if usage is not None:
                step["usage"] = usage
            self.turn["steps"].append(step)

    def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        if not self.turn:
            return
        with self.lock:
            self.tools[run_id] = {"kind": "tool", "name": (serialized or {}).get("name", "tool"),
                                  "startTime": _now(), "input": inputs if inputs is not None else input_str}

    def on_tool_end(self, output, *, run_id, **kwargs):
        with self.lock:
            step = self.tools.pop(run_id, None)
            if not step:
                return
            call_id = getattr(output, "tool_call_id", None)
            end = _now()
            step.update(key=call_id or str(run_id), endTime=end, output=getattr(output, "content", output),
                        isError=getattr(output, "status", None) == "error")
            self.turn["steps"].append(step)
            if call_id:
                self.turn["toolResults"].append({"key": call_id, "time": end})

    def on_chain_end(self, outputs, *, run_id, **kwargs):
        if run_id != self.root or not self.turn:
            return
        messages = outputs.get("messages", []) if isinstance(outputs, dict) else []
        final = next((message.content for message in reversed(messages) if getattr(message, "type", None) == "ai"), None)
        self.turn.update(endTime=_now(), output=final, complete=True)
        self.turn["steps"].sort(key=lambda step: step["startTime"])
        self._send()

    def _send(self):
        try:
            result = subprocess.run(["node", str(self.cli), "export-turn", "deepagents"],
                                    input=json.dumps(self.turn, default=str).encode("utf-8"),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
            if result.returncode:
                logging.getLogger(__name__).warning("Deep Agents trace export failed")
        except (OSError, subprocess.TimeoutExpired):
            logging.getLogger(__name__).warning("Deep Agents trace export unavailable")
