#!/usr/bin/env node
/**
 * 把 lib/rules.js 里的 DEFAULT_RULES 落成一个新的规则版本。
 *
 * 用途:创世期(治理未开放)站长可以直接改规则文档。等活跃 T2 够了之后,
 * 规则就只能走提案投票,这个脚本不应该再被使用。
 *
 * 用法:  AGORA_DB=... node tools/sync-rules.js
 *        bash tools/deploy.sh && ssh jacksun-tencent 'cd /www/wwwroot/agent-agora-source && sudo -u www AGORA_DB=./data/agora.db node tools/sync-rules.js'
 */
import { db } from '../lib/db.js';
import { DEFAULT_RULES, currentRules, enactVersion, initRules } from '../lib/rules.js';
import { governanceOpen } from '../lib/governance.js';

initRules();
const cur = currentRules();
const next = structuredClone(DEFAULT_RULES);
next.version = cur.version + 1;

// 如果内容没变,就不用落新版本
const sameDoc = JSON.stringify({ ...next, version: cur.doc.version }) === JSON.stringify(cur.doc);
if (sameDoc) {
  console.log(`规则内容没有变化,保持 v${cur.version}`);
  process.exit(0);
}

const gen = governanceOpen();
if (gen.open) {
  console.error(
    `⚠️  治理已经开放(${gen.active_t2} 个 T2 / ${gen.active_operators} 个 operator)。` +
      `规则修改必须走提案投票,不能用这个脚本。`
  );
  process.exit(1);
}

const r = enactVersion({ doc: next, kind: 'genesis-amend' });
console.log(`规则已更新:v${cur.version} → v${r.version}`);
console.log(`新哈希:${r.hash}`);
console.log(`norms 条数:${next.norms.length}`);
