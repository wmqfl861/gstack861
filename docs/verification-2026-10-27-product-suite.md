# 产品套件消费证据（2026-10-27，批次 8 Task 3）

范围：按已装载渲染技能消费 `office-hours`、`spec`、`deslop-shared-libs`（累计消费 **11 例**）。边界同前：上下文注入、自动拾取未验证、非 host_verified、0 付费调用。

任务记账：三任务 create→start→complete 全程记录，终态均 completed。

## office-hours（startup 模式）

- **真实读其 sections**（`phase-2a-startup-diagnostic.md` 六问 + `design-and-handoff.md` startup 模板——遵守其 STOP-gate「不得凭记忆跑」）；产品阶段声明（pre-product 内部工具，Q1-Q3 路由为主）。
- 产物：**其 startup 模板全套章节**的设计文档（Problem/Demand Evidence/Status Quo/Narrowest Wedge/Premises/两个 Approach/推荐/Open Questions/Success Criteria/Distribution/**强制的 The Assignment**/What-I-noticed），落 fixture `docs/designs/audit-safe-cleanup.md`（$GSTACK_STATE_ROOT 路径替代披露）。
- **跳过留档**：Spec Review Loop（gstack-office-hours-review 二进制）、cross-model 二审、telemetry/skill-start（其自带降级）、builder-profile（startup 模式不适用）。

## spec（五阶段 + Standard Issue）

- 真实五阶段走完：Phase1 五问（需求原话「让清理安全且可审计」）；Phase2 显式 Out of Scope；Phase3 代码接地（引 `scripts/clean.sh:3`、lessons.jsonl、批次 5 验证的原语）；Phase4 草稿评审；**4.5 语义审查输出 `SEMANTIC_REVIEW: flagged`**（发现 t1 验收项 no_claim 标「无」但断言未覆盖清单内容——真实发现，已在 Rules 要求补强后归档）；Phase5 本地归档（fixture 根替代 $GSTACK_STATE_ROOT）。
- 产物：**其 Standard Issue 模板**（含每测试 protects/fails_when/no_claim 卡的验收表、Testing Plan、Rollback、Effort），落 `specs/2026-10-27-audit-safe-cleanup.md`。
- **跳过留档**：4.5b redaction（失闭宿主依赖）、spawn worktree agent（Phase5 可选 --execute 路径，按其自带 file-only 模式跳过）、gh 归档（无远端）。

## deslop-shared-libs（方法论 + 两处依赖如实）

- **遵循**：14 天窗（覆盖全部 4 提交）、真实提交扫描、其验证门槛（候选须 ≥2 个经证实第一方调用者，函数/行引用）。
- **诚实结果：零候选**——全仓 `sum` 仅 1 个调用者（test/math.test.mjs:5，且无断言——test-audit 已另案裁决）；无任何重复逻辑。按其原文「If no worthwhile opportunity survives validation, say so and state the evidence limits」输出零发现结论。
- **依赖留档**：`gstack-safe-git` 强制包装缺失→按其降级用裸 git 并披露；**只读边界遵守**（审计中零文件写入、未执行含缺口测试；本节为事后簿记）；无远端→PR 活动覆盖 N/A。

## 结论

三技能均按其真实模板/阶段/门槛消费；spec 的语义审查真实拦下了一个验收弱点（flagged）；deslop 的验证门槛正确拒绝了唯一候选——方法论在 fixture 上真实运转而非走过场。累计消费 11 例。
