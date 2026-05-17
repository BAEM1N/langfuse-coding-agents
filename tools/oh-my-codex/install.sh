#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# langfuse-oh-my-codex installer (macOS / Linux)
# ─────────────────────────────────────────────

HOOK_NAME="langfuse_hook.py"
BRIDGE_NAME="codex-native-bridge.py"
OMX_DIR="$HOME/.omx"
HOOKS_DIR="$OMX_DIR/hooks"
ENV_FILE="$OMX_DIR/.env"
CODEX_DIR="$HOME/.codex"
CODEX_HOOKS_FILE="$CODEX_DIR/hooks.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  langfuse-oh-my-codex installer          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Check Python ──────────────────────────
step "Checking Python installation..."
PYTHON=""
if command -v python3 &>/dev/null && python3 --version &>/dev/null 2>&1; then
    PYTHON="python3"
elif command -v python &>/dev/null && python --version &>/dev/null 2>&1; then
    PYTHON="python"
else
    error "Python not found. Please install Python 3.8+ first."
    exit 1
fi

PY_VERSION=$($PYTHON -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$($PYTHON -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$($PYTHON -c 'import sys; print(sys.version_info.minor)')

if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 8 ]]; }; then
    error "Python 3.8+ required, found $PY_VERSION"
    exit 1
fi

info "Found $PYTHON ($PY_VERSION)"

# ── 2. Install langfuse SDK ──────────────────
step "Installing langfuse Python SDK..."
$PYTHON -m pip install --quiet --upgrade langfuse
info "langfuse SDK installed."

# ── 3. Copy hook script + codex-native bridge ──
step "Copying hook script..."
mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/$HOOK_NAME" "$HOOKS_DIR/$HOOK_NAME"
chmod +x "$HOOKS_DIR/$HOOK_NAME"
info "Hook script installed: $HOOKS_DIR/$HOOK_NAME"

if [[ -f "$SCRIPT_DIR/$BRIDGE_NAME" ]]; then
    cp "$SCRIPT_DIR/$BRIDGE_NAME" "$HOOKS_DIR/$BRIDGE_NAME"
    chmod +x "$HOOKS_DIR/$BRIDGE_NAME"
    info "Codex native bridge installed: $HOOKS_DIR/$BRIDGE_NAME"
fi

# ── 4. Clean previous state (optional) ──────
if [[ -f "$HOOKS_DIR/langfuse_state.json" ]]; then
    echo ""
    read -rp "  Previous state file found. Reset trace offsets? [y/N]: " RESET_STATE
    if [[ "${RESET_STATE,,}" == "y" ]]; then
        rm -f "$HOOKS_DIR/langfuse_state.json"
        info "State file reset."
    fi
fi

# ── 5. Collect Langfuse credentials ─────────
echo ""
step "Configuring Langfuse credentials..."
echo "  Get your keys from https://cloud.langfuse.com (or your self-hosted instance)."
echo ""

read -rp "  Langfuse Public Key  : " LF_PUBLIC_KEY
read -rsp "  Langfuse Secret Key  : " LF_SECRET_KEY
echo ""
read -rp "  Langfuse Base URL    [https://cloud.langfuse.com]: " LF_BASE_URL
LF_BASE_URL="${LF_BASE_URL:-https://cloud.langfuse.com}"

read -rp "  User ID (trace attribution) [omx-user]: " LF_USER_ID
LF_USER_ID="${LF_USER_ID:-omx-user}"

if [[ -z "$LF_PUBLIC_KEY" || -z "$LF_SECRET_KEY" ]]; then
    error "Public Key and Secret Key are required."
    exit 1
fi

# ── 6. Write credentials to .env ──────────────
step "Writing credentials to $ENV_FILE..."
mkdir -p "$OMX_DIR"

cat > "$ENV_FILE" <<ENVEOF
# Langfuse credentials for langfuse-oh-my-codex
# Environment variables take priority over .env values.

TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=${LF_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LF_SECRET_KEY}
LANGFUSE_BASE_URL=${LF_BASE_URL}
LANGFUSE_USER_ID=${LF_USER_ID}
ENVEOF

info "Credentials written to $ENV_FILE"

# ── 7. Wire to Codex native hooks (~/.codex/hooks.json) ──
# Codex CLI 0.128+ ships a native hook system (PreToolUse, PostToolUse, Stop,
# SessionStart, UserPromptSubmit, ...). We add a SECOND matcher group per event
# that runs codex-native-bridge.py — preserving any existing entries (e.g.
# oh-my-codex's codex-native-hook.js). Idempotent: skips events that already
# reference codex-native-bridge.py.
if [[ -f "$HOOKS_DIR/$BRIDGE_NAME" ]]; then
    step "Wiring Codex native hook system → langfuse..."
    mkdir -p "$CODEX_DIR"

    if [[ -f "$CODEX_HOOKS_FILE" ]]; then
        cp "$CODEX_HOOKS_FILE" "${CODEX_HOOKS_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    PY_ABSOLUTE="$($PYTHON -c 'import sys; print(sys.executable)')"
    HOOKS_FILE="$CODEX_HOOKS_FILE" \
    BRIDGE_PATH="$HOOKS_DIR/$BRIDGE_NAME" \
    PY_PATH="$PY_ABSOLUTE" \
        "$PYTHON" - <<'PYEOF'
import json, os
from pathlib import Path

p = Path(os.environ["HOOKS_FILE"])
bridge = os.environ["BRIDGE_PATH"]
py = os.environ["PY_PATH"]

data = json.loads(p.read_text()) if p.exists() else {"hooks": {}}
data.setdefault("hooks", {})

handler = {
    "type": "command",
    "command": f'{py} "{bridge}"',
    "timeout": 10,
    "statusMessage": "langfuse trace",
}

EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]
added = []
for ev in EVENTS:
    groups = data["hooks"].get(ev, [])
    already = any(
        any(bridge in (h.get("command") or "") for h in g.get("hooks", []))
        for g in groups
    )
    if already:
        continue
    groups.append({"hooks": [handler]})
    data["hooks"][ev] = groups
    added.append(ev)

p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"  added langfuse handler to: {', '.join(added) if added else '(none — already wired)'}")
PYEOF
    info "Codex hooks wired: $CODEX_HOOKS_FILE"
fi

# ── 8. Verify ────────────────────────────────
step "Verifying installation..."
if $PYTHON -c "import langfuse" 2>/dev/null; then
    info "langfuse SDK: OK"
else
    warn "langfuse SDK import failed. Check your Python environment."
fi

if [[ -f "$HOOKS_DIR/$HOOK_NAME" ]]; then
    info "Hook script: OK"
else
    warn "Hook script not found at $HOOKS_DIR/$HOOK_NAME"
fi

if [[ -f "$HOOKS_DIR/$BRIDGE_NAME" ]]; then
    info "Codex native bridge: OK"
fi

# ── Done ─────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Installation complete!                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
info "Codex CLI native hooks → langfuse_hook.py wired automatically."
info "Re-run codex once; check Langfuse dashboard for new traces."
echo ""
echo "  Dashboard       : ${LF_BASE_URL}"
echo "  Logs            : ~/.omx/hooks/langfuse_hook.log (Python errors)"
echo "  Codex hooks     : ~/.codex/hooks.json"
echo "  Disable         : set TRACE_TO_LANGFUSE=false in ~/.omx/.env"
echo ""
