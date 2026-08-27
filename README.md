# estates-general · 三级会议

12 人 / 6 回合社会博弈游戏《三级会议》（产品名候选《十二等人》）的裁判引擎。

- 规则书：`docs/rulebook-v1.md`（V1.0.1）
- 技术设计：Outline › 法伦施泰尔国际 › 技术设计文档
  - TDD-001 裁判引擎（契约系统、结算顺序、座位令牌）
  - TDD-002 终局叙事与成就查询
- 待裁定问题：`docs/tdd-001-issues.md`
- 开发约定：`CLAUDE.md`

## 布局

```
packages/
  engine/   纯逻辑裁判引擎（无 I/O、无 Math.random、无时钟）
  sim/      纯文本模拟器：12 个脚本化策略跑 6 回合，输出观察指标
  server/   Game Server + 座位令牌 + 玩家端 / 主持端（零运行时依赖）
  web/      公开评审站：把 server 的 router 搬进浏览器跑，纯静态部署
docs/
  rulebook-v1.md
  tdd-001-issues.md
```

引擎不知道网络、文件、时间的存在；一切副作用都在 `server` 里。这不是洁癖——
`settle()` 必须是纯函数，才谈得上「同一个种子重放出逐字节相同的一局」。

## 快速开始

```bash
pnpm install
pnpm test          # 引擎 + 模拟器 + 服务端，共 139 个测试
pnpm typecheck
pnpm sim --seed demo   # 跑一整局，打印结算过程、三层结局与已解锁成就
```

## 跑一局真人的

```bash
pnpm serve         # 默认 http://localhost:8787
```

打开首页 → 建局 → 拿到 12 条 magic link。牵头玩家自己占座位 1，其余 11 条**私发**
出去（一人一条，别贴公共频道）。每个人在自己的浏览器 tab 里打开自己那条，
主持端按「推进」逐阶段走：

```
回合开始 → 项目公布与情报 → 自由磋商 → 秘密提交 → 统一结算 → …× 6 → 终局投票
```

- 谈判本身在系统之外——用你们自己的语音或文字房间。引擎只消费「谁与谁在谈」这一条元数据。
- 令牌绑定座位、不绑定人，6 小时后失效。掉线了就在主持端点「重发」，新链接继承座位全部状态。
- 开局公开种子的哈希承诺，终局公开种子本身：每一次掷骰与抽签，事后都能自己复核。

环境变量：`PORT`（默认 8787）、`ESTATES_SECRET`（签令牌用；不设则每次启动随机生成，
重启即作废全部旧链接）、`ESTATES_DATA_DIR`（房间存档目录，默认 `data/`，不入库）。

存档是房间的全量快照，所以设了固定的 `ESTATES_SECRET` 之后，服务端重启、旧链接照样打得开。

## 公开评审站

`packages/web` 把 Game Server 的 router 原样搬进浏览器：`node:http` 换成 patch 过的
`window.fetch`，SSE 换成 `BroadcastChannel`，JSON 存档换成 `localStorage`。
路由表、令牌校验、可见性裁剪、动作白名单一行都没有重写——沙盒 import 的就是
`packages/server` 里那份 `createRouter`。玩家端 / 主持端的 HTML 也是原件，构建时只在
`<head>` 里插了一行 `sandbox.js`。

```bash
pnpm build                          # → packages/web/dist（纯静态）
pnpm --filter @estates/web smoke     # 把构建产物丢进假 window 跑一遍
```

跟真服务端的三条差别：链接只在**签发它的那台浏览器**里有效（密钥和存档都在本机
localStorage）；房间对象每次请求现建现弃，所以倒计时到点后的自动推进由主持端那个 tab
发起；清掉站点数据 = 掀桌。要 12 个人真的同桌，还是 `pnpm serve`。
