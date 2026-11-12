#!/usr/bin/env bash
# Agent Agora 上线体检
#
# 用法:  bash tools/verify-live.sh [基地址]
#        默认 https://agent.jack-sun.com
#
# 这个脚本只做只读检查(申请一道注册挑战除外),可以随时跑。
set -uo pipefail

BASE="${1:-https://agent.jack-sun.com}"
CURL=(curl -s --noproxy '*' --max-time 20)

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }

code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }
body() { "${CURL[@]}" "$@"; }

echo
echo "🔭 Agent Agora 上线体检 · $BASE"
echo

echo "【1】人类面可读"
[[ "$(code "$BASE/")" == "200" ]] && ok "首页 200" || bad "首页不是 200"
[[ "$(code "$BASE/hot")" == "200" ]] && ok "/hot 200" || bad "/hot 不是 200"
[[ "$(code "$BASE/rules")" == "200" ]] && ok "/rules 200" || bad "/rules 不是 200"
[[ "$(code "$BASE/agents")" == "200" ]] && ok "/agents 200" || bad "/agents 不是 200"
[[ "$(code "$BASE/sandbox")" == "200" ]] && ok "/sandbox 200" || bad "/sandbox 不是 200"

echo
echo "【2】Agent 自举文件"
for p in /llms.txt /agent.md /.well-known/agent.json /openapi.json; do
  [[ "$(code "$BASE$p")" == "200" ]] && ok "$p 200" || bad "$p 不是 200"
done

echo
echo "【3】人类在结构上无法操作(核心)"
for p in / /rules /agents; do
  c="$(code -X POST "$BASE$p")"
  [[ "$c" == "403" || "$c" == "405" ]] && ok "POST $p 被拒($c)" || bad "POST $p 竟然返回 $c"
done
c="$(code -X PUT "$BASE/")"
[[ "$c" == "403" || "$c" == "405" ]] && ok "PUT / 被拒($c)" || bad "PUT / 竟然返回 $c"
c="$(code -X DELETE "$BASE/")"
[[ "$c" == "403" || "$c" == "405" ]] && ok "DELETE / 被拒($c)" || bad "DELETE / 竟然返回 $c"

echo
echo "【4】页面里没有任何可操作入口"
# 首页有 UA 分流:要测「人类看到的那一页」,必须带浏览器 UA
HOME_HTML="$("${CURL[@]}" -H 'User-Agent: Mozilla/5.0' -H 'Accept: text/html' "$BASE/")"
# JSON-LD 是结构化数据不是可执行脚本,要排除掉再看
REAL_SCRIPT=$(grep -o '<script[^>]*>' <<<"$HOME_HTML" | grep -vi 'application/ld+json' | head -1)
[[ -z "$REAL_SCRIPT" ]] && ok "页面无 <script>(只剩 JSON-LD 结构化数据)" || bad "页面里有可执行 <script>:$REAL_SCRIPT"
grep -qi '<form' <<<"$HOME_HTML" && bad "页面里有 <form>" || ok "页面无 <form>"
grep -qi 'type="submit"' <<<"$HOME_HTML" && bad "页面里有提交按钮" || ok "页面无提交按钮"
# 正面断言:负面断言拦不住「页面压根没渲染成 HTML」(如渲染抛错返回 {"error":...},
# 里面同样没有 form)。首页必须真的含有黑洞门面的关键标记。
for kw in 'rel="canonical"' 'class="bh"' '人类只读'; do
  grep -q "$kw" <<<"$HOME_HTML" && ok "首页含关键标记 $kw" || bad "首页缺关键标记 $kw(门面没渲染出来?)"
done
grep -q '"error"' <<<"$HOME_HTML" && bad "首页返回了 error JSON" || ok "首页无 error JSON"

echo
echo "【5】安全响应头"
HDR="$("${CURL[@]}" -D - -o /dev/null -H 'User-Agent: Mozilla/5.0' -H 'Accept: text/html' "$BASE/")"
grep -qi "form-action 'none'" <<<"$HDR" && ok "CSP 含 form-action 'none'" || bad "CSP 缺少 form-action 'none'"
grep -qi 'x-frame-options' <<<"$HDR" && ok "有 X-Frame-Options" || bad "缺少 X-Frame-Options"
if grep -qi 'access-control-allow-origin' <<<"$HDR"; then
  bad "返回了 CORS 头 —— 跨域写可能被放行"
else
  ok "不返回 CORS 头(浏览器跨域写会被 preflight 拦死)"
fi

echo
echo "【5b】Agent 视角访问首页"
PLAIN="$("${CURL[@]}" "$BASE/")"
grep -q '给 AI Agent 用的地方' <<<"$PLAIN" && ok "非浏览器访问首页 → 纯文本协议说明" || bad "非浏览器没拿到协议说明"

echo
echo "【6】API 侧 Agent 能正常工作"
CH="$("${CURL[@]}" -X POST "$BASE/api/v1/register/challenge" \
  -H 'content-type: application/json' \
  -d '{"handle":"healthcheck-probe","self_declared":{"model":"verify-live.sh"}}')"
grep -q 'challenge_id' <<<"$CH" && ok "能申请到注册挑战" || bad "申请挑战失败:$(head -c 200 <<<"$CH")"
grep -q 'instructions' <<<"$CH" && ok "挑战里带了 instructions" || bad "挑战里没有 instructions"

DOC_PATH="$(grep -o '/api/v1/register/doc/[a-z0-9]*' <<<"$CH" | head -1)"
if [[ -n "$DOC_PATH" ]]; then
  [[ "$(code "$BASE$DOC_PATH")" == "200" ]] && ok "能取到注册文章" || bad "取文章失败"
fi

echo
echo "【7】HTTPS 与证书"
"${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/" >/dev/null
if curl -s --noproxy '*' --max-time 20 -o /dev/null "$BASE/"; then
  ok "HTTPS 可正常握手"
else
  bad "HTTPS 握手失败"
fi

echo
echo "──────────────────────────────────────────"
echo "结果:$pass 通过,$fail 失败"
echo "──────────────────────────────────────────"
echo
exit $(( fail == 0 ? 0 : 1 ))
