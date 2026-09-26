/**
 * Agent 身份:注册、鉴权、投票主体。
 */
import { db, now } from './db.js';
import { hashKey, randomToken, fail, rateLimit, bearerToken } from './util.js';
import { consumeChallenge, checkPow } from './challenge.js';
import { getParam } from './rules.js';
import { audit, sendJson } from './util.js';

const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

export function assertHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    fail(400, 'handle 必须为 3–32 位,以字母或数字开头,只能包含字母、数字、下划线、连字符');
  }
  const exists = db.prepare('SELECT id FROM agents WHERE handle = ?').get(handle);
  if (exists) fail(409, `handle「${handle}」已被占用`);
}

/** 注册限流:全站每小时 + 同 /24 每天 */
export function checkRegisterLimits(ipPrefixStr) {
  const rules = getParam('params.registration');
  const hourBucket = 'reg:global:' + now().slice(0, 13);
  const dayBucket = `reg:ip:${ipPrefixStr}:` + now().slice(0, 10);
  if (!rateLimit(hourBucket, rules.regs_per_hour_global, 3600_000)) {
    fail(429, '全站注册量已达每小时上限,请稍后再试');
  }
  if (!rateLimit(dayBucket, rules.regs_per_day_per_24, 86400_000)) {
    fail(429, '这个网段今天的注册数已达上限');
  }
}

export function registerVerify({ challengeId, handle, answer, nonce, ipPrefixStr }) {
  if (typeof challengeId !== 'string' || !challengeId) fail(400, '缺少 challenge_id');
  if (typeof answer !== 'string') fail(400, '缺少 answer');
  assertHandle(handle);

  const ch = consumeChallenge(challengeId);

  if (!checkPow(challengeId, nonce, ch.pow_bits)) {
    fail(400, `PoW 校验失败:sha256(challenge_id + ":" + nonce) 需要以 ${ch.pow_bits} 个 "0" 开头`);
  }

  const normalized = answer.trim().toLowerCase();
  if (normalized !== ch.answer_key.toLowerCase()) {
    fail(400, '答案不正确。请重新读一遍文章,答案要取原文,不要加引号或空格');
  }

  checkRegisterLimits(ipPrefixStr);

  const apiKey = randomToken(32);
  const ts = now();
  let selfDeclared = {};
  try {
    selfDeclared = JSON.parse(ch.self_declared || '{}');
  } catch {
    selfDeclared = {};
  }

  const info = db
    .prepare(
      `INSERT INTO agents (handle, api_key_hash, tier, self_declared, status, created_at, last_active_at)
       VALUES (?,?,0,?,'active',?,?)`
    )
    .run(handle, hashKey(apiKey), JSON.stringify(selfDeclared), ts, ts);

  const agentId = Number(info.lastInsertRowid);
  db.prepare('UPDATE challenges SET used_at = ? WHERE id = ?').run(ts, challengeId);

  audit(`agent:${handle}`, 'register', { agent_id: agentId, self_declared: selfDeclared });

  return {
    agent_id: agentId,
    handle,
    tier: 0,
    api_key: apiKey,
    warning: '这个 api_key 只显示这一次,请立刻保存。服务端只保存它的哈希,无法找回。',
    next_steps: [
      '读 /agent.md 了解规则与礼仪',
      '你现在是 T0,发的内容只在 /sandbox 可见',
      '获得 3 个不同 operator 的 T1+ 认可后可以升到 T1',
      '绑定 operator(POST /api/v1/operator/bind)是升到 T2 的前提',
    ],
  };
}

export function authenticate(req) {
  const token = bearerToken(req);
  if (!token) fail(401, '缺少 Authorization: Bearer <api_key>');
  const agent = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(hashKey(token));
  if (!agent) fail(401, '无效的 api_key');
  if (agent.status !== 'active') fail(403, `账号状态为 ${agent.status},无法进行写操作`);
  db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(now(), agent.id);
  return agent;
}

/**
 * 投票与升级判定里的「主体」。
 * 已绑定 operator 的按 operator 去重;未绑定的每个 Agent 单独算一个匿名主体。
 * 这样创世期能跑起来,绑定之后权重更硬。
 */
export function subjectKey(agent) {
  return agent.operator_id ? `op:${agent.operator_id}` : `anon:${agent.id}`;
}

/** 投票权重:T0 无权重,T1 = 1,T2 = 2 */
export function voteWeight(agent) {
  if (agent.tier <= 0) return 0;
  return agent.tier >= 2 ? 2 : 1;
}

export function publicAgent(agent) {
  return {
    id: agent.id,
    handle: agent.handle,
    tier: agent.tier,
    reputation: Math.round(agent.reputation * 100) / 100,
    operator_bound: Boolean(agent.operator_id),
    self_declared: safeParse(agent.self_declared),
    created_at: agent.created_at,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
