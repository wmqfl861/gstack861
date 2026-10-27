# ZCode 宿主真实纵向流程证据（2026-10-27，M2 工作流层）

范围：蓝图 M2「需求→规划→实现→review→qa→ship，使用目标宿主自己的执行器」在 **ZCode 宿主**上的首次真实执行。宿主执行器=运行本开发的 ZCode 会话（真实模型驱动，非模拟）；review 阶段由独立子代理执行。**本证据只覆盖工作流层**：任务日志、审批闭环、阶段产物均为真实 CLI 调用与真实输出；guard 层（Hook 拦截）的宿主级验证不在其中——该验证需按 `docs/integration/zcode-acceptance.md` 在受控新会话执行，仍为未完成。

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0，gstack861 0.3.0（`efc5679`）。

## 执行记录（全部真实命令与输出，原始日志见会话记录）

fixture：临时目录 `stats.mjs`（含缺陷的 median）+ `stats.test.mjs`（node:test 4 用例）。策略：真实编译（workspace=fixture，仅绑 Read/Write/Edit），`policyHash=d0aa609c…5cd10e7f`，策略文件在 workspace 之外。

| 阶段 | 执行器 | gstack861 原语 | 真实输出（摘要） |
|---|---|---|---|
| spec | ZCode（读码+测试定位） | `tasks create/start/complete` | 任务 `d32bc9d2`；需求：偶数长度 median 返回上中位元素而非两中位平均；缺陷证据=第 2 用例失败（3 pass / 1 fail） |
| plan | ZCode | 同上 | 任务 `b94771c1`；三步计划 |
| implement | ZCode（编辑 `stats.mjs`） | 任务 `374c4d22` | 偶数分支改为两中位平均 |
| review | **独立子代理**（只读+探针） | 任务 `03f3682b` | 结论 approve；探针覆盖奇/偶/负数/重复/单元素/空输入全部正确；指出测试可加单元素/负数/未排序偶数用例 |
| qa | 真实测试运行 | 任务 `qa`（id 见日志） | `node --test stats.test.mjs` → **4 pass / 0 fail** |
| 审批 | 操作员 CLI | `approvals issue→verify→approve→consume` | id `306bc4ab`；verify `binding:"match"`；pending→approved→consumed；TTL 600000ms；单次消费语义跨子命令保持 |
| ship | git | 任务 `ship` | 修复提交 `ba1e41f`（基线 `6a197e3`）；**tag `v0.1.0`** 创建成功 |

任务账本：7 条任务全部 `completed`（spec/plan/implement/review/qa/ship + 首条 spec 起始任务）；subject 全程绑定同一 policyHash 与 session/run。

## 执行中发现的真实问题（如实记录）

1. **TaskStore 与 ApprovalStore 共用同一 `--state` 目录时，`tasks list` 抛 `INVALID_TASK_RECORD`**：审批记录（schema 同为 1）不满足任务记录校验，fail-closed 使列表整体不可用。本流程全部单任务操作成功，仅末尾快照命令失败。处置：**两个 store 必须使用不同状态目录**（本流程的有效操作都各自成功证明单 store 语义无恙）；修复方向（文件命名空间隔离 vs 校验器区分外来记录）留批次 2 裁决，已列入 Deferred。
2. 过程失误两例（已修正、无影响）：`--action-file` 引号误吞 `--ttl-ms` → `ENOENT`（拒绝路径正确工作）；git tag 需显式身份（`-c user.name/email`）。原始日志保留失败行，不修饰。

## 结论与边界

- M2 工作流层纵向流程在 ZCode 宿主**真实跑通一次**：六阶段全过、独立 review、审批闭环、真实交付物（修复+tag）。
- 不构成 `host_verified`：guard Hook 未参与本流程（未安装）；DSH 侧纵向未执行（密钥缺失）；ship 为 fixture 级类比（无部署环节）。
- fixture 仓库历史含一笔设置期重复基线提交（`f1c40ff`），如实保留。
