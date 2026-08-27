# estates-general · 三级会议

12 人 / 6 回合社会博弈游戏《三级会议》（产品名候选《十二等人》）的裁判引擎。

- 规则书：`docs/rulebook-v1.md`
- 技术设计：Outline › 法伦施泰尔国际 › 技术设计文档 › TDD-001
- 开发约定：`CLAUDE.md`

## 布局

```
packages/
  engine/   纯逻辑裁判引擎（无 I/O）
  sim/      纯文本模拟器，验证数值平衡
docs/
  rulebook-v1.md
```

## 快速开始

```bash
pnpm install
pnpm test
pnpm sim --seed demo
```
