#!/bin/bash
# NetScope · 网络示波台 — 一键停止所有实例并释放端口
cd "$(dirname "$0")" || exit 1

echo "════════════════════════════════════════════"
echo "  NetScope · 停止服务并释放端口"
echo "════════════════════════════════════════════"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] 未检测到 Node.js,改用手动方式:"
  echo "      lsof -ti :8899-8918 | xargs kill"
  echo ""
  echo "  按任意键退出…"
  read -n 1 -s
  exit 1
fi

node server.js stop
echo ""
echo "  按任意键关闭…"
read -n 1 -s
