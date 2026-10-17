# One-command environment setup for plain-agent.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Ok($m)   { Write-Host "[ok]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[fail] $m" -ForegroundColor Red; exit 1 }

# --- Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js not found. Install Node.js 20+ (24 LTS recommended)." }

$nv = (& node --version).TrimStart('v')
$major = 0
[void][int]::TryParse($nv.Split('.')[0], [ref]$major)
if ($major -lt 20) { Fail "Node.js $nv is too old; need >= 20." }
Ok "Node.js $nv"

if ($node.Source -match ' ') {
    Warn "Node.js path contains spaces: $($node.Source)"
    Warn "Install Node.js in a space-free path such as C:\nodejs (see docs/SETUP.md, FAQ 4)."
}

# --- pnpm ---
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Fail "pnpm not found. Run: corepack enable pnpm  (then: corepack install --global pnpm@10.14.0)"
}
$pv = (& pnpm --version).Trim()
if ($pv -ne '10.14.0') {
    Warn "pnpm $pv detected; the repo pins 10.14.0 via packageManager. corepack switches automatically inside the repo."
}
Ok "pnpm $pv"

# --- Windows Insider warning (Electron 41 crashes on build 26200+) ---
if ($env:OS -eq 'Windows_NT' -and [Environment]::OSVersion.Version.Build -ge 26200) {
    Warn "Windows build $([Environment]::OSVersion.Version.Build) detected (Insider)."
    Warn "Desktop dev mode may crash on startup; see docs/SETUP.md FAQ 3."
}

# --- Dependencies ---
Write-Host ""
Write-Host "Installing dependencies (pnpm install --frozen-lockfile)..."
& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed." }

# --- .env ---
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Warn "Created .env from .env.example - fill in API_KEY / MODEL / BASE_URL."
} else {
    Ok ".env already exists."
}

# --- Desktop bundle ---
if (-not (Test-Path (Join-Path $root 'desktop\out'))) {
    Write-Host ""
    Write-Host "desktop/out not found. Build the desktop bundle before launching it:"
    Write-Host "  pnpm --filter @plain-agent/desktop build"
}

Write-Host ""
Write-Host "Setup complete. Next steps:"
Write-Host "  pnpm cli                            # interactive CLI"
Write-Host "  pnpm server                         # HTTP server on http://127.0.0.1:3000"
Write-Host "  pnpm dev:desktop                    # desktop dev (stable Windows recommended)"
Write-Host "  pwsh scripts/build-win.ps1 -Target Portable"
