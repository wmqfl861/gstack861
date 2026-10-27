# 批次 9 实施计划（M3 纯工作流消费收官 + 离线边界固化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。复用已验证消费模式（累计 11 例）。context-save（650 行/28 依赖）、context-restore（665/21）、diagram（288/9，产物为图三元组）、make-pdf（409/23，PDF 产物依赖重二进制链）。

**Goal:** (1) 消费四技能收官 M3 非设备纯工作流组：`context-save`（真实保存 fixture 会话上下文——git 状态/决策/余项，产物落其规定位置）、`context-restore`（真实恢复刚保存的上下文并复述验证）、`diagram`（按其规定把英文描述转为图三元组——mermaid 源+渲染产物按其降级路径处理）、`make-pdf`（把 fixture 的 markdown 转 PDF——其重二进制链（sharp/字体）缺失时的降级如实）；(2) **离线边界固化**：README 与 FEATURE_MATRIX 写入「离线可推进空间已尽」声明——剩余项全部依赖两项用户解锁或设备/浏览器环境，逐项列举。版本 0.4.6。

**Architecture:** Lane A（代码：无新功能——本批为消费+文档批；Lane A 承担 README/FEATURE_MATRIX 边界声明草稿）与 Lane B（docs：doctor 消费计数 11→15 预备+证据链接）不相交；Task 3 消费+证据+终审推送。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M3 记忆/辅助工具行、批次 5-8 消费模式、四技能渲染文本。

## Global Constraints

- 消费边界同前（上下文注入、自动拾取未验证、非 host_verified、0 付费调用）。
- make-pdf 的重依赖（sharp/字体/Chromium 链）按其自带降级处理并如实；产物若不可产则按其原文声明 blocked，不硬造。
- diagram 的渲染步骤若依赖其二进制，mermaid 源产物仍真实交付（源即其三元组之一）。
- 边界声明必须**逐项列举**剩余受阻项与其阻塞原因（两项解锁/设备/浏览器/远端），不得笼统一句。
- 0 付费调用。

## Review Focus

1. 四技能「遵循/跳过/为何」逐项留档；make-pdf 不硬造 PDF。
2. 边界声明的每一项都可指向具体阻塞原因与解锁动作。
3. doctor 计数 11→15 与 evidence append 同步移动。

---

### Task 1 (Lane A): README/FEATURE_MATRIX 离线边界声明

**Files:** `README.md`、`docs/FEATURE_MATRIX.md`
- README 新增「离线边界（2026-10-27 固化）」节：离线可推进空间已尽——已交付（渲染管线/装载链/11 例消费/审批与任务原语/dry-run 全家）；剩余逐项：DSH 管线+纵向+toolRewrites（缺 DEEPSEEK_API_KEY）、ZCode guard 层+自动拾取+容忍度（需受控新会话）、GBrain 真接入（同前二项后）、浏览器 QA/scrape/qa 组（浏览器栈）、iOS 组（设备）、ship/canary/deploy（远端）、make-pdf/diagram 完整产物链（重二进制/字体，本批以降级产物消费）、M4 多 OS 矩阵与完整对等（前述全部之后）。
- FEATURE_MATRIX 状态行加「离线空间已尽（2026-10-27）；剩余项均受阻于用户解锁或环境」。
- 提交（分支 `b9-lane-a`）：`docs: codify exhausted-offline-space boundary`

### Task 2 (Lane B): doctor 计数预备与证据链接

**Files:** `bin/gstack861.mjs`、`test/adapters.test.mjs`、`README.md`（仅证据链接行）
- doctor consumption 计数 11→15 + evidence append `docs/verification-2026-10-27-final-suite.md`（count/evidence 同步；测试断言同步）。
- README 开发文档节补 batch8 JSON + product-suite 链接（一轮滞后）。
- 提交（分支 `b9-lane-b`）：`feat: doctor consumption 15 and round-13 links`

### Task 3 (协调者): 四技能消费、证据、终审、推送

- [ ] fixture 延续；**context-save**：按其规定真实保存（git 状态/本会话决策清单/余项），产物落其规定文件名（路径替代披露）；**context-restore**：真实读取并复述验证（恢复检查单逐项确认）
- [ ] **diagram**：对 spec 的审计流程产出其三元组中的 mermaid 源（真实交付）；渲染二进制缺失降级如实
- [ ] **make-pdf**：对 fixture 的 design 文档尝试其管线；重依赖缺失→按其原文 blocked 声明+降级产物（如 ASCII 预览）如实
- [ ] 全程 tasks 记账；证据 `docs/verification-2026-10-27-final-suite.md`；VERIFICATION 第十四轮 + 0.4.6 + 摘要 → 终审 → 推送 → CI 绿

## Deferred

- 两项用户解锁（首尾重申）；设备/浏览器/远端组；M4。
