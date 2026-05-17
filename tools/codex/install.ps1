# ─────────────────────────────────────────────
# langfuse-codex installer (Windows)
# Native Langfuse tracing for Codex CLI 0.128+
# ─────────────────────────────────────────────
#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$HookName  = "langfuse_hook.py"
$CodexDir  = Join-Path $env:USERPROFILE ".codex"
$HooksDir  = Join-Path $CodexDir "hooks"
$StateDir  = Join-Path $CodexDir "state"
$HooksFile = Join-Path $CodexDir "hooks.json"
$EnvFile   = Join-Path $CodexDir ".env"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step  ($msg) { Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function Write-Info  ($msg) { Write-Host "[INFO] $msg" -ForegroundColor Green }
function Write-Warn  ($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "============================================"
Write-Host "   langfuse-codex installer"
Write-Host "============================================"
Write-Host ""

# ── 1. Check Codex CLI ───────────────────────
Write-Step "Checking Codex CLI installation..."
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Err "Codex CLI not found in PATH. Install from https://github.com/openai/codex first."
    exit 1
}
$CodexVerLine = & codex --version 2>$null
if ($CodexVerLine -match '(\d+\.\d+\.\d+)') {
    $CodexVer = $Matches[1]
    Write-Info "Codex CLI version: $CodexVer"
    $parts = $CodexVer.Split('.')
    $major = [int]$parts[0]; $minor = [int]$parts[1]
    if ($major -eq 0 -and $minor -lt 128) {
        Write-Warn "Codex $CodexVer may lack native hooks (require 0.128+). Continuing anyway."
    }
} else {
    Write-Warn "Could not parse Codex version. Continuing."
}

# ── 2. Check Python ──────────────────────────
Write-Step "Checking Python installation..."
$Python = $null
if (Get-Command python -ErrorAction SilentlyContinue) {
    try { & python --version 2>$null | Out-Null; $Python = "python" } catch {}
}
if (-not $Python -and (Get-Command python3 -ErrorAction SilentlyContinue)) {
    try { & python3 --version 2>$null | Out-Null; $Python = "python3" } catch {}
}
if (-not $Python) {
    Write-Err "Python not found. Please install Python 3.8+ first."
    exit 1
}

$PyVersion = & $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$PyMajor   = & $Python -c "import sys; print(sys.version_info.major)"
$PyMinor   = & $Python -c "import sys; print(sys.version_info.minor)"

if ([int]$PyMajor -lt 3 -or ([int]$PyMajor -eq 3 -and [int]$PyMinor -lt 8)) {
    Write-Err "Python 3.8+ required, found $PyVersion"
    exit 1
}

Write-Info "Found $Python ($PyVersion)"

# ── 3. Install langfuse SDK ──────────────────
Write-Step "Installing langfuse Python SDK..."
& $Python -m pip install --quiet --upgrade langfuse
Write-Info "langfuse SDK installed."

# ── 4. Copy hook script ─────────────────────
Write-Step "Copying hook script..."
New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
Copy-Item -Force (Join-Path $ScriptDir $HookName) (Join-Path $HooksDir $HookName)
Write-Info "Hook script installed: $(Join-Path $HooksDir $HookName)"

# ── 5. Clean previous state (optional) ──────
$StateFile = Join-Path $StateDir "langfuse_state.json"
if (Test-Path $StateFile) {
    Write-Host ""
    $resetState = Read-Host "  Previous state file found. Reset trace offsets? [y/N]"
    if ($resetState -match "^[Yy]$") {
        Remove-Item -Force $StateFile
        Write-Info "State file reset."
    }
}

# ── 6. Collect Langfuse credentials ─────────
Write-Host ""
Write-Step "Configuring Langfuse credentials..."
Write-Host "  Get your keys from https://cloud.langfuse.com (or your self-hosted instance)."
Write-Host ""

$LfPublicKey = Read-Host "  Langfuse Public Key"
$secureSecret = Read-Host "  Langfuse Secret Key" -AsSecureString
$LfSecretKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
)
$LfBaseUrl = Read-Host "  Langfuse Base URL [https://cloud.langfuse.com]"
if (-not $LfBaseUrl) { $LfBaseUrl = "https://cloud.langfuse.com" }

$LfUserId = Read-Host "  User ID (trace attribution) [codex-user]"
if (-not $LfUserId) { $LfUserId = "codex-user" }

if (-not $LfPublicKey -or -not $LfSecretKey) {
    Write-Err "Public Key and Secret Key are required."
    exit 1
}

# ── 7. Write credentials to .env ──────────────
Write-Step "Writing credentials to $EnvFile..."
$envContent = @"
# Langfuse credentials for langfuse-codex
# Environment variables take priority over .env values.

TRACE_TO_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=$LfPublicKey
LANGFUSE_SECRET_KEY=$LfSecretKey
LANGFUSE_BASE_URL=$LfBaseUrl
LANGFUSE_USER_ID=$LfUserId
"@
Set-Content -Path $EnvFile -Value $envContent -Encoding UTF8
Write-Info "Credentials written to $EnvFile"

# ── 8. Write hooks.json (6 events) ────────────
Write-Step "Writing $HooksFile..."

$HookCmd = "$Python `"$(Join-Path $HooksDir $HookName)`""

$pyMerge = @'
import json, sys, os
hooks_path = sys.argv[1]
hook_command = sys.argv[2]
if os.path.exists(hooks_path):
    try:
        with open(hooks_path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception:
        doc = {}
else:
    doc = {}
if "hooks" not in doc or not isinstance(doc["hooks"], dict):
    doc["hooks"] = {}
langfuse_entry = {"hooks": [{"type": "command", "command": hook_command}]}
def upsert(doc, event_name):
    lst = doc["hooks"].get(event_name, [])
    if not isinstance(lst, list):
        lst = []
    replaced = False
    for i, entry in enumerate(lst):
        if not isinstance(entry, dict):
            continue
        for h in entry.get("hooks", []):
            if isinstance(h, dict) and "langfuse_hook" in h.get("command", ""):
                lst[i] = langfuse_entry
                replaced = True
                break
        if replaced:
            break
    if not replaced:
        lst.append(langfuse_entry)
    doc["hooks"][event_name] = lst
    return len(lst), replaced
events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"]
results = []
for e in events:
    n, r = upsert(doc, e)
    results.append((e, n, r))
with open(hooks_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"  hooks.json written to {hooks_path}")
for e, n, r in results:
    print(f"  {e}: {n} hook(s) ({'updated' if r else 'added'} langfuse)")
'@

& $Python -c $pyMerge $HooksFile $HookCmd

# ── 9. Verify ────────────────────────────────
Write-Step "Verifying installation..."
$importOk = $false
try { & $Python -c "import langfuse" 2>$null; $importOk = ($LASTEXITCODE -eq 0) } catch {}
if ($importOk) { Write-Info "langfuse SDK: OK" } else { Write-Warn "langfuse SDK import failed." }

if (Test-Path (Join-Path $HooksDir $HookName)) { Write-Info "Hook script: OK" } else { Write-Warn "Hook script not found." }
if (Test-Path $HooksFile) { Write-Info "hooks.json: OK" } else { Write-Warn "hooks.json not written." }

# ── Done ─────────────────────────────────────
Write-Host ""
Write-Host "============================================"
Write-Host "   Installation complete!"
Write-Host "============================================"
Write-Host ""
Write-Info "Codex will send traces to Langfuse on 6 hook events:"
Write-Info "  SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop"
Write-Host ""
Write-Warn "ONE-TIME TRUST STEP REQUIRED"
Write-Host "  Codex requires explicit trust for non-managed hooks. Run:"
Write-Host "    codex"
Write-Host "  Then in the TUI, type:  /hooks"
Write-Host "  Review the langfuse_hook entries and approve them."
Write-Host ""
Write-Warn "ChatGPT account model note"
Write-Host "  If you authenticated with a ChatGPT account, the default 'gpt-5-codex' model is rejected."
Write-Host "  Use 'gpt-5.5' or another supported model in your config.toml or per-invocation."
Write-Host ""
Write-Host "  Dashboard : $LfBaseUrl"
Write-Host "  Logs      : ~/.codex/state/langfuse_hook.log"
Write-Host "  Debug     : `$env:CC_LANGFUSE_DEBUG = 'true'; codex"
Write-Host "  Disable   : set TRACE_TO_LANGFUSE=false in ~/.codex/.env"
Write-Host ""
