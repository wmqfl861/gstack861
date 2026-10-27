# 批次 5 实施计划（宿主装载 runbook + 加固清扫 + 渲染技能宿主消费流程）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础：ZCode 技能=目录+SKILL.md（frontmatter `name`/`description`，与渲染产物一致；stage 后目录名=frontmatter name=盘点名）；`~/.zcode` 用户级目录禁改，但**工作区级** `.zcode/skills/` 是合法测试装载点；DSH 无 gstack 式技能目录（profile 插件机制，见调研）。

**Goal:** 三件事：(1) 宿主装载 runbook 实测版——ZCode 侧以真实渲染产物在工作区 `.zcode/skills/` 完成离线装载验证并写成可复现手册，DSH 侧如实标注机制差异与待验证项；(2) 加固清扫（跨键冲突预校验、prompt-file 错误码、README 证据链接补全）；(3) **渲染技能宿主消费流程**——由本 ZCode 会话作为执行器，按已装载的渲染技能（careful 或 review）指令对 fixture 执行一次真实小流程并全程记账，证明「渲染 → 装载 → 被宿主执行」端到端。版本 0.4.2。

**Architecture:** Lane A（文档车道）产 runbook + README 链接；Lane B（代码车道）两项 TDD 加固；Task 3（协调者）执行渲染技能消费流程 + 证据 + 终审推送。A/B 文件不相交。

**Tech Stack:** 仓库现状。

**Spec:** 上述事实基础、`docs/integration/zcode-acceptance.md`（既有 guard 验收手册，本批不重复其内容）、批次 2/4 终审 Minor 清单、蓝图 M2/M3。

## Global Constraints

- 沿用全部仓库约束；不改 `~/.zcode`/`~/.dsh` 用户级配置；工作区级 `.zcode/skills/` 仅在**临时 fixture 工作区**内操作。
- 0 付费调用；状态诚实：本批「宿主消费」证据=ZCode 执行器会话按技能指令行事（上下文注入式），**自动技能拾取需新会话**（用户解锁项不变，不宣称 host_verified）。

## Review Focus

1. runbook 的每条命令真实可复现（本批实测过的工作区装载路径）；不与 zcode-acceptance.md 重复或冲突。
2. 跨键冲突预校验不改变任何现有测试语义（纯收紧：原先写入期 EEXIST 的场景提前为 STAGING_INVALID）。
3. 消费流程证据只记录真实执行的内容与输出。

---

### Task 1 (Lane A): 宿主装载 runbook 实测版 + README 链接

**Files:**
- Create: `docs/integration/host-loading.md`
- Modify: `README.md`（开发文档节链接补全：batch3/batch4 JSON 与本手册；上游渲染节指向本手册）

**Interfaces:**
- `docs/integration/host-loading.md`：
  1. **ZCode 工作区装载（本批实测）**：`stage-render`（真实 CI 产物或本地维护者渲染）→ `install --staging S --target <workspace>/.zcode/skills`——注意 target 即技能目录本身（每技能一个子目录，含 SKILL.md+sections+manifest.json+注册表 `.gstack861-registry.json`；ZCode 对多余文件的容忍度=未知，列为新会话验收观察项）→ 新会话自动拾取的预期与验收方法（引用 zcode-acceptance.md 的清单风格，标注「自动拾取未验证」）。
  2. **目录名=frontmatter name** 的一致性说明（stage 后均为盘点名）与上游 `nameMatchesDirectory` 注意点。
  3. **DSH 侧**：如实写「无 gstack 式技能目录；渲染内容可作为上下文/文档注入；插件式技能装载机制待 DSH 侧验证（调研文档第 5/6 节）」。
  4. 卸载/回滚经 `uninstall --target <workspace>/.zcode/skills`。
- README：补 batch3/batch4 验证 JSON 链接（两轮终审都点过名）；渲染节加「装载见 host-loading.md」。

- [ ] 手册（ZCode 部分命令以本批 Task 3 实测为准——Lane A 先写结构与非实测部分，Task 3 实测后回填「已实测」标注并提交）→ 提交（分支 `b5-lane-a`）

### Task 2 (Lane B): 加固清扫（TDD）

**Files:**
- Modify: `src/install.mjs`、`bin/gstack861.mjs`
- Test: `test/install.test.mjs`、`test/adapters.test.mjs`

**Interfaces:**
1. `stagingPlan` 跨键冲突预校验：同一 staging manifest 的 files 键两两检查——小写化后冲突（`A.md`+`a.md`）或一键为另一键的路径前缀（`a` 与 `a/b.md`）→ `STAGING_INVALID`（原先 Windows 写入期 EEXIST / POSIX ENOTDIR 的场景提前为干净拒绝；写入期行为不变，纯收紧）。
2. `approvals ask --prompt-file` 读取错误（缺失 ENOENT 等）与解析错误 → `gstack861:INVALID_PROMPT_FILE`（限枚举类，与 action-file 同款实现；`ABSOLUTE_PATH_REQUIRED` 语义保留）。
- 测试：冲突两例（大小写/前缀）拒绝且零写入；POSIX 与 win32 语义一致（冲突检查在两层都触发，不需平台包裹）；prompt-file 缺失/坏内容 exit 1 + 错误码；相对路径仍 ABSOLUTE_PATH_REQUIRED。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b5-lane-b`）

### Task 3 (协调者): 渲染技能宿主消费流程 + 证据 + 终审 + 推送

- [ ] 临时 fixture 工作区：`stage-render`（真实渲染产物）→ `install --target <fixture>/.zcode/skills`；断言技能目录/文件/frontmatter
- [ ] **消费流程**：由本 ZCode 会话按已装载的 `careful`（或 `review`）渲染技能指令，对 fixture 仓库的一个含危险命令变更执行技能要求的安全审查，产出技能规定的输出物；全程 `tasks` CLI 记账；结果与边界（上下文注入式消费；自动拾取待新会话）写入 `docs/verification-2026-10-27-render-consumption.md`
- [ ] 回填 runbook「已实测」标注；VERIFICATION 第十轮 + 证据 JSON + 摘要（协议顺序）+ 版本 0.4.2
- [ ] 终审（独立子代理）→ 修复轮 → 推送 main → CI 绿确认

## Deferred

- DSH 插件式技能装载（待解锁后机制验证）；DSH toolRewrites；M3 设备依赖组；M4；两项用户解锁（DEEPSEEK_API_KEY / ZCode 受控新会话）不变。
