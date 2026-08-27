# 给 Claude Code 的开工指令

> 把下面「---」之间的内容整段粘进 Claude Code 的第一条消息。本文件本身不需要提交进仓库，用完可删。

---

这是 estates-general 仓库的首个开发会话。先读 `CLAUDE.md`，然后通过 Outline MCP 拉取 collection「法伦施泰尔国际」下的 `TDD-001：三级会议 裁判引擎` 全文（https://wiki.un-canon.com/doc/tdd-001-WySllJgZi7），再读 `docs/rulebook-v1.md`。三份都读完再动手。

本次会话目标 = TDD-001 §14 **阶段 1**：

1. `pnpm install` 跑通。
2. `packages/engine/src/types.ts`：按 TDD-001 §4 逐字建立领域类型，字段名不改。
3. `packages/engine/src/data/`：把规则书 §4、§11.3、§12、§13.1、§14.2、§15.2 六张表录成常量，每个文件头注明规则书章节。
4. `packages/engine/src/rng.ts`：TDD-001 §6.5 的 HMAC-SHA256 派生 RNG，含 `seedCommitment`。
5. `packages/engine/src/validate.ts`：TDD-001 §10.1 提交校验。
6. `packages/engine/src/settle.ts`：TDD-001 §6.2 的 11 步流水线，每步一个函数 `stepN…`；**本阶段步骤 8（公证契约）留空桩**，阶段 2 再做。
7. `packages/engine/src/roundStart.ts`：TDD-001 §6.4，步骤 b 同样留桩。
8. `packages/engine/test/`：性质测试（资金守恒、ability 上限、每人每回合 stamp ≤ 1）+ 同 seed 重放一致性。
9. `packages/sim`：12 个最简脚本策略（例如"农民全投工程""商人全投商业""国王只打战争"），跑完 6 回合，打印规则书 §26 中可数值化的指标。

Done 标准：`pnpm test` 全绿；`pnpm sim --seed demo` 跑完 6 回合；连跑两次输出完全一致。

规则：遇到 TDD-001 附录 C 的 5 个待验证项，打 `// TODO(TDD-001 C.n)` 标记，选一个最保守的实现，不要拍板。发现 TDD 有歧义，写进 `docs/tdd-001-issues.md`，继续做别的，不要自行解释规格。完成后给我一份简短汇报：做了什么、issues 里记了什么、下一阶段需要我先裁定什么。

---
