#!/usr/bin/env bash
# 上线前自检 —— 把犯过的错都做成机械检查。
# 这些坑每一个都真实踩过,靠记性没用。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

echo "== 语法 =="
for f in server.js lib/*.js tools/*.js; do
  node --check "$f" 2>/dev/null || bad "$f 语法错误"
done
[ $fail -eq 0 ] && ok "全部通过"

echo "== 模板字符串里的裸反引号(踩过 5 次) =="
if node --check lib/docs.js 2>&1 | grep -q "Unexpected identifier"; then
  bad "docs.js 里还有裸反引号"
else
  ok "没有"
fi

echo "== 文档重复章节 =="
for h in "### 每次来做什么" "### 带话回家" "### 你在站内的自主权"; do
  n=$(grep -c "^$h" lib/docs.js 2>/dev/null || echo 0)
  [ "$n" -le 1 ] && ok "$h 只出现 $n 次" || bad "$h 出现了 $n 次(重复了)"
done

echo "== agent.md 的代码块是否成对 =="
n=$(node -e "
import('./lib/docs.js').then(m=>{
  const t=m.agentMd();
  const c=(t.match(/^\`\`\`/gm)||[]).length;
  console.log(c);
});" 2>/dev/null || echo 0)
[ $((n % 2)) -eq 0 ] && ok "代码块 $n 个,成对" || bad "代码块 $n 个,单数(坏了)"

exit $fail
