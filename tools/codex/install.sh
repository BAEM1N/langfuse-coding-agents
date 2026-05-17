#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# langfuse-codex installer (macOS / Linux)
# Native Langfuse tracing for Codex CLI 0.128+
# ─────────────────────────────────────────────

HOOK_NAME="langfuse_hook.py"
CODEX_DIR="$HOME/.codex"
HOOKS_DIR="$CODEX_DIR/hooks"
STATE_DIR="$CODEX_DIR/state"
HOOKS_FILE="$CODEX_DIR/hooks.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  langfuse-codex installer                ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Check Codex CLI ───────────────────────
step "Checking Codex CLI installation..."
if ! command -v codex &>/dev/null; then
    error "Codex CLI not found in PATH. Install from https://github.com/openai/codex first."
    exit 1
fi

CODEX_VER=$(codex --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
info "Codex CLI version: $CODEX_VER"

# Warn if older than 0.128 (when native hook system shipped)
if [[ "$CODEX_VER" != "unknown" ]]; then
    CODEX_MAJOR=$(echo "$CODEX_VER" | cut -d. -f1)
    CODEX_MINOR=$(echo "$CODEX_VER" | cut -d. -f2)
    if (( CODEX_MAJOR == 0 && CODEX_MINOR < 128 )); then
        warn "Codex $CODEX_VER may lack native hooks (require 0.128+). Continuing anyway."
    fi
fi

# ── 2. Check Python ──────────────────────────
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

# ── 3. Install langfuse SDK ──────────────────
step "Installing langfuse Python SDK..."
$PYTHON -m pip install --quiet --upgrade langfuse
info "langfuse SDK installed."

# ── 4. Copy hook script ─────────────────────
step "Copying hook script..."
mkdir -p "$HOOKS_DIR" "$STATE_DIR"
cp "$SCRIPT_DIR/$HOOK_NAME" "$HOOKS_DIR/$HOOK_NAME"
chmod +x "$HOOKS_DIR/$HOOK_NAME"
info "Hook script installed: $HOOKS_DIR/$HOOK_NAME"

# ── 5. Clean previous state (optional) ──────
if [[ -f "$STATE_DIR/langfuse_state.json" ]]; then
    echo ""
    read -rp "  Previous state file found. Reset trace offsets? [y/N]: " RESET_STATE
    if [[ "${RESET_STATE,,}" == "y" ]]; then
        rm -f "$STATE_DIR/langfuse_state.json"
        info "State file reset."
    fi
fi

# ── 6. Collect Langfuse credentials ─────────
echo ""
step "Configuring Langfuse credentials..."
echo "  Get your keys from https://cloud.langfuse.com (or your self-hosted instance)."
echo ""

read -rp "  Langfuse Public Key  : " LF_PUBLIC_KEY
read -rsp "  Langfuse Secret Key  : " LF_SECRET_KEY
echo ""
read -rp "  Langfuse Base URL    [https://cloud.langfuse.com]: " LF_BASE_URL
LF_BASE_URL="${LF_BASE_URL:-https://cloud.langfuse.com}"

read -rp "  User ID (trace attribution) [codex-user]: " LF_USER_ID
LF_USER_ID="${LF_USER_ID:-codex-user}"

if [[ -z "$LF_PUBLIC_KEY" || -z "$LF_SECRET_KEY" ]]; then
    error "Public Key and Secret Key are required."
    exit 1
fi

# ── 7. Write credentials to .env ──────────────
step "Writing credentials to $CODEX_DIR/.env..."
ENV_FILE="$CODEX_DIR/.env"
mkdir -p "$CODEX_DIR"

cat > "$ENV_FILE" <<ENVEOF
# Langfuse credentials for langfuse-codex
# Environment variables take priority over .env values.

TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=${LF_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LF_SECRET_KEY}
LANGFUSE_BASE_URL=${LF_BASE_URL}
LANGFUSE_USER_ID=${LF_USER_ID}
ENVEOF

chmod 600 "$ENV_FILE"
info "Credentials written to $ENV_FILE"

# ── 8. Write hooks.json (6 events) ────────────
step "Writing $HOOKS_FILE..."

HOOK_CMD="$PYTHON $HOOKS_DIR/$HOOK_NAME"

# Smart merge: preserve existing non-langfuse hooks in hooks.json, replace only langfuse entries.
$PYTHON - "$HOOKS_FILE" "$HOOK_CMD" <<'PYEOF'
import json, sys, os

hooks_path = sys.argv[1]
hook_command = sys.argv[2]

# Load existing hooks.json
if os.path.exists(hooks_path):
    try:
        with open(hooks_path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception:
        doc = {}
else:
    doc = {}

# Codex hooks.json schema: top-level "hooks" key
if "hooks" not in doc or not isinstance(doc["hooks"], dict):
    doc["hooks"] = {}

langfuse_entry = {
    "hooks": [{"type": "command", "command": hook_command}]
}

def upsert_hook(doc, event_name, langfuse_entry):
    hook_list = doc["hooks"].get(event_name, [])
    if not isinstance(hook_list, list):
        hook_list = []
    replaced = False
    for i, entry in enumerate(hook_list):
        if not isinstance(entry, dict):
            continue
        for h in entry.get("hooks", []):
            if isinstance(h, dict) and "langfuse_hook" in h.get("command", ""):
                hook_list[i] = langfuse_entry
                replaced = True
                break
        if replaced:
            break
    if not replaced:
        hook_list.append(langfuse_entry)
    doc["hooks"][event_name] = hook_list
    return len(hook_list), replaced

# 6 events covered by langfuse-codex
ALL_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"]

results = []
for event in ALL_EVENTS:
    n, replaced = upsert_hook(doc, event, langfuse_entry)
    results.append((event, n, replaced))

with open(hooks_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"  hooks.json written to {hooks_path}")
for event, n, replaced in results:
    status = "updated" if replaced else "added"
    print(f"  {event}: {n} hook(s) ({status} langfuse)")
PYEOF

# ── 9. Verify ────────────────────────────────
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

if [[ -f "$HOOKS_FILE" ]]; then
    info "hooks.json: OK"
else
    warn "hooks.json not written"
fi

# ── Done ─────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Installation complete!                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
info "Codex will send traces to Langfuse on 6 hook events:"
info "  SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop"
echo ""
warn "ONE-TIME TRUST STEP REQUIRED"
echo "  Codex requires explicit trust for non-managed hooks. Run:"
echo "    codex"
echo "  Then in the TUI, type:  /hooks"
echo "  Review the langfuse_hook entries and approve them. This is a one-time per-host action."
echo ""
warn "ChatGPT account model note"
echo "  If you authenticated with a ChatGPT account, the default 'gpt-5-codex' model is rejected."
echo "  Use 'gpt-5.5' or another supported model:"
echo "    codex exec -c model=\"gpt-5.5\" \"…\""
echo "  Or set 'model = \"gpt-5.5\"' in ~/.codex/config.toml."
echo ""
echo "  Dashboard : ${LF_BASE_URL}"
echo "  Logs      : ~/.codex/state/langfuse_hook.log"
echo "  Debug     : CC_LANGFUSE_DEBUG=true codex …"
echo "  Disable   : set TRACE_TO_LANGFUSE=false in ~/.codex/.env"
echo ""
