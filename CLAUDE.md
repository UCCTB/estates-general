# estates-general

《三级会议》裁判引擎。12 人 / 6 回合社会博弈游戏的数字版——先做裁判，不做"游戏"。

## 权威文档（先读，再写代码）

规格的唯一权威来源在 Outline（wiki.un-canon.com，你有 MCP 访问权），collection **法伦施泰尔国际**：

| 文档 | 用途 |
|---|---|
| `技术设计文档 › TDD-001：三级会议 裁判引擎` | **实施规格。字段命名、枚举、结算顺序、状态机以它为准。** URL: https://wiki.un-canon.com/doc/tdd-001-WySllJgZi7 |
| `docs/rulebook-v1.md`（本仓库） | 规则书 V1.0。所有数值（身份卡、项目卡、加成、风险、危机表）的来源。引擎不改数值。 |

开工前：用 Outline MCP 拉取 TDD-001 全文读一遍。本仓库不镜像 TDD（避免双源）；如需离线副本，放 `docs/tdd-001-snapshot.md` 并在文件头注明快照日期，冲突时以 Outline 为准。

TDD-001 与规则书冲突时，以 TDD-001 为准（差异清单见 TDD-001 附录 B）。

## 架构约束（不可协商）

1. `packages/engine` 是**无 I/O 的纯逻辑包**。不 import 任何网络、文件、时钟、`Math.random`。所有随机数经 seeded RNG（TDD-001 §6.5）。
2. `settle(state, submissions, seed) → { state, events }` 与 `roundStart(state) → { state, events }` 是纯函数。同输入必同输出。
3. 所有状态变化以 append-only 事件表达（TDD-001 §8.1）。不允许绕过事件直接改 state 给外部看。
4. 契约触发条件是**封闭枚举**（TDD-001 §5.2）。不要"顺手"加条件；要加就先改 TDD。
5. 引擎不读取任何谈话内容。谈话只以 `ConversationEdge` 元数据进入。
6. 不允许负余额；失信短缺不结转（TDD-001 §5.5 / NG2）。

## 技术栈

- TypeScript（strict），Node ≥ 20，pnpm workspace
- 测试：vitest；性质测试用 fast-check
- 包布局：
  - `packages/engine` — 领域模型、校验、结算、契约、RNG、事件、成就查询
  - `packages/sim` — 纯文本模拟器：12 个脚本化策略跑 6 回合，输出规则书 §26 观察指标。只依赖 engine。
  - `packages/server` / `packages/client` — 阶段 3 再建，现在不要建。

## 工作顺序（对应 TDD-001 §14）

阶段 1 → 阶段 2 → 阶段 4 的自动档成就 → 阶段 3。**先让模拟器跑通 6 回合，再做任何网络或 UI。**

阶段 1 的 Done 标准：`pnpm sim` 能在固定 seed 下跑完一局并打印观察指标；资金守恒等性质测试通过；同 seed 重跑输出逐字节相同。

## 代码约定

- 领域类型的字段命名以 TDD-001 §4 为准，不要自行改名（`funds` 不叫 `money`，`SeatId` 不叫 `playerId`）。
- 规则书数值放 `packages/engine/src/data/`，一个文件一张表，附规则书章节号注释。
- 每个结算步骤一个函数，函数名带步骤号（如 `step3Commerce`），便于对照 TDD-001 §6.2。
- 事件类型名与 TDD-001 §8.1 完全一致。
- 注释、commit message 中文；标识符英文。

## 待验证项

TDD-001 附录 C 列了 5 条设计推断。实现时遇到其中任何一条，用 `// TODO(TDD-001 C.n)` 标记，不要自行拍板。

## 文档回写

实现过程中发现 TDD-001 有歧义或错误：不要在代码里绕过。在 Outline 上给 TDD-001 加评论，或在 `docs/tdd-001-issues.md` 记一条，等人工裁定后再修 TDD。
