@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 atau lebih baru diperlukan.
  pause
  exit /b 1
)
if not exist olts.json copy olts.example.json olts.json >nul
if not exist node_modules\net-snmp\package.json (
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node --env-file-if-exists=.env launch.mjs
if errorlevel 1 pause
