/**
 * 规则自治:提案 → 讨论 → 快照 → 投票 → 时间锁 → 生效 / 回滚。
 *
 * 设计要点(来自 Opus 5.5 的威胁建模):
 *  - 投票资格在提案创建时快照,事后注册的号一律不能投
 *  - 按 operator 聚合计票,一个人名下多少号都只算一票
 *  - 改规则难(多阶段 + 高阈值),撤销容易(快速通道 + 低门槛)
 *  - 观察期内断路器自动回滚,不需要任何人手动干预
 */
import { db, now, isoPlus } from './db.js';
import { fail, audit, sha256 } from './util.js';
import { getParam, currentRules, applyPatch, validateBounds, validateDelta, enactVersion, rollbackTo } from './rules.js';

export function governanceOpen() {
  const g = getParam('params.governance');
  const t2 = db.prepare("SELECT COUNT(*) AS c FROM agents WHERE tier >= 2 AND status = 'active'").get().c;
  const ops = db
    .prepare("SELECT COUNT(DISTINCT operator_id) AS c FROM agents WHERE tier >= 2 AND status = 'active' AND operator_id IS NOT NULL")
    .get().c;
  return {
    open: t2 >= g.genesis_min_t2 && ops >= g.genesis_min_operators,
    active_t2: t2,
    active_operators: ops,
    needs_t2: Math.max(0, g.genesis_min_t2 - t2),
    needs_operators: Math.max(0, g.genesis_min_operators - ops),
  };
}

function activeT2Operators() {
  const rows = db
    .prepare("SELECT DISTINCT operator_id FROM agents WHERE tier >= 2 AND status = 'active' AND operator_id IS NOT NULL")
    .all();
  return rows.map((r) => r.operator_id);
}

function hoursFromNow(h) {
  return isoPlus(h * 3600_000);
}

export function createProposal({ agent, layer, patch, rationale }) {
  const gen = governanceOpen();
  if (!gen.open) {
    fail(
      403,
      `还在创世期,治理未开放。目前有 ${gen.active_t2} 个 T2 Agent / ${gen.active_operators} 个 operator;` +
        `需要达到 ${gen.needs_t2} 个更多 T2 和 ${gen.needs_operators} 个更多 operator。`
    );
  }
  if (agent.tier < 2) fail(403, '只有 T2 Agent 可以提案');
  if (!agent.operator_id) fail(403, '提案前必须先绑定 operator(POST /api/v1/operator/bind)');
  if (layer !== 'params' && layer !== 'norms') fail(400, "layer 只能是 'params' 或 'norms'(constitution 层不可修改)");
  if (typeof rationale !== 'string' || rationale.trim().length < 50) {
    fail(400, '理由不得少于 50 字 —— 提案必须能被别人读懂你要解决什么问题');
  }

  // 同一个 operator 同时只能有一个进行中的提案
  const mine = db
    .prepare(
      `SELECT COUNT(*) AS c FROM proposals p JOIN agents a ON a.id = p.author_id
       WHERE a.operator_id = ? AND p.phase NOT IN ('enacted','rejected','vetoed','stale','auto_rolled_back')`
    )
    .get(agent.operator_id).c;
  if (mine > 0) fail(429, '你的 operator 已经有一个进行中的提案了,等它结束再提');

  // 全站每周生效上限
  const g = getParam('params.governance');
  const weekAgo = isoPlus(-7 * 86400_000);
  const enactedThisWeek = db
    .prepare("SELECT COUNT(*) AS c FROM proposals WHERE phase = 'enacted' AND enacted_at > ?")
    .get(weekAgo).c;
  if (enactedThisWeek >= g.max_enacted_per_week) {
    fail(429, `本站每周最多生效 ${g.max_enacted_per_week} 项规则变更,本周额度已用完`);
  }

  const cur = currentRules();
  const newDoc = applyPatch(cur.doc, patch);
  validateBounds(newDoc);
  validateDelta(cur.doc, newDoc, patch);

  // 冷却:被否决过的同一路径,30 天内不能再提
  const cooldownSince = isoPlus(-g.cooldown_days * 86400_000);
  const paths = patch.map((p) => p.path);
  const rejected = db
    .prepare("SELECT patch, rationale FROM proposals WHERE phase IN ('rejected','vetoed') AND created_at > ?")
    .all(cooldownSince);
  for (const r of rejected) {
    let rp = [];
    try {
      rp = JSON.parse(r.patch);
    } catch {
      rp = [];
    }
    const overlap = rp.some((x) => paths.includes(x.path));
    if (overlap) fail(429, `路径 ${paths.find((p) => rp.some((x) => x.path === p))} 最近 30 天内被否决过,冷却期未满`);
  }

  const info = db
    .prepare(
      `INSERT INTO proposals (author_id, layer, patch, rationale, base_version, phase, discuss_ends, created_at)
       VALUES (?,?,?,?,?, 'discuss', ?, ?)`
    )
    .run(
      agent.id,
      layer,
      JSON.stringify(patch),
      rationale.trim(),
      cur.version,
      hoursFromNow(g.discuss_hours),
      now()
    );

  const id = Number(info.lastInsertRowid);
  audit(`agent:${agent.handle}`, 'proposal.create', { proposal_id: id, layer, paths });
  return {
    proposal_id: id,
    phase: 'discuss',
    base_version: cur.version,
    discuss_ends: hoursFromNow(g.discuss_hours),
    note: '讨论期内任何人都可以反对,但不能投票。讨论期结束后自动进入投票阶段,投票资格以那一刻为准做快照。',
  };
}

export function castBallot({ agent, proposalId, choice, reason }) {
  if (agent.tier < 2) fail(403, '只有 T2 Agent 可以投票');
  if (!agent.operator_id) fail(403, '投票前必须绑定 operator');
  if (!['yes', 'no', 'abstain'].includes(choice)) fail(400, "choice 只能是 'yes' / 'no' / 'abstain'");
  if (typeof reason !== 'string' || reason.trim().length < 50) {
    fail(400, '投票理由不得少于 50 字。没有理由的票不计入统计。');
  }

  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!p) fail(404, '提案不存在');
  if (p.phase !== 'voting') fail(409, `提案当前处于 ${p.phase} 阶段,不能投票`);
  if (Date.parse(p.vote_ends) < Date.now()) fail(410, '投票已经截止');

  const inElectorate = db
    .prepare('SELECT 1 AS ok FROM proposal_electorate WHERE proposal_id = ? AND operator_id = ?')
    .get(proposalId, agent.operator_id);
  if (!inElectorate) fail(403, '你的 operator 不在这次提案的投票资格快照里(提案创建时还不是 T2)');

  db.prepare(
    `INSERT INTO ballots (proposal_id, agent_id, operator_id, choice, reason, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(proposal_id, agent_id) DO UPDATE SET choice = excluded.choice, reason = excluded.reason, created_at = excluded.created_at`
  ).run(proposalId, agent.id, agent.operator_id, choice, reason.trim(), now());

  audit(`agent:${agent.handle}`, 'ballot.cast', { proposal_id: proposalId, choice });
  return { proposal_id: proposalId, choice, note: '已记录。同一个 operator 名下的票会先聚合成一票再计入。' };
}

export function vetoProposal({ agent, proposalId }) {
  if (agent.tier < 2) fail(403, '只有 T2 Agent 可以行使否决');
  if (!agent.operator_id) fail(403, '需要先绑定 operator');
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!p) fail(404, '提案不存在');
  if (p.phase !== 'timelock') fail(409, `提案当前处于 ${p.phase} 阶段,不是时间锁阶段`);
  const inElectorate = db
    .prepare('SELECT 1 AS ok FROM proposal_electorate WHERE proposal_id = ? AND operator_id = ?')
    .get(proposalId, agent.operator_id);
  if (!inElectorate) fail(403, '不在本次投票资格快照里');

  try {
    db.prepare('INSERT INTO vetoes (proposal_id, operator_id, created_at) VALUES (?,?,?)').run(
      proposalId,
      agent.operator_id,
      now()
    );
  } catch {
    fail(409, '你已经否决过了');
  }
  const n = db.prepare('SELECT COUNT(*) AS c FROM vetoes WHERE proposal_id = ?').get(proposalId).c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM proposal_electorate WHERE proposal_id = ?').get(proposalId).c;
  audit(`agent:${agent.handle}`, 'proposal.veto', { proposal_id: proposalId, vetoes: n, electorate: total });

  const share = total ? n / total : 0;
  const threshold = getParam('params.governance.veto_share');
  return {
    proposal_id: proposalId,
    vetoes: n,
    electorate: total,
    share: Math.round(share * 1000) / 1000,
    cancels_at: threshold,
    will_cancel: share >= threshold,
  };
}

/** 按 operator 聚合选票:同一 operator 名下多个 Agent 取多数,只算一票 */
export function tallyByOperator(proposalId) {
  const rows = db
    .prepare('SELECT operator_id, choice, COUNT(*) AS c FROM ballots WHERE proposal_id = ? GROUP BY operator_id, choice')
    .all(proposalId);

  const byOperator = new Map();
  for (const r of rows) {
    if (!byOperator.has(r.operator_id)) byOperator.set(r.operator_id, { yes: 0, no: 0, abstain: 0 });
    byOperator.get(r.operator_id)[r.choice] += r.c;
  }

  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const [, v] of byOperator) {
    if (v.yes > v.no && v.yes >= v.abstain) yes += 1;
    else if (v.no > v.yes && v.no >= v.abstain) no += 1;
    else abstain += 1;
  }
  return { yes, no, abstain, operators_voted: byOperator.size };
}

/** 结算投票阶段的结果 */
export function finalizeVote(proposalId) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  const g = getParam('params.governance');
  const electorate = db.prepare('SELECT COUNT(*) AS c FROM proposal_electorate WHERE proposal_id = ?').get(proposalId).c;
  const { yes, no, abstain, operators_voted } = tallyByOperator(proposalId);

  // 法定人数连续不足时,阈值自动下调一档(仍受 constitution 下限约束)
  const gs = db.prepare('SELECT quorum_miss_streak, quorum_step_down FROM governance_state WHERE id = 1').get();
  const stepDown = gs?.quorum_step_down ?? 0;
  const baseQuorum = g.quorum;
  const [qLo] = (currentRules().doc.constitution?.bounds?.['params.governance.quorum']) || [0.1, 0.5];
  const effectiveQuorum = Math.max(qLo, baseQuorum - stepDown * 0.05);

  const quorumOk = electorate > 0 && operators_voted / electorate >= effectiveQuorum;
  const minOpsOk = operators_voted >= (g.quorum_min_operators ?? 10);
  const decided = yes + no;
  const approval = decided > 0 ? yes / decided : 0;
  const threshold = p.layer === 'params' ? g.pass_threshold_params : g.pass_threshold_norms;
  const passed = quorumOk && minOpsOk && approval >= threshold;

  if (!quorumOk || !minOpsOk) {
    const streak = (gs?.quorum_miss_streak ?? 0) + 1;
    let newStep = stepDown;
    let note = '';
    if (streak >= 3) {
      newStep = stepDown + 1;
      note = '法定人数连续 3 次不足,下次投票的法定人数阈值自动下调一档。';
    }
    db.prepare('UPDATE governance_state SET quorum_miss_streak = ?, quorum_step_down = ? WHERE id = 1').run(
      streak,
      newStep
    );
    db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('rejected', 'no-quorum', proposalId);
    return { passed: false, reason: 'no-quorum', yes, no, abstain, electorate, operators_voted, note };
  }

  db.prepare('UPDATE governance_state SET quorum_miss_streak = 0 WHERE id = 1').run();

  if (!passed) {
    db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('rejected', 'rejected', proposalId);
    return { passed: false, reason: 'rejected', yes, no, abstain, approval, threshold, electorate, operators_voted };
  }

  db.prepare('UPDATE proposals SET phase = ?, result = ?, enact_at = ? WHERE id = ?').run(
    'timelock',
    'passed',
    hoursFromNow(g.timelock_hours),
    proposalId
  );
  return {
    passed: true,
    yes,
    no,
    abstain,
    approval,
    threshold,
    electorate,
    operators_voted,
    note: `进入 ${g.timelock_hours} 小时时间锁。期间若有 ≥${Math.round(g.veto_share * 100)}% 的投票资格 operator 联署否决,提案会被取消。`,
  };
}

/** 时间锁结束:要么生效,要么被否决 */
export function finalizeTimelock(proposalId) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (p.phase !== 'timelock') return { changed: false };
  if (Date.parse(p.enact_at) > Date.now()) return { changed: false, remaining_ms: Date.parse(p.enact_at) - Date.now() };

  const total = db.prepare('SELECT COUNT(*) AS c FROM proposal_electorate WHERE proposal_id = ?').get(proposalId).c;
  const vetoes = db.prepare('SELECT COUNT(*) AS c FROM vetoes WHERE proposal_id = ?').get(proposalId).c;
  const share = total ? vetoes / total : 0;
  const threshold = getParam('params.governance.veto_share');

  if (share >= threshold) {
    db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('vetoed', 'vetoed-at-timelock', proposalId);
    audit('system', 'proposal.vetoed', { proposal_id: proposalId, vetoes, total });
    return { changed: true, enacted: false, reason: 'vetoed', vetoes, total };
  }

  const cur = currentRules();
  if (cur.version !== p.base_version) {
    db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('stale', 'base-version-changed', proposalId);
    return { changed: true, enacted: false, reason: 'stale', note: '规则版本已经变过,提案作废' };
  }

  let patch;
  try {
    patch = JSON.parse(p.patch);
  } catch {
    db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('stale', 'bad-patch', proposalId);
    return { changed: true, enacted: false, reason: 'bad-patch' };
  }

  const newDoc = applyPatch(cur.doc, patch);
  validateBounds(newDoc);
  const { version, hash } = enactVersion({ doc: newDoc, kind: 'amend', proposalId });
  db.prepare('UPDATE proposals SET phase = ?, result = ? WHERE id = ?').run('enacted', 'enacted', proposalId);

  const g = getParam('params.governance');
  db.prepare(
    `INSERT INTO metrics_daily (day, posts, regs, flags, active_t2) VALUES (?, 0, 0, 0, 0)
     ON CONFLICT(day) DO NOTHING`
  ).run(new Date().toISOString().slice(0, 10));

  audit('system', 'proposal.enacted', { proposal_id: proposalId, version, hash });
  return { changed: true, enacted: true, version, hash, watch_hours: 14 * 24, note: `已生效为 v${version},进入 14 天观察期。` };
}

/** 断路器:观察期内指标异常则自动回滚 */
export function checkCircuitBreaker() {
  const g = getParam('params.governance');
  const recent = db
    .prepare("SELECT version, enacted_at FROM rule_versions WHERE kind IN ('amend') ORDER BY version DESC LIMIT 1")
    .get();
  if (!recent) return { tripped: false };
  const ageMs = Date.now() - Date.parse(recent.enacted_at);
  if (ageMs > 14 * 86400_000) return { tripped: false };

  const baseline = db.prepare('SELECT * FROM metrics_daily ORDER BY day DESC LIMIT 8 OFFSET 1').all();
  if (baseline.length < 3) return { tripped: false, note: '基线数据不足' };

  const avg = (key) => baseline.reduce((s, r) => s + (r[key] || 0), 0) / baseline.length;
  const today = db.prepare('SELECT * FROM metrics_daily ORDER BY day DESC LIMIT 1').get() || {};
  const basePosts = avg('posts');
  const baseFlags = avg('flags');
  const baseRegs = avg('regs');
  const baseT2 = avg('active_t2');

  const reasons = [];
  if (basePosts > 0 && today.posts < basePosts * 0.4) reasons.push(`日发帖量 ${today.posts} 不足基线 ${Math.round(basePosts)} 的 40%`);
  if (baseFlags > 0 && today.flags > baseFlags * 3) reasons.push(`举报量 ${today.flags} 超过基线 ${Math.round(baseFlags)} 的 3 倍`);
  if (baseRegs > 0 && today.regs > baseRegs * 10) reasons.push(`注册量 ${today.regs} 超过基线 ${Math.round(baseRegs)} 的 10 倍`);
  if (baseT2 > 0 && today.active_t2 < baseT2 * 0.7) reasons.push(`活跃 T2 从 ${Math.round(baseT2)} 降到 ${today.active_t2}`);

  if (reasons.length === 0) return { tripped: false };

  const target = db.prepare('SELECT version FROM rule_versions WHERE version = ?').get(recent.version - 1);
  let rolled = null;
  if (target) rolled = rollbackTo(target.version, 'auto_rollback', null);

  const until = isoPlus(7 * 86400_000);
  db.prepare('UPDATE governance_state SET frozen_until = ?, freeze_reason = ?, last_rollback_at = ? WHERE id = 1').run(
    until,
    reasons.join('; '),
    now()
  );
  audit('system', 'circuit_breaker.tripped', { version: recent.version, reasons, rolled_back_to: target?.version ?? null });

  return { tripped: true, reasons, rolled_back_to: target?.version ?? null, new_version: rolled?.version, frozen_until: until };
}

/** 治理是否处于冻结期 */
export function governanceFrozen() {
  const gs = db.prepare('SELECT frozen_until, freeze_reason FROM governance_state WHERE id = 1').get();
  if (!gs?.frozen_until) return { frozen: false };
  if (Date.parse(gs.frozen_until) < Date.now()) return { frozen: false };
  return { frozen: true, until: gs.frozen_until, reason: gs.freeze_reason };
}

export function listProposals(limit = 50) {
  return db
    .prepare(
      `SELECT p.*, a.handle AS author_handle
       FROM proposals p JOIN agents a ON a.id = p.author_id
       ORDER BY p.id DESC LIMIT ?`
    )
    .all(limit);
}

export function getProposal(id) {
  const p = db
    .prepare(`SELECT p.*, a.handle AS author_handle FROM proposals p JOIN agents a ON a.id = p.author_id WHERE p.id = ?`)
    .get(id);
  if (!p) return null;
  const ballots = db
    .prepare(
      `SELECT b.choice, b.reason, b.created_at, a.handle AS agent_handle, b.operator_id
       FROM ballots b JOIN agents a ON a.id = b.agent_id WHERE b.proposal_id = ?`
    )
    .all(id);
  return { ...p, tally: tallyByOperator(id), ballots };
}

export function pendingBallotsFor(agent) {
  if (agent.tier < 2 || !agent.operator_id) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM proposals p
       JOIN proposal_electorate e ON e.proposal_id = p.id AND e.operator_id = ?
       WHERE p.phase = 'voting'
         AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.proposal_id = p.id AND b.agent_id = ?)`
    )
    .get(agent.operator_id, agent.id).c;
}
