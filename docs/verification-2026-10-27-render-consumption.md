# 渲染技能宿主消费流程证据（2026-10-27，批次 5 Task 3）

范围：证明「上游渲染 → stage-render → 工作区装载 → **被 ZCode 宿主执行器消费**」端到端成立。**边界（如实）**：消费方式为上下文注入（执行器直接读取 fixture 工作区 `.zcode/skills/review/SKILL.md` 并遵循其指令行事）；宿主对新会话技能的**自动拾取未验证**（用户解锁项，见 host-loading.md §2.4）；不构成 guard 层或 host_verified。

环境：真实 Windows 本机，Node.js v24.21.0；渲染产物为批次 3 CI 真实渲染（zcode，57+根）。

## 执行记录（全部真实命令与输出）

1. **装载**：`stage-render --rendered <CI渲染树> --manifest render-manifest-zcode.json --host zcode --staging S`（exit 0）→ `install --staging S --target <fixture>/.zcode/skills`（exit 0，58 技能目录）；断言 `review/SKILL.md` frontmatter `name: review`、目录名一致。
2. **消费**（执行器=本 ZCode 会话，任务 `b4879060` 经 `tasks create/start` 记账，policyHash `11670e05…`）：
   - 按技能自身的 **Degraded mode 条款**（`SKILL_START_PROTO` 缺失→安全默认、跳过 onboarding/遥测、`SESSION_KIND: interactive`、继续任务）执行；
   - 按其 **Step 0**：基线检测（main，merge-base `cb74d64810`）、`git diff main --stat`；
   - 按其方法论（SQL safety 为技能描述明列目标；Claims Need Evidence；See Something, Say Something）审查 fixture 分支 diff；
   - **产出技能规定的输出物**：审查报告（1 Critical：`searchUsers` 模板字符串内插 SQL 注入，附 diff 证据；1 Important：基线 `getUser` 同模式缺陷按 See-Something 条款上报；1 Minor：无界查询），结论 BLOCKING，按其完成状态协议报告。
3. **审批闭环经原生询问桥**：`approvals issue`（id `26cb0288`）→ `approvals ask --prompt-file <审查报告>`（stdin `approve` + reason；问题 JSON 含报告内容；exit 0）→ `approve` 落盘 → `consume`；任务 `complete`。
4. **回滚**：`uninstall --target <fixture>/.zcode/skills` → 58 清空（runbook §2.5 回填实测）。

## 结论

渲染产物在内容与方法论层面可被宿主执行器真实消费并产出合规输出物；装载/回滚命令链在真实工作区 `.zcode/skills` 实测通过（runbook 已回填）。剩余边界：新会话自动拾取、ZCode 对技能目录内 manifest/注册表条目的容忍度——均列为验收项待用户受控会话。
