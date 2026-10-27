# 安全组+文档生成消费套件证据（2026-10-27，批次 6 Task 3）

范围：按已装载渲染技能消费 `careful`、`freeze`/`unfreeze`、`document-generate`，复用批次 5 消费模式。边界同前：上下文注入式消费、自动拾取未验证、不升 host_verified、0 付费调用。

环境：真实 Windows 本机，Node.js v24.21.0；fixture 工作区装载 58 渲染技能（真实 CI 产物）。

## 执行记录（真实命令与输出）

任务记账：`careful`（f9209d0d）、`freeze`（3a08f122）、`document-generate`（17b4f2b3）经 tasks CLI create→start→complete 全程记录（subject 绑定真实 policyHash）。

### careful（任务 f9209d0d）

- **前置失败如实**：analytics 前置依赖 `~/.zcode/skills/gstack/bin/gstack-paths`（SKILL.md:22）——未安装 gstack 宿主二进制，`:?` 硬失败；遥测跳过。渲染注入的 Safety Advisory 块授权自检替代。
- **遵循实质内容**：模式表+分级审查 fixture 危险变更——`git push --force origin main` 判 **HIGH 级硬拒绝**（默认分支强推）；`rm -rf ../sibling-data` 越界删除判 MEDIUM 询问。产物：审查报告（BLOCKING）。
- **审批桥**：MEDIUM 项经 `approvals ask`（prompt=审查报告）——操作员答 `reject`（拒绝越界删除与强推）→ 状态 `rejected`（终态；consume 对 rejected 拒绝为正确语义，如实记录）。

### freeze / unfreeze（任务 3a08f122）

- **机制差距如实**：渲染 freeze 依赖 gstack 自有 `freeze/bin/freeze-state.sh` + PreToolUse 钩子读状态文件并回 `permissionDecision:"deny"`——本仓库未实现该机制，不冒充。
- **边界冻结语义真实演示**（本仓库原语）：编译 writeRoots=[fixture 仓库] 策略——边界内 Edit → **abstain/IN_SCOPE**；越界 Write（System32 目标）→ **deny/OUTSIDE_SCOPE**（双侧留档，与 freeze 的「界内允许界外拒」契约对应，较 writeRoots=[] 的全域冻结更精确）；恢复原策略（unfreeze 类比）→ 写入 **abstain/IN_SCOPE** 复原。

### document-generate（任务 17b4f2b3）

- 按其 Diataxis 决策矩阵产出 **reference + how-to** 两象限文档（`docs/math-reference.md`：API 语义+安全清理指南）；自身降级条款适用（遥测跳过）。
- **Step 9 机制差距如实**：`gstack-redact` 密扫与 `gh repo view` 依赖 gstack 宿主安装——跳过并记录。
- **审批桥**：产物经 `approvals ask`（prompt=文档）→ `approve` → `consume` 全闭环（issue 6acfd37d）。

## 结论

安全组三技能与文档生成技能的消费均以「遵循什么/跳过什么/为何」逐项留档；机制差距（gstack 宿主二进制、freeze 钩子、redact 工具）全部如实标注未实现，未以角色扮演冒充机制验证。渲染技能累计消费 5 例（review+本批 4）。
