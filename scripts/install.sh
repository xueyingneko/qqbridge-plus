#!/usr/bin/env bash
# dsh-plugin-qqbridge-plus 一键安装（Linux / macOS / Git Bash）
#
# 适合"还没有这个仓库"的场景：它把仓库克隆到 ~/dsh-plugins/，然后交给 install.mjs 做真实安装。
# 真正的安装逻辑只有一处（scripts/install.mjs），这里只是取代码的壳，避免逻辑分叉。
#
# 用法：
#   bash scripts/install.sh [--repo <git url>] [--profile desktop|web] [--bridge-dir <path>] [--dry-run]
# 或直接：
#   curl -fsSL https://raw.githubusercontent.com/xueyingneko/qqbridge-plus/main/scripts/install.sh | bash
set -euo pipefail

REPO=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

# 默认仓库地址
REPO="${REPO:-https://github.com/xueyingneko/qqbridge-plus.git}"

command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node 18+，未找到 node" >&2; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "✗ 需要 git，未找到" >&2; exit 1; }

TARGET="$HOME/dsh-plugins/qqbridge-plus"

if [ -f "$TARGET/lib/index.js" ]; then
  echo "✓ 已存在 $TARGET，交给安装器更新"
elif [ -f "./lib/index.js" ] && [ -f "./scripts/install.mjs" ]; then
  # 已经在仓库里跑这个脚本
  TARGET="$(pwd)"
  echo "✓ 检测到当前目录就是仓库：$TARGET"
else
  echo "→ 克隆 $REPO 到 $TARGET"
  mkdir -p "$(dirname "$TARGET")"
  git clone --depth 1 "$REPO" "$TARGET"
fi

exec node "$TARGET/scripts/install.mjs" --dir "$TARGET" "${ARGS[@]}"
