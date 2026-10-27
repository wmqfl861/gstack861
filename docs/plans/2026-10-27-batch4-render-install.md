# 批次 4 实施计划（渲染产物接入装载链）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础（本机实测 CI 渲染产物）：58 目录（57 技能+根 `gstack`）；多数目录仅 SKILL.md，约 31 个辅助 section `.md` 分布在部分技能目录内；render-manifest 形如 `{schemaVersion, host:'zcode', generatedBy, status, skills:{盘点名→SKILL.md sha256}, root:{path:'gstack/SKILL.md', sha256}}`；install 侧 manifest 校验为正向字段检查（无严格键集），registry 是卸载信任锚。

**Goal:** 打通 `CI 渲染产物 → stage-render（staging 适配）→ installSkills → 卸载` 全链，使渲染技能真正可装载：多文件技能（SKILL.md+section 文件）在安装/防篡改/卸载全程受内容验证保护。版本 0.4.1。

**Architecture:** Lane A 给 install 链增加**可选 `files` 摘要映射**（staging manifest 与 registry 条目的加性字段；写入、TAMPERED 校验、卸载内容验证、registry 记录全程一致；无 files 时行为字节不变）；Lane B 新增 `stage-render` 适配器（渲染树+render-manifest → 合法 staging，含根路由）。两车道文件不相交可并行；多文件端到端测试在 Task 3 合并后落地。

**Tech Stack:** 仓库现状：Node 22+、零依赖、node:test、ESM。

**Spec:** 上述事实基础、`src/install.mjs` 现有约定（GENERATOR/SHA256/COMMIT/NAME/HOSTS、两阶段、锁、registry）、`scripts/render-upstream.mjs` 的 renderedDir 命名规则、蓝图第 1 节。

## Global Constraints

- 沿用全部仓库约束（零依赖、UPPER_SNAKE、TDD、不删不减既有测试、平台包裹、状态诚实——staging 的 renderStatus 仍是 rendered-experimental，不宣称宿主验证）。
- 加性变更：无 `files` 字段的 staging/registry 行为与现有全部测试**字节不变**；registry 条目新增可选 `files`（老注册表无此键照样可卸载）。
- 文件名安全：`files` 键限平铺文件名 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`（拒绝分隔符、`..`、绝对路径）；值 hex64。
- 两车道文件不相交：A=`src/install.mjs`+`test/install.test.mjs`；B=`src/stage.mjs`+`bin/gstack861.mjs`+`test/stage.test.mjs`（新）。README/FEATURE_MATRIX 归 Task 3。

## Review Focus

1. **registry 是唯一信任锚**：卸载时 files 摘要必须对 **registry 记录**校验（不是目标目录自述）；目标 manifest 与 registry 不一致 → `USER_FILE_REFUSED`。
2. **多余文件零容忍**：目录内容集必须恰为 `[SKILL.md, manifest.json, ...files 键]`；未列出文件 → 拒绝（用户数据保护不降级）。
3. **stage-render 的名称映射**：盘点名 ↔ 渲染目录名（`gstack-` 前缀直通规则，同 render-upstream）；孤儿目录/摘要不符/占位符/缺横幅全部拒绝且零写入。
4. **根路由 `gstack`**：以盘点外技能身份入 staging（name='gstack'，摘要取 root.sha256）；其 files 同规则。
5. **无 files 路径回归**：既有 install 测试全部原样通过。

---

### Task 1 (Lane A): install 链多文件支持

**Files:**
- Modify: `src/install.mjs`
- Test: `test/install.test.mjs`

**Interfaces:**
1. stagingPlan：manifest 可选 `files`（平铺名→hex64 映射，形状不符 `STAGING_INVALID`）；校验阶段对每个列出文件读字节算摘要，不符 → `TAMPERED_STAGING`（列入文件不存在同码）。
2. 写入阶段：安装技能目录时写 `SKILL.md`、`manifest.json` 与全部列出文件（`wx`，0644）。
3. registry 条目：`{name, sha256, files?}`（有才写）。
4. `verifyOwned`（卸载）：目录 readdir 集恰为 `[SKILL.md, manifest.json, ...files 键]`（排序比较）；`manifest.sha256 === registry.sha256` 既有规则不变；每个 files 文件摘要 === **registry.files** 记录；无 registry.files 而目标有 files → `USER_FILE_REFUSED`（信任锚不一致）。
5. 卸载删除整目录（既有行为，含 files）。
- 测试：多文件安装→目录三文件齐全→registry 含 files→卸载通过且目录移除；篡改任一列出文件（staging 侧→TAMPERED；目标侧→卸载 USER_FILE_REFUSED）；目标出现未列出文件→卸载拒绝；伪造 registry.files 与目标 manifest 不一致→拒绝；无 files 全旧测试原样通过。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b4-lane-a`）

### Task 2 (Lane B): stage-render 适配器

**Files:**
- Create: `src/stage.mjs`、`test/stage.test.mjs`
- Modify: `bin/gstack861.mjs`（新子命令）

**Interfaces:**
- `stageRender({ rendered, manifestFile, host, staging, now })` → `{schemaVersion:1, host, staging, staged, files, root}`：
  1. 校验 render-manifest：`schemaVersion===1`、`host===--host`∈HOSTS、`skills` 非空平铺映射（值 hex64）、`root={path:'gstack/SKILL.md', sha256}` 形状；不符 `RENDER_MANIFEST_INVALID`。
  2. `rendered/<hostSubdir>/skills`（hostSubdir=`.{host}`）目录扫描：每个目录名经直通规则映射回盘点名；映射不在 skills 且目录名 ≠ `gstack` → `RENDER_TREE_INVALID`（孤儿）；skills 中有名而树缺目录 → 同码；`gstack` 根目录必须存在。
  3. 每技能：SKILL.md 字节 sha256 === manifest 值、含 `AUTO-GENERATED`、零 `{{...}}`；目录内其余**平铺普通文件**（子目录 → `RENDER_TREE_INVALID`）计入 `files`（名→sha256）。
  4. staging 必须绝对且不存在/空目录（同 generate 约定）；写 `<盘点名>/SKILL.md`（字节原样）+ 列出辅助文件 + `manifest.json`：`{schemaVersion:1, name, host, source:'render:<hostSubdir>', blob:<blobHash(SKILL.md字节)>, sha256, commit, files, placeholders:[], indicators:[], needsReview:false, status:'rendered-experimental', generator:'gstack861', generatorVersion:<pkg>, generatedAt:now()}`；`commit` 默认锁文件（`GSTACK861_TEST_COMMIT` 覆盖 + stderr 警告，同 generate 约定）。
  5. 根 `gstack` 以 name `gstack` 同规则入 staging（摘要取 root.sha256）。
  6. 任何拒绝零写入（先全量校验后落盘）。
- CLI：`stage-render --rendered DIR --manifest FILE --host zcode|dsh --staging DIR`。
- 测试：手工 fixture（单文件技能+多文件技能+根；篡改 SKILL.md→拒；孤儿目录→拒；缺根→拒；占位符→拒；manifest host 不符→拒；坏形状→拒）全部零写入断言；无网络无 bun。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b4-lane-b`）

### Task 3 (协调者): 合并、端到端、证据、终审、推送

- [ ] 合并 A→B（顺序合并，各自全量绿）；**多文件端到端测试**（fixture 渲染树 → `stage-render` CLI 子进程 → `install` → 断言三文件+registry.files → `uninstall`）补入 `test/stage.test.mjs`
- [ ] 本机真实渲染产物实跑一次 `stage-render → install → uninstall`（`$TEMP` 渲染树），输出记入证据（非提交测试）
- [ ] README（上游渲染节补装载链用法）+ FEATURE_MATRIX（渲染行更新为「可装载 rendered-experimental」）+ VERIFICATION 第九轮 + 摘要（协议顺序）+ 版本 0.4.1
- [ ] 终审（独立子代理）→ 修复轮 → 推送 main → CI 绿确认

## Deferred

- DSH toolRewrites（待管线级工具名证据）；宿主技能目录真实装载验收（ZCode/DSH 侧，待用户解锁项）；M3 设备依赖功能组；M4。
