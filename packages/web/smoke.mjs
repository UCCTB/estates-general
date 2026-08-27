// 冒烟测试：把构建出来的 dist/sandbox.js 原样丢进一个假 window 里跑一遍。
//
// packages/server 的 test/sandbox-store.test.ts 已经证明「每次请求都过一遍 JSON」的
// 房间仓库能跑完整一局。那条测试证不到的是 sandbox.ts 自己——patch fetch、
// 替身 EventSource、localStorage 读写、跨 tab 广播这一层。没有浏览器就没法点，
// 所以这里用 node:vm 造一个够用的 window：真出了运行时错误，这里会炸。
//
// 用法：pnpm --filter @estates/web build && pnpm --filter @estates/web smoke
//       node smoke.mjs https://estates-general.vercel.app/sandbox.js   ← 冲线上那份跑
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://example.test';

// 默认测本地构建产物；给个 URL 就测线上那份——部署完拿它验一遍最踏实
const TARGET = process.argv[2] ?? join(HERE, 'dist', 'sandbox.js');

async function loadBundle() {
  if (!/^https?:\/\//.test(TARGET)) return readFile(TARGET, 'utf8');
  const r = await fetch(TARGET);
  if (!r.ok) throw new Error(`拉不到 ${TARGET}：HTTP ${r.status}`);
  return r.text();
}

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${extra === '' ? '' : ` — ${extra}`}`);
  }
}

// ── 假 window ─────────────────────────────────────────────────────────

function makeContext() {
  const stored = new Map();
  const localStorage = {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
    key: (i) => [...stored.keys()][i] ?? null,
    get length() { return stored.size; },
  };

  const ctx = {
    console,
    localStorage,
    crypto: globalThis.crypto,
    navigator: {},                       // 没有 locks：sandbox 会退化成不加锁，正是要测的分支
    location: { origin: ORIGIN, href: `${ORIGIN}/`, pathname: '/', hash: '' },
    alert: (m) => { throw new Error(`不该弹窗：${m}`); },
    setTimeout, clearTimeout, queueMicrotask, structuredClone,
    URL, URLSearchParams, Response, Request, Headers,
    EventTarget, MessageEvent, BroadcastChannel,
    TextEncoder, TextDecoder, atob, btoa, performance,
    fetch: () => { throw new Error('真 fetch 不该被调用：沙盒必须自己接管 /api/*'); },
    addEventListener: () => {},
    __stored: stored,
  };
  createContext(ctx);
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', ctx);
  return ctx;
}

// ── 跑 ────────────────────────────────────────────────────────────────

const ctx = makeContext();
const originalFetch = ctx.fetch;   // 上面那个「不该被调用」的桩，用来确认确实被换掉了
const bundle = await loadBundle();
console.log(`目标：${TARGET}（${bundle.length} 字）\n`);
runInContext(bundle, ctx, { filename: 'sandbox.js' });

check('bundle 跑完没抛异常，留下了 __ESTATES_SANDBOX__ 标记', ctx.__ESTATES_SANDBOX__ === true);
check('window.fetch 被接管了', ctx.fetch !== originalFetch);
check('window.EventSource 被接管了', typeof ctx.EventSource === 'function');

const api = async (path, body) => {
  const init = body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await ctx.fetch(`${ORIGIN}${path}`, init);
  return { status: r.status, body: await r.json() };
};

const tokenOf = (url) => decodeURIComponent(url.replace(/^\/(join|host)\//, ''));
const act = (token, action, extra = {}) =>
  api(`/api/act?t=${encodeURIComponent(token)}`, { action, ...extra });
const state = (token) => api(`/api/state?t=${encodeURIComponent(token)}`);

// 建局
const created = await api('/api/create', { seed: 'smoke' });
check('POST /api/create 建局成功', created.body.ok === true, JSON.stringify(created.body));
check('签发 12 条 magic link', created.body.links?.length === 12);
check('种子哈希承诺是 64 位十六进制', /^[0-9a-f]{64}$/.test(created.body.seedCommitment ?? ''));

const hostToken = tokenOf(created.body.hostUrl);
const seat = {};
for (const l of created.body.links) seat[l.seatId] = tokenOf(l.url);

// 房间真的落进 localStorage 了
const keys = [...ctx.__stored.keys()];
check('房间写进了 localStorage', keys.some((k) => k.startsWith('estates:room:')), keys.join(','));
check('serverSecret 也存了一份（跨 tab 才验得过令牌）', ctx.__stored.has('estates:secret'));

// 令牌
const s1 = await state(seat[1]);
check('座位 1 能拉到自己的状态', s1.body.ok === true && s1.body.seatId === 1);
check('阶段是 ROUND_START', s1.body.snapshot.phase === 'ROUND_START');
check('主持端拿得到全量事件', (await state(hostToken)).body.isHost === true);

const bad = await state(seat[1].slice(0, -3) + 'aaa');
check('改过签名的令牌被拒（401）', bad.status === 401 && bad.body.ok === false);

// 可见性：别人的锁定额不下发
const seats = s1.body.snapshot.seats;
check('12 个座位都在，且不含 lockedFunds', seats.length === 12 && seats.every((x) => !('lockedFunds' in x)));
check('玩家拿不到 HOST 事件', s1.body.snapshot.events.every((e) => e.visibility !== 'HOST'));

// EventSource 替身：建连推一次，房间变更再推一次
const seen = [];
const es = new ctx.EventSource(`/api/stream?t=${encodeURIComponent(seat[2])}`);
es.onmessage = (e) => seen.push(JSON.parse(e.data).v);
await new Promise((r) => setTimeout(r, 20));
check('EventSource 建连即推一次当前版本', seen.length >= 1, JSON.stringify(seen));

const before = seen.length;
check('主持端推进到 REVEAL_AND_INTEL', (await act(hostToken, 'advance')).body.ok === true);
await new Promise((r) => setTimeout(r, 20));
check('房间变更推了新版本号出来', seen.length > before, `${before} → ${seen.length}`);

// 走一段真流程
check('推进到 NEGOTIATION', (await act(hostToken, 'advance')).body.ok === true);
check('阶段确实是 NEGOTIATION', (await state(hostToken)).body.snapshot.phase === 'NEGOTIATION');

const conv = await act(seat[1], 'openConversation', { with: [2, 3] });
check('开一场谈话', conv.body.ok === true, JSON.stringify(conv.body));
const seenConv = (await state(seat[3])).body.meta.conversations;
check('别的座位看得到这场谈话（跨「tab」= 重新从 localStorage 还原）',
  seenConv.length === 1 && seenConv[0].participants.join() === '1,2,3');

const pledge = await act(seat[4], 'pledge', { funds: 5, ability: 5 });
check('危机承诺登记成功', pledge.body.ok === true, JSON.stringify(pledge.body));

check('玩家令牌推不动阶段', (await act(seat[5], 'advance')).body.ok === false);
check('未知动作被拒', (await act(seat[5], 'nonsense')).body.ok === false);

es.close();

console.log(failures === 0 ? '\n冒烟测试全通过' : `\n${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
