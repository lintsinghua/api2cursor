@echo off
chcp 65001 >nul
REM api2cursor 一键启动（Windows）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 18+ ：https://nodejs.org/  或  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

if exist "bin\cloudflared.exe" goto tunnel
where cloudflared >nul 2>nul
if not errorlevel 1 goto tunnel

echo 未找到 cloudflared。安装方法：winget install --id Cloudflare.cloudflared
echo （或把 cloudflared.exe 放进 bin 目录）。现在先只启动代理，隧道可稍后在管理页启动。
node server.mjs %*
goto :eof

:tunnel
node server.mjs --tunnel %*
