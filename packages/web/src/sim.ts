// 评审页里的模拟器：12 个脚本化策略跑 6 回合，输出规则书 §26 的观察指标。
// 跑的是 pnpm sim 的同一个 runGame(seed)——纯函数，同 seed 逐字节相同。
// 这一页存在的理由就是让人当场验证这句话：同一个种子跑两次，摘要哈希一样。
import { runGame } from '@estates/sim';
import { sha256Hex } from '@estates/engine';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function run(seed: string): void {
  const out = $('out') as HTMLPreElement;
  const stamp = $('stamp');
  out.textContent = '跑一局中……';
  stamp.textContent = '';

  // 让浏览器先把「跑一局中」画出来，再干活（runGame 是同步的，几百毫秒）
  setTimeout(() => {
    const t0 = performance.now();
    let text: string;
    try {
      text = runGame(seed);
    } catch (e) {
      out.textContent = `跑挂了：${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const ms = Math.round(performance.now() - t0);
    out.textContent = text;
    stamp.innerHTML =
      `种子 <span class="mono">${escapeHtml(seed)}</span>　·　`
      + `${ms} ms　·　输出 ${text.length} 字　·　`
      + `SHA-256 <span class="mono">${sha256Hex(text).slice(0, 16)}…</span>`;
    location.hash = `seed=${encodeURIComponent(seed)}`;
  }, 16);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const seedInput = $('seed') as HTMLInputElement;

$('go').onclick = () => run(seedInput.value.trim() === '' ? 'demo' : seedInput.value.trim());
seedInput.onkeydown = (e) => { if ((e as KeyboardEvent).key === 'Enter') $('go').click(); };

$('again').onclick = () => {
  // 同一个种子再跑一次，把两次输出逐字节比一遍——确定性不是嘴上说说
  const seed = seedInput.value.trim() === '' ? 'demo' : seedInput.value.trim();
  const a = runGame(seed);
  const b = runGame(seed);
  const same = a === b;
  $('stamp').innerHTML = same
    ? `<span class="ok">同一种子连跑两次，${a.length} 字逐字节相同（SHA-256 <span class="mono">${sha256Hex(a).slice(0, 16)}…</span>）</span>`
    : '<span class="err">两次输出不一致——引擎有不确定性，这是 bug</span>';
};

const fromHash = /seed=([^&]*)/.exec(location.hash);
if (fromHash !== null) seedInput.value = decodeURIComponent(fromHash[1]!);
run(seedInput.value.trim() === '' ? 'demo' : seedInput.value.trim());
