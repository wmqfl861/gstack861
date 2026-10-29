# 批次 30 计划：DSH 键控消费 freeze + cso（§一5 安全组收尾）（2026-10-29）

## 目标

以批次 29 的 `dsh-keyed-consumption.mjs` 为模板，消费安全组剩余二技能（**freeze**、**cso**），2 计费上限 3。完成后 §一5 安全组（careful/freeze/cso）全部能力切片消费完毕。

## 设计：参数化复用（最小改动）

批次 29 的脚本硬编码 `CONSUMED_SKILLS`（careful + design-review）。本批改为 **`--skills a,b` 参数化**（缺省仍为批次 29 二技能，保持向后兼容），消费列表以 CLI 参数传入 freeze,cso。改动点：

1. `CONSUMED_SKILLS` → `DEFAULT_CONSUMED_SKILLS`（不变值）；main() 解析 `--skills`（逗号分隔，校验只允许**白名单**六技能：careful/design-review/freeze/cso/design-consultation/design-shotgun/design-html/devex-review——防拼写错误静默生成空 fixture）；`buildConsumptionFixture` 与提示词循环全部吃参数化列表。
2. `PROFILE` 随技能列表派生（`g861c30-<hash>` 或保持单 profile 名——取后者：同一 profile 名重用无状态残留，DSH_HOME 每次全新）。**更正：保持 `g861cons` 不变**，DSH_HOME 为一次性 temp，无残留。
3. 记账 action 文件 phase 沿用 `consume-<skill>`；上限提示语改为"恰 N（=技能数）个计费任务"。
4. 判定/封顶/密钥纪律零改动。

**上游 frontmatter（已实测 @5755601 渲染产物，字节级）：**
- freeze: `Restrict file edits to a specific directory for the session. (gstack)`
- cso: `"Security audit: supported static findings; qualified profiles add reproduction and repair candidates. (gstack)"`（含引号）

## 测试（test/dsh-keyed-consumption.test.mjs 增量）

白名单校验（未知技能名拒绝）；`--skills freeze,cso` 的 fixture 形状（2 技能+根路由=3 条目）；默认列表向后兼容（无参=careful+design-review）；新二技能的 frontmatter 字节钉死（git show 重derive）；提示词钉 read 工具覆盖新技能名。

## 密钥预算

恰 2 计费（freeze+cso 各一）；应急上限 3。DSH 16 → 最多 19。

## 流程

计划 → 独立审计划 → 参数化实现+测试 → 键控运行 → 独立审成果 → 0.4.29 文档（§一5 安全组全收尾注记）→ 摘要 → push → CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| 工具漂移复发 | 批次 29 已钉死 "Use the read tool"（沿用）；UNMAPPED_TOOL=诚实失败 |
| 参数化破坏批次 29 语义 | 缺省值不变+向后兼容测试 |

## 非目标

- 设计组余 4 技能（后续预算批次）。
- F/G/H 桌面探针、§三环境项。

## 审计划必改落实（2026-10-29，独立审计划 6 项）

1. **白名单改为 name→字节钉定描述映射**（8 技能，计数更正）；whitelist=其键；`--skills` 测试对每个消费条目重 derive 字节匹配。
2. **校验先于密钥门**：`resolveSkills(spec)` 纯函数（拒绝未知名/空条目/**重复**——重复是真实计费失败模式：同 SKILL.md 覆写致 MARKER_NOT_VERBATIM）；缺省=默认列表，present-but-empty=拒绝。
3. **线程路径补全**：main→prepareConsumption(repoRoot,skills)→buildConsumptionFixture(root,skills)；导出别名保测试 import 兼容或同步改测试。
4. **全部恰-2 硬编码去参数化**（[3/4 task i/N]、journal 恰 N 条、'completed xN'、'N paid tasks'、'(N+1)-entry store'、blocked() 标签与用法行）。
5. **MARKER_TAG→G861-C30**；tmp 前缀/sessionId/runId/头注释同步批次 30。
6. **文档范围补全**：FEATURE_MATRIX 渲染消费行（+freeze/cso slices）与 CSO 行、doctor verticals 状态串、VERIFICATION-SCRIPTS 行描述+用法（无新行，长度 12 不变）。

另采纳建议：默认列表**顺序**钉测试（entries[0]=careful 承载判定测试）；blocked() 历史注记改为"前批历史"措辞；验证记录预声明"若双失败复跑超 cap 3 则按诚实扩展先例处理"的算术可能。
