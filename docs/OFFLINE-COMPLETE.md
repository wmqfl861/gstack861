# 蓝图剩余项终版逐项盘点（OFFLINE-COMPLETE）

截至 2026-10-28（批次 18 / 0.4.17 进行中，本清单随本批合并落盘）对 BLUEPRINT 全部剩余项的逐项判定。**结论：离线余量显式存在——纯工具二进制移植与原生迁移工具（第二节）列为后续批次工作，本清单不宣称"离线已尽"。** 其余剩余项分两类：待用户解锁（第一节，每项给出精确触发方式）与环境受阻（第三节，每项一句"缺什么"）。已完成项的证据入口见文末交叉引用；本清单不新增任何"完成"宣称，一切分级以 `docs/FEATURE_MATRIX.md` 为准。

判定基线：BLUEPRINT M2–M4 + FEATURE_MATRIX 全部 planned/blocked 行 + README「离线边界」节 13 项 + 批次 18 审计划逐行复核补洞。上游事实以固定子模块 `upstream/gstack`（commit 5755601，v1.91.248.0）实测为准——`bin/` 目录已逐一检视（见第二节所列实际名字）。

## 一、待用户解锁

### 1. ③ ZCode 受控会话 + 自动拾取 + 容忍度

- **是什么**：在真实 ZCode **新会话**内验收 guard 层范围保护、渲染技能自动拾取（新会话未显式引用即生效）与 Hook 容忍度（启动失败/超时/与其他 Hook 的顺序）。
- **为什么需要你**：「新会话自动拾取」与「容忍度」的事件源只存在于真实宿主会话生命周期内，离线脚本无法模拟；且涉及你本人的宿主配置与用户文件保护边界。
- **精确触发方式**：
  1. `node scripts/acceptance-pack.mjs --out <绝对目录>`——一键生成受控验收包：git 初始化的 fixture 工作区（含可编辑 `src/notes.md`）、经真实 `loadPolicy` 自校验并以 0600 落盘的样例策略、待人工合并的 Hook 片段（`hook-snippet.json`）、逐字引用 `zcode-acceptance.md` §5/§6 与 `host-loading.md` §2.4 清单的 `STEPS.md`。包内全部路径已烘焙，生成后不可移动（移动即失效，需重新生成）。
  2. 需要完整 stage→install 装载链时用三参变体：`node scripts/acceptance-pack.mjs --out <绝对目录> --rendered <渲染产物目录> --manifest <manifest 文件> --host zcode`——额外把渲染技能经标准链装入 fixture 工作区 `.zcode/skills/`。
  3. 在 fixture 工作区开一个**新的 ZCode 会话**，按 `STEPS.md` 逐项验收（清单已把手工验收手册原句与真实绝对路径代入），把勾选结果与 doctor 输出发回。
- **触发后做什么**：FEATURE_MATRIX ③ 相关行（「技能渲染（上游管线 CI 复用）」「原生入口」「审批状态」）升级评估；`bin/gstack861.mjs doctor` hosts 面评估；本节第 3/4 项（④ 与宿主级安装类）随之可排。

### 2. ⑨ model-review runtime 真调用

- **是什么**：独立模型复核的 runtime 半边——对真实网关发起**恰好一次**模型复核调用（机制半边已就绪：批次 11 五段就绪验证全绿）。
- **为什么需要你**：真调用消耗付费预算；网关配置与密钥必须由你亲手放置（配置在工作区外、键只引用环境变量名——模型不可触达），项目纪律绝不替用户发起付费调用。
- **精确触发方式**（批次 18 Lane C 落地的真调用入口，同批合并）：
  1. 亲手放置网关配置文件（工作区**外**，建议权限 0600）。schema（`src/gateway.mjs` `loadGateway`，fail-closed）：`schemaVersion=1`；`baseUrl` 仅限自定义 **https** 网关（官方端点由 loadGateway 黑名单拒绝，无付费回退路径）；`apiKeyEnv` 为键所在环境变量名（须匹配 `^[A-Z_][A-Z0-9_]*$`；配置只引用名字，绝不包含键值）；`model`（非空，≤128 字符）；`maxTokens`（1–8192 整数）；`note` 可选。
  2. 把密钥 export 到配置 `apiKeyEnv` 所指的环境变量；设 `GSTACK861_MODEL_CALL=1`。
  3. 运行 `node scripts/verify-model-review.mjs --gateway-config <配置绝对路径>`。
  - 红线（由测试钉死）：无 `GSTACK861_MODEL_CALL=1` → exit 2 且零网络；键缺失 → exit 2 且零网络；键值只从环境变量进请求头（永不打印、永不落盘）；单次调用封顶（每次运行恰好一个请求）；输出只打印配置路径与 baseUrl 主机，不打印键/模型/maxTokens。退出码：0 = 单次调用完成且判定解析；1 = 配置被 loadGateway 拒绝或调用失败（结构化错误码）；2 = 受阻。离线自测变体 `--self-test-loopback <端口>`（仅测试用）经同一 loadGateway 校验后把单次调用指向本机回环。已知残余：自定义网关反向代理官方端点在配置层不可检测。
- **触发后做什么**：FEATURE_MATRIX「独立模型复核」行 mechanism-ready → runtime 升级评估；真实模型质量对等（第三节末项）随之具备两前提之一。

### 3. ④ 宿主内嵌询问/审批 UI + ⑩⑪宿主内执行器中断/子 Agent 接线：需宿主侧会话/API（同③触发场景）。
3b. **③-guard：已完成（批次 27）**——桌面三探针全过（src 放行/outside 拒绝/.git 拒绝，deny 为规范 hookSpecificOutput 载荷）；Bash 通道为声明边界；STEPS §4 E/F/G/H（fail-closed/超时/updatedInput 共存/回滚）为遗留项，需时按 zcode-acceptance.md §6 逐项执行。

- **是什么**：宿主进程内的询问/审批 UI 接通（区别于已接通的操作员 CLI `approvals ask`）；宿主内执行器中断源、子 Agent 继承与恢复接线（README 边界④⑩）。
- **为什么需要你**：事件源在宿主进程内（宿主侧会话/API），仓库代码无法自行产生。
- **精确触发方式**：同 ③ 触发场景——受控 ZCode（或 DSH）宿主会话内按清单执行；具体清单随该批计划给出。
- **触发后做什么**：FEATURE_MATRIX「审批状态」「原生询问桥」「子 Agent 与工作流恢复」行的 planned 半边升级评估。

### 4. 宿主级自动安装/升级/卸载

- **是什么**：ZCode 侧宿主级的自动安装/升级/卸载（当前 ZCode 仅输出配置、不改用户文件；DSH 安装片段需含 system-prompt+tools 闭包——调研结论）。
- **为什么需要你**：须在 ③ 的受控会话内对真实宿主技能目录验收，含升级失败回滚与用户文件保护（蓝图 M4 项）。
- **精确触发方式**：待 ③ 受控会话（本节第 1 项）。
- **触发后做什么**：FEATURE_MATRIX「自动安装/升级/卸载（宿主级）」行升级评估。

### 5. DSH 键控预算类消费（careful/freeze/cso 安全组 + 设计组）

- **是什么**：渲染技能消费的延续——与既有 15 例消费计划同款方法论（装载技能 → 真实任务消费 → 降级/验证门槛按技能原文执行 → 边界如实记录），候选覆盖安全组 `careful`/`freeze`/`cso` 与设计组 `design-consultation`/`design-shotgun`/`design-html`/`design-review`/`devex-review`（目录名以固定上游实测）。
- **为什么需要你**：需要密钥与预算批准。项目纪律：默认 0 密钥/批，累计键控运行 12 次（截至批次 16；批次 17/18 均零新增），逐批计划明示上限。
- **精确触发方式**：与既有键控纵向同款约束——密钥只进子进程 env、提示词 ≤200 字符 throw-before-launch 红线；具体任务集与上限由该批计划定义。此类**无需 ③**（DSH 键控即可推进），故独立于第 1 项单列。
- **触发后做什么**：消费计数与 FEATURE_MATRIX「浏览器/QA/设计」「文档/记忆/GBrain」「CSO/iOS/远程等专项」相关行按实测升级。

## 二、离线余量（批次 19 起逐项收口，不宣称已尽）

批次 19 对固定子模块（5755601）`bin/` 实名二进制完成全量前提审计并落盘如下；批次 20 收口其中两项（banned-terms → ported、team-init → mapped，双 lane 并行）。判定口径：**ported**=已移植；**covered**=本项目已有等价实现；**N/A**=前提属本项目不支持的宿主；**mapped**=语义映射为本项目原生工具；**deferred**=留独立批次集中做。**3 项 deferred 仍是离线余量——本清单不宣称"离线已尽"。**

| 二进制 | 规模 | 判定 | 依据（一句话） |
|---|---|---|---|
| `gstack-jsonl-merge` | 105 行 bash | **ported**（批次 19 Lane B） | 零前提、宿主无关的 git merge driver（拼接去重 + ts 排序 + sha256 兜底）；移植为 `bin/gstack861-jsonl-merge.mjs`（零依赖 Node，侧对称逐字节钉死于 `test/jsonl-merge.test.mjs`）；上游内嵌 python3 前提由移植消除 |
| `gstack-patch-names` | 34 行 | **covered** | name: 前缀改写已在渲染链解决（`src/stage.mjs` renderedDir 前缀映射，render 链实测）；其 unprefix 方向对本项目是死路径 |
| `gstack-paths` | 160 行 | **N/A** | 前提=Claude 插件运行时环境（CLAUDE_PLUGIN_DATA / ~/.claude/plans 链）；本项目状态根为显式绝对 `--state`（安全设计：模型不可写工作区外），移植=为不支持的宿主发明需求 |
| `gstack-migrate-claude-code` | 20+270 | **mapped** | 语义属上游安装域（重命名上游在其他宿主的技能安装）；映射为本项目原生 `migrate-state`（批次 19 Lane A，偿还本项目自己的 0.3.1 状态命名空间断裂债务） |
| `gstack-slug` | 880+147+109 | **ported**（批次 21，两段+薄 CLI） | remote-identity 27 向量金样回放；身份解析 v2 缓存零 git spawn；checkpoint 簿记活体上游对照 41/41 原语字节相等；状态根映射 ~/.gstack861（绝不触碰 ~/.gstack） |
| `gstack-redact` | 341+1075+817（CLI+patterns+引擎） | 扫描核心 **本批完成**（批次 22） | patterns 1075+engine 817 零依赖移植，上游 9 个测试文件向量回放；CLI 扫描路径同批；hook install/uninstall 子命令不在本批——整支 binary 未全量移植，随下行 prepush 批 deferred |
| `gstack-redact-prepush` | 790+27 | **deferred**（独立批次） | 连带闭包：CLI hook install/uninstall + `lib/fs-utils` mkdirpSync（27 行，随 prepush 批）。特征：pre-push stdin refs 解析、remote..local 增行扫描、新分支 merge-base 回退、删分支跳过、force-push 净新增语义、`GSTACK_REDACT_PREPUSH=skip` 旁路、guardrail 非 enforcement；另依赖 `lib/state-root` 与 `lib/sealed-guard`；上游有 5 个专属测试文件（prepush-{emails,hook,rebase-force-push,scan-range,target}） |
| `gstack-issue-links` | 202+188+98+117 | **ported**（批次 24：lib 纯分类逐字+两 bin+tracker-guard 信封；上游 ship-issue-intent 13 向量+tracker-guard 14 向量适配，gh 缺失极性双腿可测） |
| `gstack-banned-terms` | 90 行 | **ported**（批次 20 Lane A） | 宿主无关、零依赖 Node 移植为 `bin/gstack861-banned-terms.mjs`（`check|init|validate` 三命令；`.gstack/banned-terms.json` 词表在 diff 新增行扫描 + 允许路径豁免；退出码 0/1/2/3 对齐上游 ok/fail/usage/refused） |
| `gstack-team-init` | 269 行 | **mapped**（批次 20 Lane B） | Claude 专属面（CLAUDE.md、.claude/settings.json+check-gstack.cjs、vendored 迁移）不逐字移植：映射为 `gstack861 team-init {optional|required} [--root DIR]`——AGENTS.md 段（宿主侧约定[验收项]标注）+ 复用既有 zcode PreToolUse 接线（zcode-config）与 DSH guard profile 指引，不发明新 hook 文件；幂等 grep-skip；`--root` 显式绕过 git（记录在案的映射差异） |

原清单其余两条随本表收口：原生迁移工具即上行 **mapped**（`migrate-state` 批次 19 落地）；命令别名（蓝图 M3 生命周期组）不在二进制审计面内，仍为离线余量，可随装载/迁移先例离线先行。

## 三、环境受阻（每项一句"缺什么"）

- **⑥ 浏览器 QA/scrape 组**——缺真实浏览器栈（Chromium 与驱动）。
- **⑦ iOS 组**——缺 iOS 设备与配套工具链。
- **⑧ ship/canary/deploy 远端**——缺远端部署/监控目标（验收对象本身）。
- **macOS（README 边界⑬ 多 OS 矩阵部分）**——无 Mac；CI 无 macOS 腿且不加付费腿。
- **make-pdf/diagram/浏览器类二进制（README 边界⑫）**——缺视觉/图像模型与重浏览器前提（上游 `make-pdf/`、`diagram/` 产物链；本项目已按其原文以降级/BLOCKED 如实消费）。
- **DSH 相对路径/Session cwd（FEATURE_MATRIX「相对路径/Session cwd」行）**——缺真实宿主 Session cwd 事件源（相对路径语义与继承的验收前提）。
- **⑤ GBrain 真接入**——前置 ③（①② 已完成）。
- **真实多进程 SIGKILL 竞争**——缺可注入真实 SIGKILL 时序的受控环境；单机模拟与双进程锁竞争已实证（既有 start 竞争测试 + 批次 18 reap/heartbeat 竞争序集断言；以批次 18 实测为准）。
- **真实模型质量对等（FEATURE_MATRIX「真实模型质量对等」行）**——需 ③ + ⑨ + 预算（双宿主真模型对拍）。

## 交叉引用与证据入口

- 功能状态权威表：`docs/FEATURE_MATRIX.md`（本清单各项均标注对应行）；边界 13 项：README「离线边界」节。
- 验证脚本总表：`docs/VERIFICATION-SCRIPTS.md`（10 脚本；三方一致性由 `test/verification-scripts.test.mjs` 钉死）。
- 逐轮验证记录：`docs/VERIFICATION.md`（截至批次 17 共 25 轮；批次 18 为第二十六轮，合并后落盘）。
