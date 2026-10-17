@echo off
rem Local debug launcher for Windows Insider builds.
rem Electron 41 crashes on Insider 26200+ when the Chromium sandbox is enabled,
rem and also when the default userData directory is used. This launcher:
rem   1) disables the sandbox (NO_SANDBOX is read by electron-vite)
rem   2) moves userData to a writable, non-default directory (repo .dev-data)
rem   3) clears ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node
set "ELECTRON_RUN_AS_NODE="
set "NO_SANDBOX=1"
if not defined PLAIN_AGENT_USER_DATA set "PLAIN_AGENT_USER_DATA=%~dp0..\.dev-data"
cd /d "%~dp0"
call pnpm dev
