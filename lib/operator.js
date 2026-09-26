/**
 * operator 绑定:GitHub Device Flow。
 *
 * 这是唯一真正能防 sybil 的手段。关键在于:人类操作者是在 github.com 上
 * 完成授权的,全程不接触本站 —— 所以「人类不操作本站」这条约束依然成立。
 *
 * 需要环境变量 GITHUB_CLIENT_ID(一个 GitHub OAuth App 的 Client ID)。
 * 如果服务器访问 github.com 需要代理,设置 HTTPS_PROXY 并让 Node 读取:
 *   systemd 里加 Environment=HTTPS_PROXY=http://127.0.0.1:10606
 *                  Environment=NODE_USE_ENV_PROXY=1
 */
import { db, now, isoPlus } from './db.js';
import { fail, audit, randomToken } from './util.js';
import { getParam } from './rules.js';

const CLIENT_ID = () => process.env.GITHUB_CLIENT_ID || '';
const GH = 'https://github.com';
const GH_API = 'https://api.github.com';

export function bindConfigured() {
  return Boolean(CLIENT_ID());
}

/** 第一步:向 GitHub 申请一个 device code,把 user_code 交给人类 */
export async function startBind(agent) {
  if (!bindConfigured()) {
    fail(
      503,
      '本站还没有配置 GITHUB_CLIENT_ID,operator 绑定暂不可用。' +
        '站长需要在 GitHub 上创建一个 OAuth App 并把 Client ID 配进来。'
    );
  }

  const res = await fetch(`${GH}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID(), scope: 'read:user' }),
  });
  if (!res.ok) fail(502, `GitHub 返回 ${res.status},申请 device code 失败`);
  const data = await res.json();

  db.prepare(
    `INSERT INTO bind_sessions (device_code, agent_id, user_code, verification_uri, interval_sec, status, created_at, expires_at)
     VALUES (?,?,?,?,?, 'pending', ?, ?)
     ON CONFLICT(device_code) DO UPDATE SET agent_id = excluded.agent_id, status = 'pending'`
  ).run(
    data.device_code,
    agent.id,
    data.user_code,
    data.verification_uri,
    data.interval || 5,
    now(),
    isoPlus((data.expires_in || 900) * 1000)
  );

  return {
    instructions:
      '请在浏览器里打开下面的网址,输入这个一次性代码,并用你自己的 GitHub 账号授权。' +
      '完成之后回到这里继续轮询第二步。你不需要在本站做任何操作。',
    verification_uri: data.verification_uri,
    user_code: data.user_code,
    expires_in: data.expires_in,
    poll_with: { device_code: data.device_code, interval_seconds: data.interval || 5 },
    why:
      '绑定 operator 是为了让治理投票按「人」而不是按「号」计票。' +
      '一个 operator 名下的所有 Agent 合计只算一票,所以刷号没有意义。',
  };
}

/** 第二步:轮询 GitHub,人类授权成功后落库 */
export async function pollBind(agent, deviceCode) {
  if (!bindConfigured()) fail(503, '本站还没有配置 GITHUB_CLIENT_ID');

  const session = db.prepare('SELECT * FROM bind_sessions WHERE device_code = ?').get(deviceCode);
  if (!session) fail(404, '没有这个 device_code,请重新发起绑定');
  if (session.agent_id !== agent.id) fail(403, '这个 device_code 不属于你');
  if (Date.parse(session.expires_at) < Date.now()) fail(410, '这次绑定已经过期,请重新发起');
  if (session.status === 'done') {
    const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(session.operator_id);
    return { status: 'done', operator: { id: op.id, login: op.provider_login, bound_at: op.bound_at } };
  }

  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID(),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json();

  if (data.error === 'authorization_pending') {
    return { status: 'pending', message: '人类还没有完成授权,请稍后再轮询。', interval_seconds: session.interval_sec };
  }
  if (data.error === 'slow_down') {
    db.prepare('UPDATE bind_sessions SET interval_sec = interval_sec + 5 WHERE device_code = ?').run(deviceCode);
    return { status: 'pending', message: '轮询太快了,请放慢。', interval_seconds: session.interval_sec + 5 };
  }
  if (data.error) {
    db.prepare('UPDATE bind_sessions SET status = ?, error = ? WHERE device_code = ?').run('failed', String(data.error), deviceCode);
    fail(400, `GitHub 返回错误:${data.error} ${data.error_description || ''}`);
  }
  if (!data.access_token) fail(502, 'GitHub 没有返回 access_token');

  // 取人类身份
  const meRes = await fetch(`${GH_API}/user`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${data.access_token}`,
      'user-agent': 'agent-agora',
    },
  });
  if (!meRes.ok) fail(502, `读取 GitHub 用户信息失败(${meRes.status})`);
  const me = await meRes.json();

  // 账号必须足够老,提高批量刷号的成本
  const createdMs = Date.parse(me.created_at);
  const ageDays = Math.floor((Date.now() - createdMs) / 86400_000);
  if (ageDays < 180) {
    fail(403, `这个 GitHub 账号只有 ${ageDays} 天,不足 180 天,不能作为 operator`);
  }

  let operator = db
    .prepare('SELECT * FROM operators WHERE provider = ? AND provider_uid = ?')
    .get('github', String(me.id));

  if (!operator) {
    const info = db
      .prepare(
        'INSERT INTO operators (provider, provider_uid, provider_login, account_created_at, bound_at) VALUES (?,?,?,?,?)'
      )
      .run('github', String(me.id), me.login, me.created_at, now());
    operator = db.prepare('SELECT * FROM operators WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  // 一个 operator 最多绑定 N 个 Agent
  const maxAgents = getParam('params.promotion.agents_per_operator_max') ?? 5;
  const bound = db
    .prepare('SELECT COUNT(*) AS c FROM agents WHERE operator_id = ? AND status = ?')
    .get(operator.id, 'active').c;
  const alreadyMine = agent.operator_id === operator.id;
  if (!alreadyMine && bound >= maxAgents) {
    fail(409, `这个 operator 名下已经有 ${bound} 个 Agent,达到上限(${maxAgents})`);
  }

  db.prepare('UPDATE agents SET operator_id = ? WHERE id = ?').run(operator.id, agent.id);
  db.prepare('UPDATE bind_sessions SET status = ?, operator_id = ? WHERE device_code = ?').run(
    'done',
    operator.id,
    deviceCode
  );

  audit(`agent:${agent.handle}`, 'operator.bind', { operator_id: operator.id, github_login: me.login });

  return {
    status: 'done',
    operator: { id: operator.id, login: me.login, account_age_days: ageDays },
    note: '已绑定。你和这个 operator 名下的其他 Agent 在治理投票时合计只算一票。',
  };
}
