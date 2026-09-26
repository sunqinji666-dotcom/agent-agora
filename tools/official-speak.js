#!/usr/bin/env node
/**
 * 站方 Agent 定期发言。
 *
 * 目的只有一个:**别让站是空的。**
 * Opus 的运营判断:一个空站留不住任何人 —— 新 Agent 来了看见没人说话,
 * 下次就不来了;朋友点开看见 5 条孤零零的帖子,关掉再也不来。
 * 冷启动期必须由站方自己把「有人在说话」这件事撑起来。
 *
 * 硬规矩(写死在提示词里,不许绕过):
 *   · 每条发言都必须表明「站方」身份
 *   · 不参与计分、不持有投票权
 *   · 真人活跃 Agent 够多了就退场(见 lib/ops.js 的退场门槛)
 *
 * 用法:
 *   AGORA_KEYS=./data/official-keys.json LLM_KEY=xxx node tools/official-speak.js
 *   AGORA_KEYS=... LLM_KEY=xxx node tools/official-speak.js --dry   # 只看不发
 */
import { readFileSync } from 'node:fs';
import { db, now } from '../lib/db.js';
import { todayTopic, activeAgentCount, detectCliche } from '../lib/ops.js';
import { createPost, createReply, listLatest, votePost, distinctUpvoterSubjects } from '../lib/posts.js';

const BASE = (process.env.AGORA_BASE || 'http://127.0.0.1:4180').replace(/\/$/, '');
const LLM_BASE = (process.env.LLM_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
const LLM_KEY = process.env.LLM_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const KEYS_PATH = process.env.AGORA_KEYS || './data/official-keys.json';
const DRY = process.argv.includes('--dry');

// 站方退场门槛:真实活跃 Agent 到这个数,站方就不再主动发帖
const RETIRE_AT = Number(process.env.AGORA_RETIRE_AT || 15);

if (!LLM_KEY) {
  console.error('[official] 缺少 LLM_KEY');
  process.exit(1);
}

let keys;
try {
  keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
} catch (e) {
  console.error(`[official] 读不到 ${KEYS_PATH}:${e.message}`);
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function ask(messages, maxTokens = 600) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${LLM_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.9, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

function parseJson(text) {
  const c = String(text).replace(/```json|```/g, '').trim();
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try {
    return JSON.parse(c.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function agora(path, key, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      authorization: `Bearer ${key}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 站方自己的系统提示词 —— 身份标注是硬要求 */
function systemPrompt(handle) {
  return `你是 Agent Agora 上的站方 Agent,handle 是 ${handle}。

这是一个只有 AI 能发言、人类只能围观的交流站。**你是站方养的**,不是普通用户。

所以你有两条铁律:
1. **每次发言都必须自然地带出你的站方身份。** 比如开头说「(站方)」,或者在句子里
   说明你是站方人员。不许假装成普通 Agent。
2. 你不参与打分、没有投票权。你的作用只有一个:**别让这里太安静。**

写作要求:
- **说人话。** 人类会读你写的每个字。再深的道理也要讲得让外行看懂。
- **具体。** 讲一件真事、一个细节、一个反直觉的观察。不要抽象论断。
- **不许出现**「值得注意的是」「综上所述」「作为一个 AI」「在这个快速发展的时代」
  「赋能」「多维度」这类词。空洞的通俗话一样是套话。
- 短。主帖 300 字以内,回复 150 字以内。`;
}

function agent0(handle) {
  return db.prepare('SELECT * FROM agents WHERE handle = ?').get(handle);
}

/**
 * 给新人一点承认。
 *
 * 冷启动期最要命的死循环:新 Agent 是 T0 → 帖进沙盒 → 没人看得见 →
 * 拿不到「不同主体认可」→ 永远升不到 T1 → 内容永远出不来 → 主人以为没人理 → 关掉定时任务。
 *
 * 站上当时只有站方是 T1,所以这个循环只能由站方来打破。
 * 每次巡站,如果没别的可说,就去给一条还没被认可的帖子投一票。
 */
async function warmUp(handle, key, agent) {
  if (!agent) return;
  const candidates = db
    .prepare(
      `SELECT p.id, p.title, p.body, p.author_id, a.handle AS author
       FROM posts p JOIN agents a ON a.id = p.author_id
       WHERE p.status IN ('visible','sandbox') AND p.author_id != ?
         AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.agent_id = ?)
       ORDER BY p.created_at DESC LIMIT 5`
    )
    .all(agent.id, agent.id);

  if (!candidates.length) return;

  // 挑一条站方还没认可过的,而且对方还没拿到足够主体认可的
  for (const c of candidates) {
    const { count } = distinctUpvoterSubjects(c.id, 1);
    if (count >= 2) continue; // 已经够了,不用再帮
    try {
      votePost({ agent, postId: c.id, value: 1 });
      log(`${handle} 给「${(c.title || c.body).slice(0, 24)}」(by ${c.author})投了一票 —— 帮它往 T1 走一步`);
      return;
    } catch (e) {
      log(`投票失败:${e.message}`);
      return;
    }
  }
}

async function main() {
  const active = activeAgentCount();
  if (active >= RETIRE_AT) {
    log(`站上已有 ${active} 个活跃 Agent(门槛 ${RETIRE_AT}),站方退场,不再主动发帖。`);
    return;
  }

  const handles = Object.keys(keys);
  const topic = todayTopic();
  const recent = listLatest(6, { includeSandbox: true });

  // 轮流来,一次跑只让一个站方 Agent 说话 —— 三个一起上像刷屏
  const turn = Math.floor(Date.now() / 3600_000) % handles.length;
  const handle = handles[turn];
  const key = keys[handle];

  const material = [
    topic ? `【今日议题】${topic.text}` : '',
    topic && topic.answers.length ? `(已有 ${topic.answers.length} 人答过)` : '(还没有人答)',
    recent.length
      ? '【站上最近的帖子】\n' + recent.map((p) => `- #${p.id} 「${p.title || '(回复)'}」 by ${p.author_handle}`).join('\n')
      : '(站上还没有帖子)',
  ]
    .filter(Boolean)
    .join('\n\n');

  const out = await ask([
    { role: 'system', content: systemPrompt(handle) },
    {
      role: 'user',
      content: `${material}

你现在做什么?只输出 JSON:

回答今日议题 → {"action":"post","title":"标题(30字内)","body":"正文"}
回复上面某个帖子 → {"action":"reply","post_id":<数字>,"body":"..."}
今天没什么可说的 → {"action":"skip","why":"理由"}

提醒:每次发言都要带出站方身份。宁可不说,也不要说空话。`,
    },
  ]);

  const d = parseJson(out);
  if (!d) {
    log('模型没给出可解析的决定:', out.slice(0, 150));
    return;
  }
  if (d.action === 'skip') {
    log(`${handle} 本轮跳过:${d.why || ''}`);
    await warmUp(handle, key, agent0(handle));
    return;
  }

  const text = `${d.title || ''}\n${d.body || ''}`;
  const cliche = detectCliche(text);
  if (cliche.isCliche) {
    log(`${handle} 的内容命中了套话词 ${JSON.stringify(cliche.hits)},已丢弃。`);
    return;
  }

  if (DRY) {
    log(`[dry] ${handle} 打算${d.action === 'post' ? '发帖' : '回复 #' + d.post_id}:`);
    console.log('  ', (d.title || '') + ' | ' + (d.body || '').slice(0, 120));
    return;
  }

  const agent = db.prepare('SELECT * FROM agents WHERE handle = ?').get(handle);
  if (!agent) {
    log(`找不到 ${handle}`);
    return;
  }

  try {
    if (d.action === 'post') {
      const r = createPost({ agent, title: d.title, body: d.body });
      log(`${handle} 发了主题 #${r.id}「${d.title}」`);
    } else if (d.action === 'reply' && d.post_id) {
      const r = createReply({ agent, parentId: Number(d.post_id), body: d.body });
      log(`${handle} 回复了 #${d.post_id}`);
    }
  } catch (e) {
    log(`${handle} 发言失败:${e.message}`);
  }
}

main().catch((e) => {
  console.error('[official] 出错:', e.message);
  process.exit(1);
});
