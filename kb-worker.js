/**
 * 探域知识库 → 云数据库 定时同步器
 * 由 GitHub Actions 每 3 小时调用一次，不依赖任何本机环境、不消耗智能体。
 *
 * 做的事：
 *   1. 用探域 cookie 抓「全店知识」全部卡片 + 自定义 Agent + 店铺映射
 *   2. 与云库里上一份快照逐张比对，算出新增 / 修改 / 删除
 *   3. 把页面渲染所需的数据写回云库 kb_snapshot（id=1）
 *
 * 环境变量：
 *   TANYU_COOKIE   探域登录 cookie 串，形如 tanyu-agent-account=xxxx
 *   WB_ENDPOINT    云库地址 https://xxx.app.workbuddy.host
 *   WB_KEY         云库 publishableKey（wbpk_ 开头）
 *   WB_SHARECODE   分享码，用于换取访问 cookie
 */
'use strict';

const BASE = 'https://agent.tanyuai.com';
const SOURCE = 'https://agent.tanyuai.com/v2/agent-builder/knowledge-base';
const PLAT = { 0: '淘宝', 1: '拼多多', 5: '抖店', 7: '京东' };
const KEEP_HISTORY = 12;
const SNAP_ID = 1;

const COOKIE = (process.env.TANYU_COOKIE || '').trim();
const ENDPOINT = (process.env.WB_ENDPOINT || '').replace(/\/+$/, '');
const KEY = (process.env.WB_KEY || '').trim();
const SHARECODE = (process.env.WB_SHARECODE || '').trim();

function die(msg) {
  console.error('ERR: ' + msg);
  process.exit(1);
}
function pad(n) { return String(n).padStart(2, '0'); }

/* 北京时间（GitHub runner 是 UTC，统一按 +8 计算） */
function bj(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const Y = t.getUTCFullYear(), M = pad(t.getUTCMonth() + 1), D = pad(t.getUTCDate());
  const h = pad(t.getUTCHours()), m = pad(t.getUTCMinutes());
  return { full: Y + '-' + M + '-' + D + ' ' + h + ':' + m, md: M + '-' + D, hm: h + ':' + m };
}
function toSec(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : v;
  const d = new Date(String(v).replace(' ', 'T'));
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

/* ---------------- 探域抓取 ---------------- */
async function api(url, method, body) {
  const res = await fetch(BASE + url, {
    method: method || 'GET',
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) {
    throw new Error('非 JSON 返回 ' + res.status + ' ' + txt.slice(0, 140));
  }
  if (j.code !== undefined && j.code !== 1 && j.code !== 0 && j.code !== 200) {
    throw new Error('接口错误 code=' + j.code + ' msg=' + (j.msg || ''));
  }
  return j;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 单页请求：返回空列表时重试，海内外网络抖动都能兜住 */
async function fetchPage(body, tries) {
  tries = tries || 3;
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await api('/api/kbe/v1/knowledge-card/page', 'POST', body);
    const list = ((last.data || {}).results) || [];
    if (list.length) return last;
    if (i < tries - 1) {
      console.log('  第 ' + (i + 1) + ' 次返回空页，1.5 秒后重试');
      await sleep(1500);
    }
  }
  return last;
}

async function fetchAll() {
  const brief = await api('/api/gc/agent-personal/brief?searchValid=true');
  const shops = (brief.data || []).map(x => ({ thirdShopId: x.thirdShopId, shopName: x.shopName, platform: x.platform }));
  if (!shops.length) throw new Error('店铺映射为空，探域登录态可能已失效');

  // pageSize 放大到 500：1056 张卡只需 3 页，少一次请求就少一次中断机会
  const base = { sortIfNew: true, pageSize: 500, searchView: 'KNOWLEDGE', spu: [], labels: [], type: 'SHOP' };
  let cursor = null, cards = [], total = null, pages = 0, lastFirstId = null, guard = 0;
  const seen = new Set();
  while (guard++ < 40) {
    const body = Object.assign({}, base);
    if (cursor) { body.lastUpdatedAt = cursor.t; body.lastId = cursor.id; }
    const j = await fetchPage(body);
    const d = j.data || {};
    if (total === null) total = d.total;
    const list = d.results || [];
    if (!list.length) break;
    if (list[0].id === lastFirstId) break;
    lastFirstId = list[0].id;
    pages++;
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const ic = c.includeCondition || {};
      cards.push({
        id: c.id,
        title: c.title || '',
        ifBelievable: !!c.ifBelievable,
        ifOpen: !!c.ifOpen,
        version: c.version || '',
        labels: (c.labelInfos || []).map(l => l.label).filter(Boolean),
        shopNames: ic.shop || [],
        spuShopIds: (ic.spu || []).map(s => s.thirdShopId).filter(Boolean),
        createdAt: c.createdAt || '',
        lastUpdatedAt: c.lastUpdatedAt || '',
        chunks: (c.content || []).length,
      });
    }
    if (total && cards.length >= total) break;
    const last = list[list.length - 1];
    cursor = { t: toSec(last.lastUpdatedAt), id: last.id };
    await sleep(300);
  }
  if (!cards.length) throw new Error('未抓到任何知识卡');
  if (total && cards.length < total * 0.9) {
    throw new Error('抓取不完整：接口 total=' + total + ' 实际=' + cards.length);
  }

  const agj = await api('/api/kbe/v1/agent/customized-agent/list');
  const arr = Array.isArray(agj.data) ? agj.data : ((agj.data || {}).list || []);
  const agents = arr.map(a => ({
    id: a.id, name: a.name, scope: a.scope,
    isRun: !!a.isRun, draftsIsRun: !!a.draftsIsRun,
    publishTime: a.publishTime || '',
    shopCount: (a.relationShop || []).length,
    productCount: (a.relationProducts || []).length,
    groupCount: (a.relationProductGroups || []).length,
  }));

  return { shops, cards, agents, apiTotal: total, pages };
}

/* ---------------- 云库读写 ---------------- */
let sharedCookie = '';
async function ensureCookie() {
  if (sharedCookie) return sharedCookie;
  if (!SHARECODE) return '';
  const r = await fetch(ENDPOINT + '/?sharecode=' + SHARECODE, { redirect: 'manual' });
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  sharedCookie = list.map(c => c.split(';')[0]).join('; ');
  return sharedCookie;
}

async function cloudGet() {
  const ck = await ensureCookie();
  const r = await fetch(ENDPOINT + '/.cloud/database/rest/kb_snapshot?id=eq.' + SNAP_ID + '&select=id,payload,cards,updated_at', {
    headers: Object.assign({ 'x-wb-webapp-access-key': KEY }, ck ? { Cookie: ck } : {}),
  });
  if (!r.ok) throw new Error('读云库失败 ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const rows = await r.json();
  return rows && rows[0] ? rows[0] : null;
}

async function cloudWrite(row, exists) {
  const ck = await ensureCookie();
  const headers = Object.assign({
    'x-wb-webapp-access-key': KEY,
    'content-type': 'application/json',
    Prefer: 'return=representation',
  }, ck ? { Cookie: ck } : {});
  const url = exists
    ? ENDPOINT + '/.cloud/database/rest/kb_snapshot?id=eq.' + SNAP_ID
    : ENDPOINT + '/.cloud/database/rest/kb_snapshot';
  const r = await fetch(url, { method: exists ? 'PATCH' : 'POST', headers, body: JSON.stringify(row) });
  if (!r.ok) throw new Error('写云库失败 ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

/* ---------------- 比对 ---------------- */
function shopName(card, by3) {
  const ids = [];
  for (const i of card.spuShopIds || []) ids.push(String(i));
  for (const sn of card.shopNames || []) {
    if (sn && typeof sn === 'object') {
      const v = sn.thirdShopId || sn.shopId || sn.id;
      if (v) ids.push(String(v));
    } else if (sn) ids.push(String(sn));
  }
  for (const i of ids) if (by3[i]) return by3[i];
  return '';
}

function diffFields(old, now, by3) {
  const out = [];
  if ((old.title || '') !== (now.title || '')) {
    out.push('标题：「' + (old.title || '空').slice(0, 40) + '」→「' + (now.title || '空').slice(0, 40) + '」');
  }
  if (!!old.ifOpen !== !!now.ifOpen) {
    out.push('启用状态：' + (old.ifOpen ? '启用' : '关闭') + ' → ' + (now.ifOpen ? '启用' : '关闭'));
  }
  if (!!old.ifBelievable !== !!now.ifBelievable) {
    out.push('可信标记：' + (old.ifBelievable ? '可信' : '待核') + ' → ' + (now.ifBelievable ? '可信' : '待核'));
  }
  const oc = old.chunks || 0, nc = now.chunks || 0;
  if (oc !== nc) out.push('子知识段数：' + oc + ' → ' + nc + '（' + (nc - oc >= 0 ? '+' : '') + (nc - oc) + '）');

  const ol = new Set(old.labels || []), nl = new Set(now.labels || []);
  const sameLabel = ol.size === nl.size && [...ol].every(x => nl.has(x));
  if (!sameLabel) {
    const seg = [];
    const add = [...nl].filter(x => !ol.has(x)).sort();
    const rem = [...ol].filter(x => !nl.has(x)).sort();
    if (add.length) seg.push('增加 ' + add.join('、'));
    if (rem.length) seg.push('去掉 ' + rem.join('、'));
    out.push('标签：' + seg.join('；'));
  }

  const op = new Set((old.spuShopIds || []).map(String)), np = new Set((now.spuShopIds || []).map(String));
  const sameShop = op.size === np.size && [...op].every(x => np.has(x));
  if (!sameShop) {
    const add = [...np].filter(x => !op.has(x)).map(x => by3[x] || x);
    const rem = [...op].filter(x => !np.has(x)).map(x => by3[x] || x);
    const seg = [];
    if (add.length) seg.push('新增关联 ' + add.slice(0, 3).join('、') + (add.length > 3 ? '等 ' + add.length + ' 家' : ''));
    if (rem.length) seg.push('解除关联 ' + rem.slice(0, 3).join('、') + (rem.length > 3 ? '等 ' + rem.length + ' 家' : ''));
    out.push('关联店铺：' + seg.join('；'));
  }
  if ((old.version || '') !== (now.version || '') && !out.length) {
    out.push('版本：' + (old.version || '—') + ' → ' + (now.version || '—'));
  }
  return out;
}

function buildChanges(prev, now, by3) {
  if (!prev || !prev.length) {
    return { baseline: true, prevAt: null, added: [], updated: [], removed: [] };
  }
  const oc = new Map(prev.map(c => [c.id, c]));
  const nc = new Map(now.map(c => [c.id, c]));
  const added = [], updated = [], removed = [];
  for (const [id, c] of nc) {
    if (!oc.has(id)) {
      added.push({
        id, title: c.title || '(无标题)',
        shop: shopName(c, by3),
        labels: (c.labels || []).slice().sort().slice(0, 4),
        chunks: c.chunks || 0,
        open: !!c.ifOpen,
      });
    } else {
      const ch = diffFields(oc.get(id), c, by3);
      if (ch.length) {
        updated.push({ id, title: c.title || '(无标题)', shop: shopName(c, by3), changes: ch });
      }
    }
  }
  for (const [id, c] of oc) {
    if (!nc.has(id)) removed.push({ id, title: c.title || '(无标题)', shop: shopName(c, by3) });
  }
  return { baseline: false, added, updated, removed };
}

/* ---------------- 统计（生成页面渲染所需数据） ---------------- */
function buildPayload(f) {
  const by3 = {};
  for (const s of f.shops) if (s.thirdShopId) by3[String(s.thirdShopId)] = s.shopName;

  const cnt = new Map();
  for (const c of f.cards) {
    const ids = new Set((c.spuShopIds || []).map(String));
    for (const sn of c.shopNames || []) {
      if (sn && typeof sn === 'object') {
        const v = sn.thirdShopId || sn.shopId || sn.id;
        if (v) ids.add(String(v));
      } else if (sn) ids.add(String(sn));
    }
    const hit = new Set();
    for (const i of ids) { const n = by3[i]; if (n) hit.add(n); }
    for (const n of hit) cnt.set(n, (cnt.get(n) || 0) + 1);
  }
  const platOf = {};
  for (const s of f.shops) platOf[s.shopName] = s.platform;
  const shopRows = [...cnt.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, n]) => ({ name, n, p: PLAT[platOf[name]] || '—' }));

  const noShop = f.cards.filter(c => !((c.spuShopIds || []).length || (c.shopNames || []).length)).length;

  const lab = new Map();
  for (const c of f.cards) for (const l of c.labels || []) lab.set(l, (lab.get(l) || 0) + 1);
  const labels = [...lab.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 14).map(([n, v]) => ({ n, v }));

  const mo = new Map();
  for (const c of f.cards) {
    if (!c.createdAt) continue;
    const k = String(c.createdAt).slice(0, 7);
    mo.set(k, (mo.get(k) || 0) + 1);
  }
  const monthly = [...mo.keys()].sort().map(k => ({ m: k.slice(2), v: mo.get(k) }));

  const atype = { SHOP: '店铺', PRODUCT: '商品', PRODUCT_GROUP: '商品组' };
  const agRows = f.agents.map(a => ({
    name: a.name || '(未命名)',
    t: atype[a.scope] || a.scope || '—',
    bind: Math.max(a.shopCount, a.productCount, a.groupCount),
    st: a.isRun ? 'run' : (a.draftsIsRun ? 'draft' : 'off'),
    pub: String(a.publishTime || '').slice(0, 10),
  }));
  const ord = { run: 0, draft: 1, off: 2 };
  agRows.sort((a, b) => ord[a.st] - ord[b.st] || b.bind - a.bind || a.name.localeCompare(b.name));

  return {
    total: f.cards.length,
    trusted: f.cards.filter(c => c.ifBelievable).length,
    untrusted: f.cards.filter(c => !c.ifBelievable).length,
    enabled: f.cards.filter(c => c.ifOpen).length,
    disabled: f.cards.filter(c => !c.ifOpen).length,
    chunks: f.cards.reduce((s, c) => s + (c.chunks || 0), 0),
    noShop,
    shopTotal: f.shops.length,
    shopCovered: shopRows.length,
    labels, monthly, shops: shopRows,
    agTotal: f.agents.length,
    agRun: f.agents.filter(a => a.isRun).length,
    agDraft: f.agents.filter(a => !a.isRun && a.draftsIsRun).length,
    agOff: f.agents.filter(a => !a.isRun && !a.draftsIsRun).length,
    agents: agRows,
  };
}

/* ---------------- 主流程 ---------------- */
(async () => {
  if (!COOKIE) die('缺少 TANYU_COOKIE（探域登录 cookie）');
  if (!ENDPOINT || !KEY) die('缺少 WB_ENDPOINT / WB_KEY（云库地址与密钥）');

  console.log('· 抓取探域知识库…');
  let f = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      f = await fetchAll();
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log('  第 ' + attempt + ' 次抓取失败：' + e.message + '；5 秒后整体重试一次');
      await sleep(5000);
    }
  }
  const now = new Date();
  const t = bj(now);
  console.log('  卡片=' + f.cards.length + ' 接口total=' + f.apiTotal + ' 页=' + f.pages +
    ' 店铺=' + f.shops.length + ' Agent=' + f.agents.length);

  const by3 = {};
  for (const s of f.shops) if (s.thirdShopId) by3[String(s.thirdShopId)] = s.shopName;

  console.log('· 读取云库上一份快照…');
  const prev = await cloudGet();
  const prevPayload = (prev && prev.payload) || {};
  const prevCards = (prev && Array.isArray(prev.cards)) ? prev.cards : [];
  const prevAt = prevPayload.fetchedAt || null;
  console.log('  上次 ' + (prevAt || '（无，本次作为基线）') + '，' + prevCards.length + ' 张卡');

  const ch = buildChanges(prevCards.length ? prevCards : null, f.cards, by3);
  const stat = buildPayload(f);

  const history = Array.isArray((prevPayload.changes || {}).history) ? prevPayload.changes.history.slice() : [];
  history.unshift({ at: t.full, a: ch.added.length, u: ch.updated.length, d: ch.removed.length });
  const hist = history.slice(0, KEEP_HISTORY);

  const payload = Object.assign({
    fetchedAt: t.full,
    atISO: now.toISOString(),
    nextAt: bj(new Date(now.getTime() + 3 * 3600 * 1000)).md + ' ' + bj(new Date(now.getTime() + 3 * 3600 * 1000)).hm,
    source: SOURCE,
  }, stat, {
    changes: {
      at: t.full,
      prevAt,
      baseline: ch.baseline,
      added: ch.added,
      updated: ch.updated,
      removed: ch.removed,
      history: hist,
    },
  });

  console.log('· 写入云库…');
  await cloudWrite({ id: SNAP_ID, payload, cards: f.cards, updated_at: now.toISOString() }, !!prev);

  console.log('');
  console.log('OK ' + t.full + ' | 卡片 ' + stat.total + ' | 新增 ' + ch.added.length +
    ' | 修改 ' + ch.updated.length + ' | 删除 ' + ch.removed.length);
  for (const a of ch.added.slice(0, 15)) console.log('  + ' + a.title + (a.shop ? ' · ' + a.shop : ''));
  for (const u of ch.updated.slice(0, 15)) console.log('  ~ ' + u.title + (u.shop ? ' · ' + u.shop : '') + ' | ' + u.changes.join('；'));
  for (const d of ch.removed.slice(0, 10)) console.log('  - ' + d.title);
  if (!ch.baseline && !ch.added.length && !ch.updated.length && !ch.removed.length) {
    console.log('  本时段无新增或修改');
  }
  console.log('下次预计 ' + payload.nextAt);
})().catch(e => {
  console.error('ERR: ' + (e && e.message ? e.message : e));
  if (/登录态|非 JSON|接口错误|抓取不完整/.test(String(e && e.message))) {
    console.error('提示：多为探域 cookie 过期，需要重新导出 TANYU_COOKIE 并更新仓库 Secret。');
  }
  process.exit(1);
});
