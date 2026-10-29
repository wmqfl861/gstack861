# 功能与证据矩阵

状态：2026-10-28，0.4.18：M2 前置 + 纵向批次 + 批次 2–19（+ migrate-state 关闭 0.3.1 命名空间债务 + jsonl-merge 零依赖移植 + 二进制全量前提审计落盘）（状态目录命名空间、上游渲染 CI 复用 rendered-experimental、原生询问桥 approvals ask、apply-patch/参数 effect、approvals/tasks CLI 全量、ZCode 工作流层纵向流程已实证、渲染产物 stage-render→install→uninstall 装载链全链实测、宿主装载 runbook 实测回填、渲染技能宿主消费 15 例已实证、install --dry-run 零写入预检）；除纯工具二进制移植/原生迁移工具等离线余量（OFFLINE-COMPLETE §二：第一波已于批次 19 落地——migrate-state+jsonl-merge；余 slug/redact 等 5 项 deferred，后续批次）外，其余受阻于用户解锁或环境（OFFLINE-COMPLETE 三分类）。两个宿主均未获得 `host_verified` 或 `full`。

| 范围 | ZCode | DSH | 已有证据 / 剩余工作 |
|---|---|---|---|
| 固定上游版本 | implemented | implemented | 锁文件 + 固定子模块 |
| 离线回归平台 | contract_tested | contract_tested | Linux 首轮；真实 Windows 本机 86/86 + CI 双平台矩阵 |
| 源技能盘点器 | contract_tested | contract_tested | 临时 Git 仓库实测；完整上游盘点已在真实 Windows 本机跑通（57 技能） |
| 文件范围策略 | contract_tested | contract_tested | 真实临时文件、链接与配置测试 |
| 原生入口 | contract_tested | pipeline-verified（单次密钥运行） | ZCode 真实 Hook 子进程；DSH 隔离加载激活已实证，管线级拒绝路径有就绪脚本（`scripts/verify-dsh-guard.mjs`，待 DEEPSEEK_API_KEY） |
| 技能生成器 | contract_tested | contract_tested | 字节级复制断言、上游漂移拒绝；产物标记 generated-not-host-verified |
| 安装/卸载注册 | contract_tested | contract_tested | 两阶段原子性、用户文件保护、备份回滚均有测试；未接入真实宿主技能目录 |
| 安装/卸载 dry-run 预检 | contract_tested | contract_tested | contract_tested（批次 6）：`install --dry-run` 校验+报告（wouldInstall/wouldSkip/wouldBackUp）结构性零写入，拒绝照常抛错；未接入真实宿主技能目录 |
| 任务持久化/断点恢复 | contract_tested | contract_tested | 状态机、跨进程锁、防篡改；未接宿主执行器 |
| 审批状态 | contract_tested | contract_tested | 真实文件与两个进程单次消费；CLI 操作员通道已接通，宿主内询问 UI 未接通 |
| 自动安装/升级/卸载（宿主级） | planned | planned | ZCode 仅输出配置，不改用户文件；DSH 安装片段需含 system-prompt+tools 闭包（调研结论） |
| 不可绕过的全宿主安全 | blocked | blocked | 多调用一致性已单次密钥实证（批次 13）；启动失败、工具替换、PTC、子 Agent、Shell/OS 隔离仍待；DSH apply() 抛错仅警告且退出码 0（实测），验收须解析警告 |
| 相对路径/Session cwd | contract_tested | blocked | ZCode 用事件 cwd；DSH 暂只接受绝对路径（Session cwd 语义与继承待真实宿主事件源——环境受阻） |
| 技能渲染（上游管线 CI 复用） | rendered-experimental | rendered-experimental | CI 渲染成功（run 40464085183）；0.4.1 起装载链接通：stage-render→install→uninstall 全链实测（多文件技能含 registry 锚定摘要）；0.4.2 fixture 工作区 `.zcode/skills` 装载实测（runbook §2.2/2.3/2.5 回填）；不宣称 conformance/full；新会话拾取：**工作区技能发现+Skill 装载已 host 级实证（批次 25 无头真实会话，标记逐字）**；上下文自动注入/UI 会话仍未验证 |
| 渲染技能宿主消费 | workflow-evidence | runtime-consumption-verified+security-slices | 安全组 careful/freeze/cso 能力切片消费（批次 29-30）； 15 例已实证（+context-save/context-restore/diagram/make-pdf——后两者 BLOCKED/降级按其原文如实）：上下文注入消费、方法论遵循、技能自带降级与验证门槛执行（deslop 零候选为门槛正确运转）、语义审查真实拦截（spec flagged）、机制差距如实记录（见五份消费证据文档）；自动拾取未验证，非 host_verified |
| 原生询问桥 | implemented | implemented | `approvals ask` 阻塞式应答（exit 3 不自动同意）；宿主内嵌 UI 未接通 |
| 纵向流程（spec→ship） | workflow-harness-verified | ship-vertical-verified | ZCode 侧六阶段+审批+交付曾真实跑通（非 host_verified）；批次 16 增机器可检离线 harness（offline-workflow-journal-harness：六阶段 CLI 记账+review 恢复腿+审批门控 ship+策略腿，零模型调用）；DSH 侧 spec→implement→qa+TaskStore 记账 vertical-verified（批次 13）；ship+审批集成 vertical-verified（批次 14）；**恢复纵向 reap→resume 键控单次运行通过（批次 16：崩溃模拟→收割→恢复→密钥任务终态正确 attempts=2）** |
| 开发/调查/review | planned | vertical-slice-verified | DSH 侧为**生命周期能力切片**键控实证（批次 13/14/16：逐字标记读、精确单写、回读校验、ship 负控+审批门、崩溃→收割→恢复复跑）——**非** /investigate、/review 技能方法论消费（两宿主均未跑）；ZCode 列仍 planned 待③ |
| 子 Agent 与工作流恢复 | store-recovery-verified | store-recovery-verified | 批次 15 共享核 store+CLI 离线实证：租约/心跳/收割/重排（陈旧租约清除、收割↔心跳锁内竞争）、审批取消矩阵+cancelWorkflow 故障安全顺序（先拒审批后取消）；批次 16 DSH 恢复纵向键控单次运行通过（崩溃模拟→reap→resume→密钥任务 completed attempts=2）；宿主内执行器接线仍 planned（待③/后续）；双进程锁竞争已实证（既有 start 竞争测试 + 批次 18 reap/heartbeat 竞争序集断言；真实 SIGKILL 竞争仍环境受限）（批次 18 实测：15 次真双进程 reap/heartbeat 竞争全部恰一 exit 0，胜者分布 reap 6 / heartbeat 4，四种合法"胜者×败者码"组合均出现；成果审查独立复测 10/10 恒一胜者） |
| 独立模型复核 | mechanism-ready | mechanism-ready | 配置加载/黑名单/单次封顶/开关红线全部实测（批次 11，五段就绪验证）；runtime-verified（批次 28 单次真调用：本机显式网关，操作员在用户持续授权下放置配置；单次封顶独立证实；详 OFFLINE-COMPLETE §一2）|
| 浏览器/QA/设计 | planned | keyed-slice-consumed | design-review 经 DSH index→read 消费实证（批次 29 能力切片：装载→注入→真实读，非方法论消费）；设计组余 4 技能属键控预算类（密钥即可推进）；浏览器/QA 组受阻于浏览器栈 |
| ship/部署/监控 | planned | vertical-slice-verified | 纵向切片实证（批次 14 DSH：审批门+特权发布+单次消费）；真实部署/监控交付仍 planned（审批、测试证据与幂等边界） |
| 文档/记忆/GBrain | planned | planned | 对应原生工具与会话路径；learn/retro/document-generate 已实证消费（15 例计数内，批次 6 safety-suite），document-release 未消费，GBrain 前置③ |
| CSO/iOS/远程等专项 | planned | planned | Docker/设备/账号等依赖验收；cso 已能力切片消费（批次 30，非方法论）；iOS/远程受阻于设备/远端 |
| 真实模型质量对等 | not_run | not_run | 未调用模型，未使用预算 |

`contract_tested` 不是 `host_verified`。源码盘点仅枚举顶层源技能，不涵盖全部命令选项、独立二进制和生命周期语义；`fullParity` 固定为 false，避免空集合或局部盘点误报完整支持。macOS 仍未运行，不声明通过；CI 结果以 GitHub Actions 实际运行为准。
