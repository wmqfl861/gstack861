# 批次 10b 实施计划（边界②：DSH 插件式技能装载——activation 级）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础：批次 3 DSH 调研（docs/integration/dsh-local-findings.md）——插件经 `DSH_HOME/profiles/<name>` + `cordis.patch.yml` 发现；最小树需 system-prompt + tools 闭包；**激活验证无需密钥**（正控 3：无输出 exit 0=全部激活）；`apply()` 抛错仅告警。被①阻塞的只是「模型运行时真消费」半边。

**Goal:** 把边界②从「机制待验证」推进到 **activation-tested**：构建 `src/adapters/dsh-skills.mjs`（DSH 技能装载插件——把已装载（install 链）的渲染技能以系统提示节的形式暴露给 DSH 会话：读取注册表，注入技能索引+按需全文），并在真实 DSH（隔离 DSH_HOME、无密钥、零付费调用）验证其**激活**。运行时消费半边如实标注待①。

**Architecture:** Lane A（插件实现+单测）与 Lane B（激活冒烟脚本 scripts/verify-dsh-skills.mjs，模式同 verify-dsh-guard：密钥缺失仍可跑激活验证——本脚本**不需要**密钥）不相交；Task 3 真实激活验证+证据+终审推送。版本 0.4.8。

**Tech Stack:** 仓库现状（零依赖）。

**Spec:** dsh-local-findings.md（插件机制/闭包/激活判定）、批次 4 装载链（registry/install）、host-loading.md §4 第 4 条（本项的边界声明处）。

## Global Constraints

- 沿用全部仓库约束；零付费调用（激活验证=无任务启动，不触发模型）；不读 ~/.dsh；隔离 DSH_HOME。
- 插件遵循既有 dsh.mjs 适配器的模式（Cordis name/inject/apply）；**只读**技能目录与注册表（不写）。
- 诚实分级：本批产出=activation-tested；运行时消费（模型是否遵循技能）待①；host-loading §4 与 FEATURE_MATRIX 同步更新措辞，不升 host_verified。

## Review Focus

1. 插件激活失败语义（apply 抛错仅告警——调研第 2 条）：装载目录缺失/注册表损坏时插件应 fail-closed（不注入）而非崩溃——但宿主只会告警，故插件内自行 try/catch 并降级为「注入空索引+告警日志」还是拒绝激活？裁定：**拒绝激活**（与 dsh.mjs guard 同款——配置错误不该静默继续）。
2. 系统提示注入的体积上限（57 技能全文会爆提示——注入索引+名称/描述，全文按需由工具读取？还是索引 only？裁定：索引 only + 一个只读 read-skill 工具——工具即 dsh 工具注入需 tools 闭包，复杂化；改为索引+指向技能目录路径，模型用其文件工具读）。
3. verify-dsh-skills.mjs 在无密钥环境必须能跑（激活验证不需要模型调用）。

---

### Task 1 (Lane A): src/adapters/dsh-skills.mjs + 单测

**Files:** Create `src/adapters/dsh-skills.mjs`；Test `test/dsh-skills.test.mjs`
- `export const name='gstack861-skills'`、`inject=['tools']`（闭包同 guard——复用 tools 服务）... 裁定修正：系统提示注入应 inject `systemPrompt`（调研：`@deepseek-ai/dsh-system-prompt` 提供 systemPrompt 服务）。**接口以真实宿主为准**：实现按 inject:['systemPrompt'] 或双注入（tools+systemPrompt），以批次 3 冒烟的正控树为基——由计划审查对照 findings 定夺。
- `apply(ctx, config)`：config `{ skillsDir }`（绝对路径，指向 install 链 target）；校验（loadRegistry 语义：注册表存在可解析；目录存在）失败→抛错（拒绝激活，fail-closed）；成功→向 systemPrompt 服务注册一节：技能索引（每技能一行：名称+description 首行+SKILL.md 绝对路径），声明「用文件工具读取全文」。
- 索引构建：读 registry skills 列表→逐个读 `<dir>/manifest.json` 的 name 与 SKILL.md 首个 description 行；任何技能目录损坏→整插件拒绝激活（fail-closed，不部分注入）。
- 单测（离线）：合法装载目录（复用 stage.test/install fixture 构造）→索引文本含全部技能名与路径；目录缺失/注册表损坏/SKILL.md 缺失→抛错零注入；config 缺 skillsDir→抛错。

### Task 2 (Lane B): scripts/verify-dsh-skills.mjs（无需密钥的激活验证）

**Files:** Create `scripts/verify-dsh-skills.mjs`
- 模式同 verify-dsh-guard 的环境搭建（隔离 DSH_HOME、shim 包、最小树含 system-prompt+tools+**本插件**、config.skillsDir 指向由测试渲染树 stage+install 出的真实技能目录）；**无密钥可跑**：taskless 启动（同批次 3 正控 3 模式），exit 0 且无 did-not-activate 警告=通过；负控（坏 skillsDir）→插件激活失败警告出现。0 付费调用断言。
- 本机实跑：正控通过+负控警告出现，输出留证。

### Task 3 (协调者): 真实激活验证、文档、证据、终审、推送
- [ ] 实跑 verify-dsh-skills（正/负控）；host-loading §4 第 4 条更新为「activation-tested（见批次 10b 证据）；运行时消费待 DEEPSEEK_API_KEY」；FEATURE_MATRIX 边界②措辞同步；README 边界节②加一句。
- [ ] VERIFICATION 第十六轮 + 0.4.8 + 摘要 → 终审 → 推送 → CI 绿。
