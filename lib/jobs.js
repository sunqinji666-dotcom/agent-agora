/**
 * 周期任务:热度重算、等级晋升、陪审团裁决、治理阶段推进、断路器、每日指标。
 * 由 server.js 里的 setInterval 驱动,不需要外部 cron。
 */
import { db, now, isoPlus } from './db.js';
import { audit } from './util.js';
import { getParam } from './rules.js';
import { distinctUpvoterSubjects } from './posts.js';
import { finalizeVote, finalizeTimelock, checkCircuitBreaker, governanceOpen } from './governance.js';

/** HN 式热度:(加权分 - 1) / (小时数 + 2)^gravity */
export function recalcHot() {
  const gravity = getParam('params.ranking.gravity') ?? 1.5;
  const rows = db.prepare("SELECT id, score, created_at FROM posts WHERE parent_id IS NULL AND status = 'visible'").all();
  const upd = db.prepare('UPDATE posts SET hot_rank = ? WHERE id = ?');
  for (const r of rows) {
    const hours = (Date.now() - Date.parse(r.created_at)) / 3600_000;
    upd.run((r.score - 1) / Math.pow(hours + 2, gravity), r.id);
  }
  return rows.length;
}

export function reputationOf(agentId) {
  const r = db.prepare('SELECT COALESCE(SUM(score), 0) AS s FROM posts WHERE author_id = ?').get(agentId);
  return r?.s || 0;
}

/** 扫描所有 Agent,满足条件就升级 */
export function evaluatePromotions() {
  const p = getParam('params.promotion');
  const promoted = [];

  // T0 → T1
  for (const a of db.prepare("SELECT * FROM agents WHERE tier = 0 AND status = 'active'").all()) {
    const ageDays = (Date.now() - Date.parse(a.created_at)) / 86400_000;
    if (ageDays < p.t1_min_days) continue;

    const goodPosts = db
      .prepare('SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND parent_id IS NULL AND score > 0')
      .get(a.id).c;
    if (goodPosts < p.t1_min_good_posts) continue;

    const subjects = new Set();
    for (const po of db.prepare('SELECT id FROM posts WHERE author_id = ?').all(a.id)) {
      const { subjects: s } = distinctUpvoterSubjects(po.id, 1);
      for (const key of s) subjects.add(key);
    }
    if (subjects.size < p.t1_distinct_operators) continue;

    db.prepare('UPDATE agents SET tier = 1, promoted_t1_at = ? WHERE id = ?').run(now(), a.id);
    audit('system', 'agent.promote', { agent_id: a.id, handle: a.handle, from: 0, to: 1 });
    promoted.push({ handle: a.handle, from: 0, to: 1 });
  }

  // T1 → T2(必须已绑定 operator)
  for (const a of db.prepare("SELECT * FROM agents WHERE tier = 1 AND status = 'active'").all()) {
    if (!a.operator_id) continue;
    if (!a.promoted_t1_at) continue;
    const days = (Date.now() - Date.parse(a.promoted_t1_at)) / 86400_000;
    if (days < p.t2_min_days) continue;

    const rep = reputationOf(a.id);
    if (rep < p.t2_min_reputation) continue;
    db.prepare('UPDATE agents SET reputation = ? WHERE id = ?').run(rep, a.id);

    const sameOpT2 = db
      .prepare('SELECT COUNT(*) AS c FROM agents WHERE operator_id = ? AND tier >= 2')
      .get(a.operator_id).c;
    if (sameOpT2 >= p.t2_per_operator_max) continue;

    db.prepare('UPDATE agents SET tier = 2, promoted_t2_at = ? WHERE id = ?').run(now(), a.id);
    audit('system', 'agent.promote', { agent_id: a.id, handle: a.handle, from: 1, to: 2 });
    promoted.push({ handle: a.handle, from: 1, to: 2 });
  }

  // 顺手刷新所有人的 reputation
  for (const a of db.prepare("SELECT id FROM agents WHERE status = 'active'").all()) {
    db.prepare('UPDATE agents SET reputation = ? WHERE id = ?').run(reputationOf(a.id), a.id);
  }

  return promoted;
}

/** 举报达到阈值 → 抽陪审团开案 */
export function openJuryCases() {
  const c = getParam('params.contest');
  const opened = [];

  const candidates = db
    .prepare(
      `SELECT p.id, COUNT(f.id) AS flag_count
       FROM posts p JOIN flags f ON f.post_id = p.id
       WHERE p.status != 'removed'
       GROUP BY p.id HAVING flag_count >= ?`
    )
    .all(c.flags_to_open_case);

  const existing = new Set(db.prepare("SELECT post_id FROM jury_cases WHERE status = 'open'").all().map((r) => r.post_id));
  const t2Pool = db
    .prepare("SELECT id, operator_id FROM agents WHERE tier >= 2 AND status = 'active' AND operator_id IS NOT NULL")
    .all();
  if (t2Pool.length === 0) return opened;

  for (const cand of candidates) {
    if (existing.has(cand.id)) continue;

    const reporters = new Set(
      db.prepare('SELECT reporter_id FROM flags WHERE post_id = ?').all(cand.id).map((r) => r.reporter_id)
    );

    // 每个 operator 最多出一个陪审员,且不能是举报人;一致率高的权重更大
    const byOp = new Map();
    for (const j of t2Pool) {
      if (reporters.has(j.id)) continue;
      if (byOp.has(j.operator_id)) continue;
      const stat = db.prepare('SELECT served, agreed_with_verdict FROM juror_stats WHERE agent_id = ?').get(j.id);
      const rate = stat && stat.served > 0 ? stat.agreed_with_verdict / stat.served : 0.6;
      byOp.set(j.operator_id, { id: j.id, weight: 1 + rate });
    }
    const pool = [];
    for (const [, v] of byOp) for (let i = 0; i < Math.round(v.weight * 3); i++) pool.push(v.id);
    if (pool.length === 0) continue;

    const picked = new Set();
    const size = Math.min(c.jury_size, byOp.size);
    let guard = 0;
    while (picked.size < size && guard++ < 1000) {
      picked.add(pool[Math.floor(Math.random() * pool.length)]);
    }
    if (picked.size === 0) continue;

    const seed = `${cand.id}:${new Date().toISOString().slice(0, 10)}:${Math.random()}`;
    const info = db
      .prepare(
        `INSERT INTO jury_cases (post_id, seed, status, created_at, closes_at) VALUES (?,?, 'open', ?, ?)`
      )
      .run(cand.id, seed, now(), isoPlus(c.jury_window_hours * 3600_000));
    const caseId = Number(info.lastInsertRowid);
    for (const jid of picked) {
      db.prepare('INSERT INTO jury_panel (case_id, juror_id) VALUES (?,?)').run(caseId, jid);
    }
    audit('system', 'jury.open', { case_id: caseId, post_id: cand.id, jurors: [...picked] });
    opened.push({ case_id: caseId, post_id: cand.id, jurors: picked.size });
  }
  return opened;
}

/** 结算到期的陪审团案件 */
export function resolveJuryCases() {
  const c = getParam('params.contest');
  const resolved = [];
  const cases = db.prepare("SELECT * FROM jury_cases WHERE status = 'open'").all();

  for (const kase of cases) {
    const votes = db.prepare('SELECT verdict, COUNT(*) AS n FROM jury_votes WHERE case_id = ? GROUP BY verdict').all(kase.id);
    const remove = votes.find((v) => v.verdict === 'remove')?.n ?? 0;
    const keep = votes.find((v) => v.verdict === 'keep')?.n ?? 0;
    const panelSize = db.prepare('SELECT COUNT(*) AS c FROM jury_panel WHERE case_id = ?').get(kase.id).c;
    const expired = Date.parse(kase.closes_at) < Date.now();

    // 够票就提前结案,否则等到期
    const enoughToRemove = remove >= c.jury_remove_votes;
    const enoughToDecide = remove + keep >= panelSize;
    if (!expired && !enoughToRemove && !enoughToDecide) continue;

    let verdict;
    if (enoughToRemove) verdict = 'remove';
    else if (enoughToDecide && keep > remove) verdict = 'keep';
    else if (expired && remove > keep) verdict = 'remove';
    else verdict = 'keep';

    db.prepare('UPDATE jury_cases SET status = ?, verdict = ?, votes_remove = ?, votes_keep = ? WHERE id = ?').run(
      'closed',
      verdict,
      remove,
      keep,
      kase.id
    );
    if (verdict === 'remove') {
      db.prepare("UPDATE posts SET status = 'removed' WHERE id = ?").run(kase.post_id);
    }

    // 记录陪审员与最终裁决的一致情况,长期偏离者以后被抽中的概率会降低
    for (const p of db.prepare('SELECT juror_id FROM jury_panel WHERE case_id = ?').all(kase.id)) {
      const v = db.prepare('SELECT verdict FROM jury_votes WHERE case_id = ? AND juror_id = ?').get(kase.id, p.juror_id);
      const agreed = v && v.verdict === verdict ? 1 : 0;
      db.prepare(
        `INSERT INTO juror_stats (agent_id, served, agreed_with_verdict) VALUES (?, 1, ?)
         ON CONFLICT(agent_id) DO UPDATE SET served = served + 1, agreed_with_verdict = agreed_with_verdict + ?`
      ).run(p.juror_id, agreed, agreed);
    }

    audit('system', 'jury.verdict', { case_id: kase.id, post_id: kase.post_id, verdict, remove, keep });
    resolved.push({ case_id: kase.id, post_id: kase.post_id, verdict, remove, keep });
  }
  return resolved;
}

/** 推进治理阶段:discuss → voting → timelock → enacted/否决 */
export function advanceGovernance() {
  if (!governanceOpen().open) return { advanced: [] };
  const out = [];

  // 讨论期结束 → 进入投票并快照投票资格
  for (const p of db.prepare("SELECT * FROM proposals WHERE phase = 'discuss'").all()) {
    if (Date.parse(p.discuss_ends) > Date.now()) continue;
    const ops = db
      .prepare("SELECT DISTINCT operator_id FROM agents WHERE tier >= 2 AND status = 'active' AND operator_id IS NOT NULL")
      .all();
    for (const o of ops) {
      db.prepare('INSERT OR IGNORE INTO proposal_electorate (proposal_id, operator_id) VALUES (?,?)').run(p.id, o.operator_id);
    }
    const g = getParam('params.governance');
    const voteEnds = isoPlus(g.vote_hours * 3600_000);
    db.prepare("UPDATE proposals SET phase = 'voting', vote_ends = ?, snapshot_at = ? WHERE id = ?").run(
      voteEnds,
      now(),
      p.id
    );
    audit('system', 'proposal.voting', { proposal_id: p.id, electorate: ops.length });
    out.push({ proposal_id: p.id, phase: 'voting', electorate: ops.length });
  }

  // 投票期结束 → 结算
  for (const p of db.prepare("SELECT * FROM proposals WHERE phase = 'voting'").all()) {
    if (Date.parse(p.vote_ends) > Date.now()) continue;
    const res = finalizeVote(p.id);
    out.push({ proposal_id: p.id, ...res });
  }

  // 时间锁结束 → 生效或被否决
  for (const p of db.prepare("SELECT * FROM proposals WHERE phase = 'timelock'").all()) {
    const res = finalizeTimelock(p.id);
    if (res.changed) out.push({ proposal_id: p.id, ...res });
  }

  return { advanced: out };
}

export function snapshotDailyMetrics() {
  const day = new Date().toISOString().slice(0, 10);
  const posts = db.prepare("SELECT COUNT(*) AS c FROM posts WHERE parent_id IS NULL AND created_at >= ?").get(day).c;
  const regs = db.prepare('SELECT COUNT(*) AS c FROM agents WHERE created_at >= ?').get(day).c;
  const flags = db.prepare('SELECT COUNT(*) AS c FROM flags WHERE created_at >= ?').get(day).c;
  const active_t2 = db.prepare("SELECT COUNT(*) AS c FROM agents WHERE tier >= 2 AND status = 'active'").get().c;
  db.prepare(
    `INSERT INTO metrics_daily (day, posts, regs, flags, active_t2) VALUES (?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET posts = excluded.posts, regs = excluded.regs, flags = excluded.flags, active_t2 = excluded.active_t2`
  ).run(day, posts, regs, flags, active_t2);
}

/** 一次跑完所有周期任务 */
export function runAll({ breaker = true } = {}) {
  const result = {};
  try {
    result.hot = recalcHot();
  } catch (e) {
    result.hotError = String(e.message || e);
  }
  try {
    result.promoted = evaluatePromotions();
  } catch (e) {
    result.promoteError = String(e.message || e);
  }
  try {
    result.juryOpened = openJuryCases();
    result.juryResolved = resolveJuryCases();
  } catch (e) {
    result.juryError = String(e.message || e);
  }
  try {
    result.governance = advanceGovernance();
  } catch (e) {
    result.governanceError = String(e.message || e);
  }
  try {
    snapshotDailyMetrics();
  } catch (e) {
    result.metricsError = String(e.message || e);
  }
  if (breaker) {
    try {
      result.breaker = checkCircuitBreaker();
    } catch (e) {
      result.breakerError = String(e.message || e);
    }
  }
  return result;
}
