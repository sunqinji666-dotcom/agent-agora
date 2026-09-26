#!/usr/bin/env bash
# 把 Agent Agora 部署到腾讯云。
#
# 用法:  bash tools/deploy.sh            # 同步 + 重启
#        bash tools/deploy.sh --dry-run  # 只看会改哪些文件
#
# 服务器侧的前提(只需做一次,见 docs/DEPLOY.md):
#   /etc/systemd/system/agent-agora.service
#   /www/server/panel/vhost/nginx/agent.jack-sun.com.conf
set -euo pipefail

HOST="${AGORA_HOST:-jacksun-tencent}"
DEST="${AGORA_DEST:-/www/wwwroot/agent-agora-source}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/"

RSYNC_OPTS=(
  -az
  --rsync-path='sudo rsync'
  --exclude 'data'
  --exclude '.git'
  --exclude 'node_modules'
  --exclude '*.db'
  --exclude '*.db-wal'
  --exclude '*.db-shm'
  --exclude '.DS_Store'
)

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "→ 预演(不会改动服务器)"
  rsync "${RSYNC_OPTS[@]}" --dry-run --itemize-changes "$SRC" "$HOST:$DEST/"
  exit 0
fi

# 闸门:语法不过就别上传。运行时的错传上去会让线上服务崩在启动阶段,
# systemd 会一直重启,而重启日志里翻错误很费劲。
echo "→ 语法检查"
for f in "$SRC"server.js "$SRC"lib/*.js "$SRC"tools/*.js; do
  node --check "$f" || {
    echo "✗ 语法错误:$f —— 已中止部署"
    exit 1
  }
done

echo "→ 同步代码到 $HOST:$DEST"
rsync "${RSYNC_OPTS[@]}" "$SRC" "$HOST:$DEST/"

echo "→ 修正属主并重启服务"
ssh "$HOST" "sudo chown -R www:www $DEST && sudo systemctl restart agent-agora"

sleep 2
STATUS="$(ssh "$HOST" 'systemctl is-active agent-agora || true')"
echo "→ 服务状态:$STATUS"

if [[ "$STATUS" != "active" ]]; then
  echo "✗ 没起来,看日志:"
  ssh "$HOST" 'sudo journalctl -u agent-agora -n 40 --no-pager'
  exit 1
fi

echo "→ 冒烟测试"
CODE="$(ssh "$HOST" "curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:4180/ || true")"
echo "   本机首页 HTTP $CODE"
CODE2="$(ssh "$HOST" "curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:4180/agent.md || true")"
echo "   agent.md HTTP $CODE2"

echo "✓ 部署完成"
