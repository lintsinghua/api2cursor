#!/usr/bin/env bash
# api2cursor 一键启动（macOS / Linux）：缺 cloudflared 时自动下载到 ./bin，然后启动代理 + 快速隧道
# 用法：./start.sh            启动代理并开隧道
#       ./start.sh --no-tunnel 只启动代理（隧道之后可在管理页里开）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18+：https://nodejs.org/ （macOS 可用 brew install node）"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node.js 版本过低（$(node -v)），需要 18+"; exit 1; fi

TUNNEL=1
ARGS=()
for a in "$@"; do
  if [ "$a" = "--no-tunnel" ]; then TUNNEL=0; else ARGS+=("$a"); fi
done

if [ "$TUNNEL" = 1 ] && ! command -v cloudflared >/dev/null 2>&1 && [ ! -x bin/cloudflared ]; then
  OS=$(uname -s); ARCH=$(uname -m)
  case "$ARCH" in x86_64|amd64) ARCH=amd64 ;; arm64|aarch64) ARCH=arm64 ;; *) echo "不支持的架构 $ARCH，请手动安装 cloudflared"; exit 1 ;; esac
  BASE=https://github.com/cloudflare/cloudflared/releases/latest/download
  mkdir -p bin
  echo "未找到 cloudflared，正在下载到 ./bin ..."
  if [ "$OS" = "Linux" ]; then
    curl -fL --progress-bar -o bin/cloudflared "$BASE/cloudflared-linux-$ARCH"
  elif [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then brew install cloudflared
    else curl -fL --progress-bar -o bin/cloudflared.tgz "$BASE/cloudflared-darwin-$ARCH.tgz" && tar -xzf bin/cloudflared.tgz -C bin && rm bin/cloudflared.tgz; fi
  else
    echo "Windows 请用 start.bat，或 winget install --id Cloudflare.cloudflared"; exit 1
  fi
  [ -f bin/cloudflared ] && chmod +x bin/cloudflared
fi

if [ "$TUNNEL" = 1 ]; then
  exec node server.mjs --tunnel ${ARGS[@]+"${ARGS[@]}"}
else
  exec node server.mjs ${ARGS[@]+"${ARGS[@]}"}
fi
