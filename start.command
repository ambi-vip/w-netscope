#!/bin/bash
# NetScope · 网络示波台 — macOS 双击启动器
cd "$(dirname "$0")" || exit 1

echo "════════════════════════════════════════════"
echo "  NetScope · 网络示波台"
echo "════════════════════════════════════════════"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [!] 未检测到 Node.js"
  echo "      请先安装(任选其一):"
  echo "      1) 官网下载  https://nodejs.org/zh-cn  (LTS 版本)"
  echo "      2) Homebrew  brew install node"
  echo "      安装完成后,再次双击本文件即可。"
  echo ""
  echo "  按任意键退出…"
  read -n 1 -s
  exit 1
fi

echo ""
echo "  Node $(node -v) 已就绪,正在启动服务…"
echo "  启动后会自动打开浏览器;若没有,请手动访问 http://127.0.0.1:8899"
echo "  停止服务:直接关闭本窗口,或按 Ctrl+C;清理全部实例:双击 stop.command"
echo ""
export NETSCOPE_OPEN=1
exec node server.js
