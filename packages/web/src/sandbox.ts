// 浏览器沙盒：把 Game Server 整个搬进一个 tab 里。
//
// 公开评审版没有后端。这里做的事只有一件——给 packages/server 的 router 换一副传输：
//
//   真服务端            沙盒
//   ─────────────────  ─────────────────────────────
//   node:http           patch 过的 window.fetch
//   SSE 长连接          BroadcastChannel + storage 事件
//   JSON 文件存档       localStorage（每次请求读回、写回）
//   进程内 Map          没有；房间对象每次请求现建现弃
//
// 路由表、令牌校验、可见性裁剪、动作白名单一行都没有重写：沙盒 import 的就是
// server 包里那份 createRouter。抄一遍就会漂移，漂移了「沙盒里跑通的一局」就不算数。
//
// 三个已知的与真服务端的差别，写在这里，也写在评审首页上：
//   1. 一切都在这台浏览器里。换个浏览器、换台机器打开同一条链接，看到的是「令牌无效」——
//      因为 serverSecret 与房间存档都在本机 localStorage 里。
//   2. 房间对象不常驻，所以 Room 自带的 setTimeout 关掉了（setRoomTimers(false)），
//      倒计时到点后的自动推进由主持端那个 tab 负责发起。
//   3. 清掉站点数据 = 掀桌。
import {
  Room, createRouter, setRoomStore, setRoomTimers,
  type RoomData, type RoomStore, type RouterRequest,
} from '@estates/server';

const ROOM_PREFIX = 'estates:room:';
const SECRET_KEY = 'estates:secret';
const CHANNEL = 'estates:bump';

// ── serverSecret：本机一份，所有 tab 共用，否则跨 tab 的令牌验不过 ──────────

function loadSecret(): string {
  let s = localStorage.getItem(SECRET_KEY);
  if (s === null) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    s = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(SECRET_KEY, s);
  }
  return s;
}

const secret = loadSecret();

// ── 版本号广播：替代 SSE ────────────────────────────────────────────────

type Bump = { gameId: string; v: number };

const localListeners = new Set<(b: Bump) => void>();
const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

function announce(b: Bump): void {
  for (const fn of [...localListeners]) fn(b);
  channel?.postMessage(b);
}

channel?.addEventListener('message', (e: MessageEvent) => {
  for (const fn of [...localListeners]) fn(e.data as Bump);
});

// 没有 BroadcastChannel 的浏览器退回 storage 事件（只在别的 tab 触发，够用）
window.addEventListener('storage', (e) => {
  if (e.key === null || !e.key.startsWith(ROOM_PREFIX) || e.newValue === null) return;
  const gameId = e.key.slice(ROOM_PREFIX.length);
  try {
    const v = (JSON.parse(e.newValue) as RoomData).version;
    for (const fn of [...localListeners]) fn({ gameId, v });
  } catch { /* 存档损坏就当没收到 */ }
});

// ── 房间仓库：localStorage ─────────────────────────────────────────────

function readRoom(gameId: string): RoomData | null {
  const raw = localStorage.getItem(ROOM_PREFIX + gameId);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RoomData;
  } catch {
    return null;
  }
}

const browserStore: RoomStore = {
  // 每次请求都从 localStorage 重新还原：别的 tab 刚写进去的状态立刻可见
  get(gameId, sec) {
    const d = readRoom(gameId);
    return d === null ? undefined : Room.restore(d, sec);
  },
  put(room) {
    try {
      localStorage.setItem(ROOM_PREFIX + room.gameId, JSON.stringify(room.toJSON()));
    } catch {
      // 配额满了。一局大概几百 KB，真撞上多半是攒了很多局——提示后清掉旧的
      alert('浏览器存储写满了。清掉站点数据可以重来（会丢掉所有本地的局）。');
      return;
    }
    announce({ gameId: room.gameId, v: room.version });
  },
  list() {
    const out: Room[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k === null || !k.startsWith(ROOM_PREFIX)) continue;
      const d = readRoom(k.slice(ROOM_PREFIX.length));
      if (d !== null) out.push(Room.restore(d, secret));
    }
    return out;
  },
};

setRoomStore(browserStore);
setRoomTimers(false);   // 见文件头 2

const route = createRouter(secret);

// ── 跨 tab 互斥 ────────────────────────────────────────────────────────
//
// 一次请求 = 读回房间 → 跑 router → 写回房间。12 个 tab 同时收到版本号广播、同时
// 回来拉状态时，这三步必须整体串行，否则后写的会把先写的盖掉（最难看的一种：两个
// tab 轮流把对方的 connected 标志刷掉，互相触发广播，停不下来）。
// Web Locks 是跨 tab 的，正好。拿不到就退化成不加锁——单 tab 评审无所谓。
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return fn();
  return navigator.locks.request(`estates:${key}`, fn) as Promise<T>;
}

// ── fetch 替身 ─────────────────────────────────────────────────────────

const realFetch = window.fetch.bind(window);

/** 主持端令牌：见文件头 2，倒计时到点后由主持端 tab 自己发起推进。 */
let hostToken: string | null = null;
let hostTimer: number | null = null;

function scheduleAdvance(seconds: number): void {
  if (hostTimer !== null) { clearTimeout(hostTimer); hostTimer = null; }
  if (seconds <= 0 || hostToken === null) return;
  const t = hostToken;
  hostTimer = window.setTimeout(() => {
    hostTimer = null;
    void call('/api/act', 'POST', { t }, { action: 'advance' });
  }, seconds * 1000);
}

async function call(
  path: string,
  method: string,
  query: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ code: number; body: unknown }> {
  const q = new URLSearchParams(query);
  const gameId = gameIdOf(q.get('t')) ?? 'new';

  return withLock(gameId, async () => {
    const req: RouterRequest = {
      method,
      path,
      query: q,
      body: () => Promise.resolve(body),
    };
    const out = await route(req);
    if (out.kind === 'json') return { code: out.code, body: out.body };
    if (out.kind === 'stream') return { code: 200, body: { ok: true, v: out.room.version } };
    // 静态文件在沙盒里由 Vercel 直接发，router 不该走到这里
    return { code: 404, body: { ok: false, reason: '沙盒不服务静态文件' } };
  });
}

/** 从令牌里读出 gameId——只为选锁，不做任何信任判断（签名照样由 router 验）。 */
function gameIdOf(token: string | null): string | null {
  if (token === null) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const bin = atob(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(bin) as { gameId?: unknown };
    return typeof p.gameId === 'string' ? p.gameId : null;
  } catch {
    return null;
  }
}

window.fetch = async function sandboxFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
    return realFetch(input as RequestInfo, init);
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string' && init.body !== '') {
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = {}; }
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const out = await call(url.pathname, method, query, body);

  // 主持端设了倒计时：真服务端到点自动推进，这里由主持端 tab 代劳
  if (url.pathname === '/api/act' && body['action'] === 'timer' && query['t'] !== undefined) {
    hostToken = query['t'];
    scheduleAdvance(Number(body['seconds'] ?? 0));
  }

  return new Response(JSON.stringify(out.body), {
    status: out.code,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

// ── EventSource 替身 ───────────────────────────────────────────────────
//
// 真服务端只推一个版本号，客户端收到后回来拉自己那一份裁剪过的状态。沙盒照办：
// 广播里带的也只有 { gameId, v }。可见性规则还是只在 visibility.ts 跑一遍。

class SandboxEventSource extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  readonly url: string;
  readyState = 1;

  private off: () => void;

  constructor(url: string) {
    super();
    this.url = url;
    const gameId = gameIdOf(new URL(url, location.origin).searchParams.get('t'));

    const fire = (v: number): void => {
      const e = new MessageEvent('message', { data: JSON.stringify({ v }) });
      this.onmessage?.(e);
      this.dispatchEvent(e);
    };

    const listener = (b: Bump): void => { if (b.gameId === gameId) fire(b.v); };
    localListeners.add(listener);
    this.off = () => localListeners.delete(listener);

    // 建连即推一次当前版本，和真服务端一致
    queueMicrotask(() => {
      const d = gameId === null ? null : readRoom(gameId);
      fire(d?.version ?? 0);
    });
  }

  close(): void {
    this.readyState = 2;
    this.off();
  }
}

(window as unknown as { EventSource: unknown }).EventSource = SandboxEventSource;

// 给页面留一个标记，评审首页与玩家端可以据此显示「沙盒模式」的提示
(window as unknown as { __ESTATES_SANDBOX__: boolean }).__ESTATES_SANDBOX__ = true;
