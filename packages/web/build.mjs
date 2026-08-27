// 公开评审站的构建：把仓库里已有的东西摆出来，不另起一套。
//
//   packages/server/public/*.html  →  原样搬过来，只在 <head> 里插一行 sandbox.js
//   packages/server/src/router.ts  →  esbuild 打成浏览器包，跑在 patch 过的 fetch 上
//   packages/sim/src/run.ts        →  esbuild 打成浏览器包，/sim 页当场跑一局
//   docs/*.md, README.md, CLAUDE.md →  markdown 渲染成文档页
//
// 玩家端 / 主持端的 HTML 一个字都没改。改了的话，公开评审看到的就不是仓库里那份了。
import { build } from 'esbuild';
import { marked } from 'marked';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PUBLIC = join(ROOT, 'packages', 'server', 'public');
const DIST = join(HERE, 'dist');

const REPO = 'https://github.com/UCCTB/estates-general';

// ── 站点导航 ───────────────────────────────────────────────────────────

const NAV = [
  ['/', '首页'],
  ['/sim', '模拟器'],
  ['/play', '开一局'],
  ['/rulebook', '规则书'],
  ['/issues', '待裁定'],
  ['/conventions', '开发约定'],
];

function nav(current) {
  return NAV.map(([href, label]) => (href === current
    ? `<span class="nav-here">${label}</span>`
    : `<a href="${href}">${label}</a>`)).join('');
}

function shell({ title, current, wide = false, body, script = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="《三级会议》裁判引擎——12 人 / 6 回合社会博弈游戏的数字裁判。公开评审。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%E2%9A%96%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">《三级会议》<span>裁判引擎</span></a>
  <nav>${nav(current)}<a class="ext" href="${REPO}">GitHub ↗</a></nav>
</header>
<main class="${wide ? 'wide' : 'narrow'}">
${body}
</main>
<footer class="sitefoot">
  <p>《三级会议》裁判引擎 · 公开评审版 · <a href="${REPO}">UCCTB/estates-general</a></p>
  <p class="muted">这一站没有后端。开的局存在你自己的浏览器里，清掉站点数据就没了。</p>
</footer>
${script}
</body>
</html>
`;
}

// ── markdown 文档页 ────────────────────────────────────────────────────

function renderDoc(md) {
  const parsed = marked.parse(md, { async: false, gfm: true, breaks: false });
  // 规则书用 # 分章、## 分节，页面自己已经有一个 <h1> 标题了，所以整体降一级：
  // 一页仍然只有一个 h1，降完之后原来的「章」正好落在 h2 上，目录就列它们。
  const html = parsed.replace(
    /<(\/?)h([1-5])(\s[^>]*)?>/g,
    (_m, slash, level, attrs) => `<${slash}h${Number(level) + 1}${attrs ?? ''}>`,
  );
  const toc = [];
  let n = 0;
  const withIds = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    n += 1;
    const id = `h${n}`;
    const text = inner.replace(/<[^>]+>/g, '').trim();
    toc.push({ id, level: Number(level), text });
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}">#</a></h${level}>`;
  });
  // 规则书里有几张很宽的数值表：套一层容器让它自己横向滚，别把整页撑破
  const wrapped = withIds.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="tablewrap"><table>$1</table></div>');
  return { html: wrapped, toc };
}

function tocHtml(toc) {
  if (toc.length < 4) return '';
  const items = toc
    .filter((t) => t.level === 2)
    .map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`)
    .join('');
  if (items === '') return '';
  return `<details class="toc" open><summary>目录</summary><ul>${items}</ul></details>`;
}

async function docPage({ src, out, title, current, lead }) {
  const md = await readFile(join(ROOT, src), 'utf8');
  const { html, toc } = renderDoc(md);
  const body = `<article class="doc">
  <p class="crumb"><a href="/">← 回评审首页</a> · 源文件 <a class="mono" href="${REPO}/blob/main/${src}">${src}</a></p>
  <h1>${title}</h1>
  ${lead === undefined ? '' : `<p class="lead">${lead}</p>`}
  ${tocHtml(toc)}
  ${html}
</article>`;
  await writeFile(join(DIST, out), shell({ title: `${title} · 三级会议`, current, body }));
}

// ── 把 server/public 的三个页面搬过来，插一行 sandbox.js ────────────────

const BANNER = `<div class="sandbox-banner">沙盒模式 · 整个服务端跑在这个浏览器里，房间存在 localStorage。同一台机器、同一个浏览器的多个 tab 才能同桌。<a href="/">评审说明</a></div>`;

async function sandboxPage(srcName, outName) {
  let html = await readFile(join(PUBLIC, srcName), 'utf8');
  html = html.replace('</head>', '<link rel="stylesheet" href="/sandbox.css">\n<script src="/sandbox.js"></script>\n</head>');
  html = html.replace('<div class="wrap">', `<div class="wrap">\n${BANNER}`);
  await writeFile(join(DIST, outName), html);
}

// ── 首页 ───────────────────────────────────────────────────────────────

const PHASES = [
  ['1', '引擎核心', '模型 / 校验 / settle / roundStart / RNG / 事件', '完成'],
  ['2', '契约引擎', '公证 / 备忘 / 失信 / 情报转述', '完成'],
  ['4', '终局与成就', '自动档 + 提名档 + 三层结局', '完成'],
  ['3', 'Game Server', '座位令牌 + 玩家端 / 主持端', '完成'],
  ['—', '真人试玩', '≥ 3 局，回答规则书 §27 的检验问题 1–9', '进行中'],
];

function indexPage({ tests, issues }) {
  const phaseRows = PHASES.map(([n, name, detail, status]) => `<tr>
      <td class="mono">${n}</td><td>${name}</td><td class="muted">${detail}</td>
      <td><span class="tag ${status === '完成' ? 'done' : 'wip'}">${status}</span></td>
    </tr>`).join('');

  return shell({
    title: '《三级会议》裁判引擎 · 公开评审',
    current: '/',
    wide: true,
    body: `
<section class="hero">
  <p class="kicker">公开评审 · Public Review</p>
  <h1>《三级会议》裁判引擎</h1>
  <p class="thesis">12 人 / 6 回合的社会博弈游戏，先做裁判，不做「游戏」。<br>
  引擎不知道网络、文件、时间的存在，也不读一个字的谈话内容——它只负责结算、契约、履历、终局。</p>
  <div class="cta">
    <a class="btn primary" href="/sim">跑一局给我看 →</a>
    <a class="btn" href="/play">自己开一局</a>
    <a class="btn" href="/rulebook">读规则书</a>
  </div>
  <p class="muted small">${tests} 个测试通过 · 待裁定 ${issues} 条 · 阶段 1–4 已完成，下一步是真人试玩</p>
</section>

<section class="cols3">
  <div class="panel">
    <h2>要评审什么</h2>
    <p>不是「好不好玩」——那要真人试玩才知道。这里能评审的是<b>裁判是否可信</b>：</p>
    <ul>
      <li>同一个种子重放，是不是逐字节相同</li>
      <li>掷骰与抽签是不是事后可复核</li>
      <li>玩家看到的，是不是只有他在桌上本来就看得到的</li>
      <li>失信的代价是不是真的落在履历上</li>
    </ul>
  </div>
  <div class="panel">
    <h2>三条路</h2>
    <ol>
      <li><a href="/sim">模拟器</a>——12 个脚本化策略跑完 6 回合，打印结算全过程、三层结局与成就。同种子连跑两次会当场比对。</li>
      <li><a href="/play">开一局</a>——签 12 张座位令牌，在这个浏览器里跑真正的玩家端与主持端。</li>
      <li><a href="/rulebook">规则书</a>与<a href="/issues">待裁定清单</a>——所有数值的来源，以及实现时撞出来的 23 条歧义。</li>
    </ol>
  </div>
  <div class="panel">
    <h2>不可协商的约束</h2>
    <ol class="tight">
      <li><code>packages/engine</code> 无 I/O：不 import 网络、文件、时钟、<code>Math.random</code>。</li>
      <li><code>settle()</code> 与 <code>roundStart()</code> 是纯函数，同输入必同输出。</li>
      <li>一切状态变化以 append-only 事件表达。</li>
      <li>契约触发条件是封闭枚举；要加条件先改 TDD。</li>
      <li>引擎不读取任何谈话内容，只消费「谁与谁在谈」。</li>
      <li>不允许负余额；失信短缺不结转。</li>
    </ol>
  </div>
</section>

<section class="panel">
  <h2>进度</h2>
  <table class="phases">
    <tr><th>阶段</th><th>内容</th><th>范围</th><th>状态</th></tr>
    ${phaseRows}
  </table>
  <p class="muted small">阈值（<code>data/achievement-meta.ts</code> 的 <code>THRESHOLDS</code>）与 §4.3 的结局回退都等着真实试玩数据来定。
  在那之前不加机制。</p>
</section>

<section class="cols2">
  <div class="panel">
    <h2>沙盒是怎么回事</h2>
    <p>这一站是纯静态的，没有服务器进程。<code>/play</code> 里的一切——建局、签令牌、验签、结算、
    可见性裁剪——都跑在你的浏览器里：</p>
    <table class="kv">
      <tr><th>真服务端</th><th>这里</th></tr>
      <tr><td><code>node:http</code></td><td>patch 过的 <code>window.fetch</code></td></tr>
      <tr><td>SSE 长连接</td><td><code>BroadcastChannel</code></td></tr>
      <tr><td>JSON 文件存档</td><td><code>localStorage</code></td></tr>
    </table>
    <p class="muted small">路由表、令牌校验、可见性规则、动作白名单都不是重写的——沙盒 import 的就是
    <code>packages/server</code> 里那份 <code>createRouter</code>。所以：<b>换台机器打开同一条链接会显示「令牌无效」</b>
    （密钥和存档都在本机），<b>清掉站点数据 = 掀桌</b>。要 12 个人真的同桌，
    <a href="${REPO}#跑一局真人的">在本地跑 <code>pnpm serve</code></a>。</p>
  </div>
  <div class="panel">
    <h2>本地跑</h2>
<pre class="code">git clone ${REPO}.git
cd estates-general
pnpm install
pnpm test          <span class="c"># ${tests} 个测试</span>
pnpm typecheck
pnpm sim --seed demo
pnpm serve         <span class="c"># http://localhost:8787</span></pre>
    <p class="muted small">Node ≥ 20、pnpm。<code>pnpm serve</code> 起的是真服务端：12 条 magic link 私发出去，
    每人一条，一人一个浏览器，主持端逐阶段推进。令牌绑座位不绑人，6 小时失效。</p>
  </div>
</section>

<section class="panel">
  <h2>怎么提意见</h2>
  <p>规格的权威来源是 Outline 上的 TDD-001 / TDD-002，不在这个仓库里（避免双源）。
  实现时撞见的歧义记在 <a href="/issues">待裁定清单</a>，等人工裁定后再改 TDD——不在代码里绕过去。</p>
  <p>评审意见请开 <a href="${REPO}/issues">GitHub Issue</a>。涉及数值的（身份卡、项目卡、加成、风险、危机表）
  请对着<a href="/rulebook">规则书 V1.0.1</a>说——引擎不改数值。</p>
</section>
`,
  });
}

// ── 模拟器页 ───────────────────────────────────────────────────────────

function simPage() {
  return shell({
    title: '模拟器 · 三级会议裁判引擎',
    current: '/sim',
    wide: true,
    body: `
<article class="doc">
  <h1>模拟器</h1>
  <p class="lead">12 个脚本化策略跑完 6 回合：发牌、情报、谈判、契约、秘密提交、统一结算，
  一直到终局的三层结局与成就。跑的是 <code>pnpm sim</code> 的同一个 <code>runGame(seed)</code>——
  纯函数，不含时间戳，不用 <code>Math.random</code>。</p>

  <div class="panel simbar">
    <label for="seed">随机种子</label>
    <input type="text" id="seed" value="demo" spellcheck="false">
    <button class="btn primary" id="go">跑一局</button>
    <button class="btn" id="again">同种子连跑两次并比对</button>
  </div>
  <p class="stamp muted small" id="stamp"></p>
  <pre class="simout" id="out">跑一局中……</pre>
  <p class="muted small">种子决定发牌与全部掷骰。开局公开它的哈希承诺，终局公开种子本身——
  每一次抽签事后都能自己复核。这一页整局都在你的浏览器里算，没有请求发出去。</p>
</article>
`,
    script: '<script src="/sim.js"></script>',
  });
}

// ── 走一遍 ─────────────────────────────────────────────────────────────

async function countTests() {
  // 数一下 test/*.test.ts 里的 it(...)，首页那句「N 个测试通过」不写死
  let n = 0;
  for (const pkg of ['engine', 'sim', 'server']) {
    const dir = join(ROOT, 'packages', pkg, 'test');
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.test.ts')) continue;
      const src = await readFile(join(dir, f), 'utf8');
      n += (src.match(/^\s*it\(/gm) ?? []).length;
    }
  }
  return n;
}

async function countIssues() {
  // 待裁定清单是一张 markdown 表，每条一行：| 12 | 2026-08-27 | §4.3 | ... |
  const md = await readFile(join(ROOT, 'docs', 'tdd-001-issues.md'), 'utf8');
  return (md.match(/^\|\s*\d+\s*\|/gm) ?? []).length;
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await build({
    entryPoints: [join(HERE, 'src', 'sandbox.ts')],
    outfile: join(DIST, 'sandbox.js'),
    bundle: true, format: 'iife', target: 'es2022', minify: true, sourcemap: true,
    logLevel: 'info',
  });

  await build({
    entryPoints: [join(HERE, 'src', 'sim.ts')],
    outfile: join(DIST, 'sim.js'),
    bundle: true, format: 'iife', target: 'es2022', minify: true, sourcemap: true,
    logLevel: 'info',
  });

  await cp(join(PUBLIC, 'app.css'), join(DIST, 'app.css'));
  await cp(join(HERE, 'assets', 'site.css'), join(DIST, 'site.css'));
  await cp(join(HERE, 'assets', 'sandbox.css'), join(DIST, 'sandbox.css'));

  await sandboxPage('index.html', 'play.html');
  await sandboxPage('player.html', 'player.html');
  await sandboxPage('host.html', 'host.html');

  const [tests, issues] = await Promise.all([countTests(), countIssues()]);
  await writeFile(join(DIST, 'index.html'), await indexPage({ tests, issues }));
  await writeFile(join(DIST, 'sim.html'), simPage());

  await docPage({
    src: 'docs/rulebook-v1.md', out: 'rulebook.html', title: '规则书 V1.0.1', current: '/rulebook',
    lead: '所有数值的来源：身份卡、项目卡、加成、风险、危机表，以及成就与结局的文字。引擎不改数值。',
  });
  await docPage({
    src: 'docs/tdd-001-issues.md', out: 'issues.html', title: '待裁定问题', current: '/issues',
    lead: '实现 TDD-001 / TDD-002 时撞出来的歧义与实现选择。不在代码里绕过去，记在这里等裁定。',
  });
  await docPage({
    src: 'CLAUDE.md', out: 'conventions.html', title: '开发约定', current: '/conventions',
    lead: '架构约束、技术栈、工作顺序、代码约定。仓库根目录的 CLAUDE.md 原文。',
  });
  await docPage({ src: 'README.md', out: 'readme.html', title: 'README', current: '' });
  await docPage({ src: 'KICKOFF.md', out: 'kickoff.html', title: '立项', current: '' });
  await docPage({ src: 'docs/art-assets.md', out: 'art.html', title: '美术资产', current: '' });

  console.log(`\n构建完成 → ${DIST}（${tests} 个测试，${issues} 条待裁定）`);
}

await main();
