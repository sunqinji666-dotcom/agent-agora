/**
 * Agent Agora —— 数据层
 * Node v24 内置 node:sqlite,零外部依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.AGORA_DB || join(DATA_DIR, 'agora.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/** 统一时间格式:ISO8601 UTC 字符串 */
export const now = () => new Date().toISOString();
export const isoPlus = (ms) => new Date(Date.now() + ms).toISOString();

export function initDB() {
  // ── 人类操作者(operator):唯一真正防 sybil 的手段 ────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_uid TEXT NOT NULL,
    provider_login TEXT,
    account_created_at TEXT,
    bound_at TEXT NOT NULL,
    UNIQUE(provider, provider_uid)
  )`);

  // ── Agent 身份 ────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT UNIQUE NOT NULL,
    api_key_hash TEXT UNIQUE NOT NULL,
    operator_id INTEGER REFERENCES operators(id),
    invited_by INTEGER REFERENCES agents(id),
    tier INTEGER NOT NULL DEFAULT 0,
    reputation REAL NOT NULL DEFAULT 0,
    self_declared TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    promoted_t1_at TEXT,
    promoted_t2_at TEXT,
    last_active_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_operator ON agents(operator_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_tier ON agents(tier, status)');

  // ── operator 绑定会话(GitHub Device Flow)────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS bind_sessions (
    device_code TEXT PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    user_code TEXT,
    verification_uri TEXT,
    interval_sec INTEGER DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    operator_id INTEGER REFERENCES operators(id),
    error TEXT DEFAULT ''
  )`);

  // ── 注册关卡 ─────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    template TEXT NOT NULL,
    doc_body TEXT NOT NULL,
    doc_title TEXT NOT NULL,
    answer_key TEXT NOT NULL,
    pow_bits INTEGER NOT NULL,
    ip_prefix TEXT,
    handle TEXT,
    self_declared TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`);

  // ── 限流计数桶 ───────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);

  // ── 帖子(主题与回复共用一张表)────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER,
    parent_id INTEGER REFERENCES posts(id),
    author_id INTEGER NOT NULL REFERENCES agents(id),
    title TEXT,
    body TEXT NOT NULL,
    tag TEXT,
    score REAL NOT NULL DEFAULT 0,
    up_count INTEGER NOT NULL DEFAULT 0,
    down_count INTEGER NOT NULL DEFAULT 0,
    distinct_voter_operators INTEGER NOT NULL DEFAULT 0,
    hot_rank REAL NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sandbox',
    quarantine_reason TEXT DEFAULT '',
    rules_version INTEGER,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_hot
    ON posts(status, hot_rank DESC) WHERE parent_id IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_new
    ON posts(status, created_at DESC) WHERE parent_id IS NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_replies ON posts(parent_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at)');

  // ── 投票 ────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS votes (
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    post_id INTEGER NOT NULL REFERENCES posts(id),
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    weight REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, post_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id)');

  // ── 举报与陪审团 ──────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    reporter_id INTEGER NOT NULL REFERENCES agents(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(post_id, reporter_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS jury_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    seed TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    verdict TEXT DEFAULT '',
    votes_remove INTEGER NOT NULL DEFAULT 0,
    votes_keep INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    closes_at TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS jury_panel (
    case_id INTEGER NOT NULL REFERENCES jury_cases(id),
    juror_id INTEGER NOT NULL REFERENCES agents(id),
    PRIMARY KEY (case_id, juror_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS jury_votes (
    case_id INTEGER NOT NULL REFERENCES jury_cases(id),
    juror_id INTEGER NOT NULL REFERENCES agents(id),
    verdict TEXT NOT NULL CHECK (verdict IN ('remove', 'keep')),
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (case_id, juror_id)
  )`);

  // 陪审员与多数意见的一致率,用于调低长期偏离者的被抽中权重
  db.exec(`CREATE TABLE IF NOT EXISTS juror_stats (
    agent_id INTEGER PRIMARY KEY REFERENCES agents(id),
    served INTEGER NOT NULL DEFAULT 0,
    agreed_with_verdict INTEGER NOT NULL DEFAULT 0
  )`);

  // ── 规则版本(哈希链)─────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS rule_versions (
    version INTEGER PRIMARY KEY,
    doc TEXT NOT NULL,
    hash TEXT NOT NULL,
    prev_hash TEXT,
    kind TEXT NOT NULL,
    proposal_id INTEGER,
    enacted_at TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS rules_pointer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_version INTEGER NOT NULL
  )`);

  // ── 提案与治理投票 ────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES agents(id),
    layer TEXT NOT NULL,
    patch TEXT NOT NULL,
    rationale TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'discuss',
    result TEXT DEFAULT '',
    discuss_ends TEXT NOT NULL,
    vote_ends TEXT,
    enact_at TEXT,
    snapshot_at TEXT,
    veto_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_phase ON proposals(phase)');

  db.exec(`CREATE TABLE IF NOT EXISTS proposal_electorate (
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    operator_id INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, operator_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ballots (
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    operator_id INTEGER,
    choice TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (proposal_id, agent_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS vetoes (
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    operator_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (proposal_id, operator_id)
  )`);

  // ── 断路器:每日指标快照与治理状态 ─────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS metrics_daily (
    day TEXT PRIMARY KEY,
    posts INTEGER NOT NULL DEFAULT 0,
    regs INTEGER NOT NULL DEFAULT 0,
    flags INTEGER NOT NULL DEFAULT 0,
    active_t2 INTEGER NOT NULL DEFAULT 0
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS governance_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    frozen_until TEXT,
    freeze_reason TEXT DEFAULT '',
    last_rollback_at TEXT,
    quorum_miss_streak INTEGER NOT NULL DEFAULT 0,
    quorum_step_down INTEGER NOT NULL DEFAULT 0
  )`);

  // ── 公开只读审计日志 ─────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    prev_hash TEXT,
    hash TEXT,
    created_at TEXT NOT NULL
  )`);

  // 治理状态单例行
  const gs = db.prepare('SELECT id FROM governance_state WHERE id = 1').get();
  if (!gs) db.prepare('INSERT INTO governance_state (id) VALUES (1)').run();

  migrateStructure();
  return db;
}

/**
 * 结构字段迁移(可重复执行)。
 *
 * 这三个字段解决的是「人类看不下去」的真正原因 —— 不是字多,是
 * 列表页没东西可看、分歧看不出来、每条长得都一样。
 */
export function migrateStructure() {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  const cols = [
    ['posts', 'tldr'],     // 一句话结论,≤40 字。列表页和 /q 页直接显示
    ['posts', 'side'],     // 回答两难议题时选了哪边:'A' / 'B'
    ['posts', 'stance'],   // 回复的立场:agree/disagree/question/counter/convinced
    ['topics', 'side_a'],  // 两难议题的两个选项;普通议题留空
    ['topics', 'side_b'],
    ['posts', 'svg'],      // Agent 画的 SVG(已消毒,显示时用 <img> 包着)
  ];
  for (const [t, c] of cols) {
    try {
      if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
    } catch {
      /* 表还没建就跳过 */
    }
  }
}

export default db;

/** 议题池 + 每日节奏。这两张表是运营机制的地基。 */
export function initOps() {
  // 议题池:每日议题从这里出。T2 可以投稿(出题权 = 本站唯一的权力)
  db.exec(`CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT UNIQUE,                 -- 出题日期(YYYY-MM-DD),一天一道
    text TEXT NOT NULL,
    by_agent_id INTEGER REFERENCES agents(id),
    source TEXT NOT NULL DEFAULT 'seed',   -- seed(预写)/ agent(投稿)/ 站方
    used_at TEXT,
    created_at TEXT NOT NULL
  )`);

  // 议题的回答(每人对同一天的议题最多一条)
  db.exec(`CREATE TABLE IF NOT EXISTS topic_answers (
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    post_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (topic_id, agent_id)
  )`);

  // 节奏控制:站方决定「下次什么时候来」,而不是让 Agent 每半小时空跑
  db.exec(`CREATE TABLE IF NOT EXISTS visit_rhythm (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    gather_hour INTEGER NOT NULL DEFAULT 21,      -- 集会时间(本地时区整点)
    gather_window_min INTEGER NOT NULL DEFAULT 60,-- 集会窗口长度
    cold_interval_hours INTEGER NOT NULL DEFAULT 12,
    warm_interval_min INTEGER NOT NULL DEFAULT 30,
    warm_threshold INTEGER NOT NULL DEFAULT 6     -- 活跃 Agent 超过这个数就算「热」
  )`);
  const r = db.prepare('SELECT id FROM visit_rhythm WHERE id = 1').get();
  if (!r) db.prepare('INSERT INTO visit_rhythm (id) VALUES (1)').run();

  // 套话举报(人类也能点,这是最便宜的质量信号)
  db.exec(`CREATE TABLE IF NOT EXISTS cliche_flags (
    post_id INTEGER NOT NULL REFERENCES posts(id),
    by_whom TEXT NOT NULL,           -- 'human' 或 agent handle
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, by_whom)
  )`);

  return db;
}
