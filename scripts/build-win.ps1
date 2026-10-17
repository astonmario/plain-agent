# Package the Electron desktop app on Windows.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
    [ValidateSet('Dir', 'Portable', 'Installer')]
    [string]$Target = 'Portable',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Mirrors: the repo .npmrc covers "pnpm run" scripts; these cover direct calls too.
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) { $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/' }
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

$osBuild = [Environment]::OSVersion.Version.Build
if ($Target -eq 'Installer' -and $env:OS -eq 'Windows_NT' -and $osBuild -ge 26200) {
    Write-Warning "Windows Insider build $osBuild detected: NSIS installer generation is known to fail (exit 2) on builds 26200+."
    Write-Warning "Use -Target Portable, or build the installer on a stable Windows / CI machine."
}

if (-not $SkipBuild) {
    Write-Host "Building main/preload/renderer..."
    & pnpm --filter @plain-agent/desktop build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Packaging target: $Target"
switch ($Target) {
    'Dir'       { & pnpm --filter @plain-agent/desktop exec electron-builder --dir }
    'Portable'  { & pnpm --filter @plain-agent/desktop exec electron-builder --win portable --x64 }
    'Installer' { & pnpm --filter @plain-agent/desktop exec electron-builder --win nsis --x64 }
}
$code = $LASTEXITCODE

if ($code -eq 0) {
    Write-Host ""
    Write-Host "Artifacts in desktop\dist:"
    Get-ChildItem (Join-Path $root 'desktop\dist') -File -ErrorAction SilentlyContinue |
        Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
        Format-Table -AutoSize
}

exit $code
