# 批次 29 计划：DSH 键控预算类消费——安全组 careful + 设计组 design-review（2026-10-29）

## 背景与目标

OFFLINE-COMPLETE §一5（DSH 键控预算类消费）是当前**唯一**代理可执行的剩余项（③ 已桌面验收、⑨ 已真调用、其余环境受阻）。本批以批次 12 的键控消费方法论（`verify-dsh-vertical.mjs` 任务 A 模式）消费两个此前零消费的技能：

- **安全组**：`careful`（谨慎模式，安全类核心）
- **设计组**：`design-review`（设计评审）

消费 = 模型经注入的 gstack861 skills index **真实读取**该技能的 SKILL.md 并逐字输出其不可猜标记行——与 15 例既有消费同判据（marker verbatim + 零 gstack861 码 + 降级/门槛按技能原文执行如实记录）。

## 设计：scripts/dsh-keyed-consumption.mjs（新，键控 2 任务）

模板 = `verify-dsh-vertical.mjs` 任务 A（双插件装载 + index 注入 + 标记回显），差异：

1. **渲染技能源**：任务 A 用离线 render-tree fixture；本批改用 **CI 渲染产物**？不可得（render-upstream 仅 CI 跑）。**改用 fixture 链**：从固定上游以 `git show <pin>:skills/<name>/SKILL.md.tmpl` 抽模板？模板含未解析占位符，index 描述行可用但 marker 行不在模板里。**最稳路径**：手工 fixture SKILL.md（批次 12 任务 A 同款：自建 `<name>/SKILL.md` 含 YAML 头+描述+不可猜标记行），**但** index 命名与描述取自上游实测（`git show` 模板的 frontmatter 原文）——消费证明的是"宿主技能装载→index 注入→模型真实读文件"链路，链路真实性与内容来源无关（与批次 12/25 同一诚实处理，计划明示）。
2. **两任务各消费一个技能**：任务 S1 读 `careful/SKILL.md` 输出其标记行；任务 S2 读 `design-review/SKILL.md` 输出其标记行。各自 `tasks` CLI 记账（host=dsh）。
3. **技能组原样保留其余技能不入 index**（每次装载恰 2 技能，index 注入面最小化）。
4. 判定码：`PASS | MARKER_NOT_VERBATIM | GUARD_CODES_PRESENT | SKILL_NOT_IN_INDEX(零消费) | JOURNAL_*`。
5. 无密钥 exit 2 BLOCKED（沿三段式）。

## 测试（test/dsh-keyed-consumption.test.mjs，全离线）

提示词 ≤200 三档；fixture builder（两技能名、标记行、YAML 头与上游 frontmatter 实测一致）；判定码全形；无密钥 exit 2；`PROMPT_MAX_CHARS` 常量钉死 200。

## 密钥预算

恰 2 个计费任务（每任务 1 提示词，≤200 字符 throw-before-launch；会话标题微请求 caveat 同前）。应急上限 3。项目 DSH 计费累计 12 → 最多 15。

## 流程

计划（本文件）→ 独立审计划 → 实现+离线测试 → 键控运行（2 计费）→ 独立审成果 → 0.4.28 文档（FEATURE_MATRIX 安全组/设计组行按实测升级；OFFLINE-COMPLETE §一5 部分完成标注）→ 摘要 → push → CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| fixture 非渲染产物被质疑 | 计划与证据明示：链路证明（装载→index→真实读），与批次 12/25 同一诚实处理；渲染链另有实证 |
| 模型不消费 index | 判定码 SKILL_NOT_IN_INDEX 如实记录（批次 12 先例：诚实失败） |
| 上游 frontmatter 抽取错 | `git show` 原文嵌入计划审核范围 |

## 非目标

- 其余安全组（freeze/cso）与设计组（consultation/shotgun/html/devex）——后续批次按预算续接。
- GBrain/浏览器/设备（环境受阻不变）。

## 审计划必改落实（2026-10-29，独立审计划 5 项）

1. **三向一致性登记**：新增 VERIFICATION-SCRIPTS.md 行（keyed=密钥需）+ doctor verticals 条目（keyed:true）+ verify-offline BLOCKED 冒烟注册（头部"六键控脚本"改七）+ adapters 测试钉死数组同步。缺任一即红。
2. **上游路径与描述修正**：技能在仓库根（`careful/SKILL.md.tmpl`，非 `skills/…`）；**tmpl 块标量描述不可用**（adapter 只取首行）→ fixture 描述取**钉定上游已渲染 SKILL.md 的 frontmatter 原文**（已实测：careful=`Safety guardrails for destructive commands. (gstack)`；design-review 含引号/em dash/撇号，字节级内嵌计划与测试）。真实渲染体不用作 fixture 的理由入档（宿主变体差异 + design-review 137KB 读尺寸）。
3. **记账机器显式化**：模板（verify-dsh-vertical）**不含** tasks CLI——记账为新增机器，按 dsh-mini-vertical 先例（tasksArgs/每任务 action 文件/state 在工作区外/loadPolicy 真 hash）。差异列表更正。
4. **判据措辞收窄**：判据=**批次 12 任务 A 同款**（marker verbatim + 零 gstack861 码）；"降级/门槛按原文执行"不适用（合成 fixture 无原文门槛）——**此 2 例不计入 15 例方法论消费计数**；FEATURE_MATRIX 升级措辞沿「开发/调查/review」行先例（"能力切片…非方法论消费"）。落地行：design-review→「浏览器/QA/设计」；careful→「渲染技能宿主消费」行注记（本批为链路切片）。
5. **SKILL_NOT_IN_INDEX 检测基础**：定义=流中无指向该 SKILL.md 路径的 read tool_call **且** marker 缺席（--json 流可得，纵向证据文档先例）；否则并入 MARKER_NOT_VERBATIM。采用定义版。

另采纳建议：fixture 含 `gstack` 根路由（index 3 条目——模板 buildSkillsFixture 同款 +1）；两提示词长度入测试钉死；真实渲染体尺寸实测（4,739B / 137,153B）替换"81KB"讹传。
