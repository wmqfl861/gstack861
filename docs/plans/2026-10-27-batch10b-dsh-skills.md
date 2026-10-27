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
- `export const name='gstack861-skills'`、`export const inject=['systemPrompt']`（**单一 inject**，计划审查经 asar 源码核实：`dsh-system-prompt` 提供 `SystemPrompt` 服务，`section({name,order,text,interpolate})` 为其对外加性 API，README 明示外部贡献可用任意有限 order；不注入 tools、不注册工具）。机制裁定全文已录入 dsh-local-findings.md 日期附录。
- `apply(ctx, config)`：先特性检查 `typeof ctx?.systemPrompt?.section !== 'function'` → 抛 `DSH_SYSTEM_PROMPT_SECTION_REQUIRED`（同 dsh.mjs guard 形状）；再校验 config.skillsDir（绝对、存在）与注册表（**复用 install.mjs 的 loadRegistry——导出之**；不可解析/缺失→抛错拒绝激活）；逐技能校验：目录、manifest name、SKILL.md 存在且 **sha256 与注册表记录一致**（注册表=信任锚，诚实 fail-closed）；SKILL.md 缺 description 行→空描述照列（结构性损坏才拒）。任何失败→抛错（宿主转为警告+exit 0，findings 第 2 条）。成功→ `return ctx.systemPrompt.section({ name:'gstack861:skills', order:3050, text:<索引>, interpolate:false })`（返回 disposer，同 guard 模式；interpolate:false 消除未知 {{var}} 装配期异常类；order 3050=宿主 SECTION_ORDERS 的 TOOL_COMPUTER_USE(3000) 与 MCP_SERVERS(3100) 之间）。索引：每技能一行（名称+描述+SKILL.md 绝对路径）+ 头部声明「用你的文件工具读取全文」。
- 索引构建：读 registry skills 列表→逐个读 `<dir>/manifest.json` 的 name 与 SKILL.md 首个 description 行；任何技能目录损坏→整插件拒绝激活（fail-closed，不部分注入）。
- 单测（离线，fixture 于 test/dsh-skills.test.mjs 本地构造——含 description 与缺 description 两形态）：合法装载目录→section 调用参数（name/order/interpolate:false）与索引文本含全部技能名/路径/描述；目录缺失/注册表损坏/SKILL.md 缺失/**SKILL.md 摘要与注册表不符**→抛错零注入（fake-ctx 模式，见 test/adapters.test.mjs:329）；config 缺 skillsDir/相对路径→抛错。

### Task 2 (Lane B): scripts/verify-dsh-skills.mjs（无需密钥的激活验证）

**Files:** Create `scripts/verify-dsh-skills.mjs`
- 环境件**只复用** verify-dsh-guard 的 dshInstall()/childEnv()/shim/清理纪律；profile **手工构建**（findings 冒烟的 gstacksmoke 模式：package.json `dsh.profile.bundles:[]`+dependencies、cordis.yml `[]`、patch 三/四条目 system-prompt+tools+gstack861-skills[+guard 共存项]）——**禁用 `--from-default-profile headless`**（拒绝 taskless 启动）且**禁止为绕过而加任务**（破坏无密钥/0 付费前提）。**无密钥可跑**：taskless 启动，输出两流均无 did-not-activate 警告且 exit 0=通过；负控①坏 skillsDir→激活失败警告出现；负控②删 system-prompt 条目→插件 pending（waiting for service: systemPrompt，证明 inject 声明真实非虚设）。0 付费调用断言（无任务文本、无 LLM 插件、遥测关闭）。
- 本机实跑：正控通过+负控警告出现，输出留证。

### Task 3 (协调者): 真实激活验证、文档、证据、终审、推送
- [ ] 先回填批次 10a 的第十五轮（其 VERIFICATION 段漏写，证据 JSON 已在）；实跑 verify-dsh-skills（正控+双负控）；host-loading §4 第 4 条→「activation-tested（见批次 10b 证据）；运行时消费待①，且届时 readRoots 须覆盖技能目录否则运行时测试假失败」；FEATURE_MATRIX「渲染技能宿主消费」DSH 列 planned→activation-tested（运行时消费caveat）；README 边界②措辞更新（机制已验证至激活级=离线；运行时消费归①）并与「离线空间已尽」句协调（如 10a 先例：注明本批为解锁助具性质的重开）。
- [ ] VERIFICATION 第十六轮 + 0.4.8 + 摘要 → 终审 → 推送 → CI 绿。
