// 纯文本模拟器入口：12 个脚本化策略跑 6 回合，输出规则书 §26 观察指标。
// 用法：pnpm sim --seed <string>
import { runGame } from './run.js';

const args = process.argv.slice(2);
const i = args.indexOf('--seed');
const seed = i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : 'demo';

console.log(runGame(seed));
