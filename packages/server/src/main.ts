// Game Server 入口。
// 用法：pnpm serve            （默认 :8787，随机 serverSecret）
//       PORT=9000 ESTATES_SECRET=xxx pnpm serve
//
// serverSecret 只用来签座位令牌（TDD-001 §7.1）。不设的话每次启动都随机生成——
// 重启即作废全部旧链接，这对本地试玩正好，也免得把密钥写进仓库。
import { randomBytes } from 'node:crypto';
import { startServer } from './http.js';
import { installFsStore } from './fsStore.js';

const port = Number(process.env['PORT'] ?? 8787);
const secret = process.env['ESTATES_SECRET'] ?? randomBytes(32).toString('hex');

installFsStore();
startServer(secret, port);

console.log(`《三级会议》Game Server 已启动：http://localhost:${port}`);
console.log('  主持端：打开上面的地址 → 建局 → 把 11 条 magic link 私发给其他玩家');
console.log(process.env['ESTATES_SECRET'] === undefined
  ? '  （本次使用随机 serverSecret，重启后旧链接全部失效；要持久请设 ESTATES_SECRET）'
  : '  （使用 ESTATES_SECRET 环境变量签发令牌）');
