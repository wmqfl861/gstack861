# 批次 9 实施计划（M3 纯工作流消费收官 + 离线边界固化）v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核（审查修正已并入本版：make-pdf/diagram 真实依赖与降级、context-save/restore 规定细节、边界清单扩展至 13 项、Lane B 移出 README、doctor 计数与 Task 3 完成度耦合）。复用已验证消费模式（累计 11 例）。

**Goal:** (1) 消费四技能收官 M3 非设备纯工作流组：`context-save`（其规定文件布局：frontmatter（status/branch/timestamp/session_duration_s/files_modified + stamp 字段）+ `## Working on`/`### Summary`/`### Decisions Made`/`### Remaining Work`/`### Notes`；Remaining Work 逐项 `Open.` 开头 + 五个英文溯源词尾之一**逐字保留**（restore 按其排序）；追加式 checkpoint 落 fixture 替代路径；stamp 宿主依赖如实）、`context-restore`（其检查单输出留证：head 对比判定、按溯源词排序的 Verify first/Next steps 分栏、RESUMING CONTEXT 呈现；恢复期硬门=零代码改动）、`diagram`（先真实跑其 Step 2 bundle 检查；缺失→按其 Rules 记 **BLOCKED** + 其规定补救（bun run build:diagram-render / open Aside / ./setup）；`.mmd` 源如实标注部分产物——其原文「A .mmd file alone is not a diagram」）、`make-pdf`（真实链=构建产物 make-pdf/dist/pdf CLI + Aside/gstack 自有无头浏览器 + Linux 字体 + pdftotext；`"$P" setup` 检查留证；浏览器/构建产物缺失时 exit 4 按其原文声明 BLOCKED + 其规定补救，同时交付其自带降级产物 `--to html` 单文件；不发明 ASCII 预览）；(2) **离线边界固化**：README 与 FEATURE_MATRIX 写入「离线可推进空间已尽」声明，剩余 13 项逐项注阻塞原因。版本 0.4.6。

**Architecture:** Lane A（README 边界节+证据链接+FEATURE_MATRIX 边界行与计数 15 同步）与 Lane B（仅 bin+test：doctor 计数 11→15+evidence append；**不动 README**）不相交；Task 3 消费+证据+终审推送；doctor 计数 15 仅在 Task 3 四消费完成后随终稿生效（与 batch-8 同款耦合）。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M3 记忆/辅助工具行、批次 5-8 消费模式、四技能渲染文本。

## Global Constraints

- 消费边界同前（上下文注入、自动拾取未验证、非 host_verified、0 付费调用）。
- make-pdf/diagram 按其自带降级路径处理并如实；BLOCKED 不硬造产物；diagram 渲染前不得宣称交付三元组。
- 边界声明逐项列举（13 项）+ 具体阻塞原因，禁笼统。
- 0 付费调用。

## Review Focus

1. 四技能「遵循/跳过/为何」逐项留档；make-pdf 不硬造 PDF、diagram 未渲染即 BLOCKED。
2. 边界 13 项每项可指向具体阻塞原因与解锁动作。
3. doctor 计数 15 与 evidence append 同步移动、且仅随 Task 3 完成生效。

---

### Task 1 (Lane A): README/FEATURE_MATRIX 离线边界声明

**Files:** `README.md`、`docs/FEATURE_MATRIX.md`
- README 新增「离线边界（2026-10-27 固化）」节：已交付摘要（渲染管线/装载链/11+4 例消费/审批与任务原语/dry-run 全家）+ 剩余 13 项逐项注阻塞：① DSH 管线+纵向+toolRewrites（缺 DEEPSEEK_API_KEY）；② DSH 插件式技能装载机制验证（host-loading §4 第 4 条，独立于①）；③ ZCode guard 层+自动拾取+容忍度（需受控新会话）；④ 宿主内嵌询问/审批 UI 接通（区别于③）；⑤ GBrain 真接入（待①②③）；⑥ 浏览器 QA/scrape/qa 组（浏览器栈）；⑦ iOS 组（设备）；⑧ ship/canary/deploy（远端）；⑨ 独立模型复核（显式网关配置，0 付费红线内不跑）；⑩ 子 Agent 执行器/取消/恢复接线与纵向真实执行（待①③后按批推进）；⑪ 宿主级自动安装/升级/卸载（待③）；⑫ make-pdf/diagram 完整产物链（重二进制/浏览器，本批以降级/BLOCKED 如实消费）；⑬ M4 多 OS 矩阵与完整对等（前述全部之后）。
- README 开发文档节补 batch8 JSON + product-suite 链接（一轮滞后，本车道承担）。
- FEATURE_MATRIX 状态行加「离线空间已尽（2026-10-27）；剩余项均受阻于用户解锁或环境」；消费计数 11→15（Task 3 后由协调者定稿，Lane A 先不动计数）。
- 提交（分支 `b9-lane-a`）：`docs: codify exhausted-offline-space boundary`

### Task 2 (Lane B): doctor 计数预备

**Files:** `bin/gstack861.mjs`、`test/adapters.test.mjs`（不动 README）
- doctor consumption 计数 11→15 + evidence append `docs/verification-2026-10-27-final-suite.md`（count/evidence 同步；测试断言同步；注释注明仅在 Task 3 完成后合入）。
- 提交（分支 `b9-lane-b`）：`feat: doctor consumption count 15`

### Task 3 (协调者): 四技能消费、证据、终审、推送

- [ ] fixture 延续；四技能按 Goal 中各自规定消费（context-save 规定布局+溯源词逐字；restore 检查单留证；diagram bundle 检查→BLOCKED+.mmd 部分产物；make-pdf setup 检查→BLOCKED 或降级 `--to html` 交付）
- [ ] 全程 tasks 记账；证据 `docs/verification-2026-10-27-final-suite.md`；VERIFICATION 第十四轮 + 0.4.6 + 摘要 → 终审 → 推送 → CI 绿
- [ ] FEATURE_MATRIX 消费计数定稿 15

## Deferred

- 两项用户解锁（首尾重申）；边界 13 项中除⑫外的全部环境/解锁依赖项；M4。
