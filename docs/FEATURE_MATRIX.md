# 功能与证据矩阵

状态：2026-10-27，0.4.10：M2 前置 + 纵向批次 + 批次 2–12a（状态目录命名空间、上游渲染 CI 复用 rendered-experimental、原生询问桥 approvals ask、apply-patch/参数 effect、approvals/tasks CLI 全量、ZCode 工作流层纵向流程已实证、渲染产物 stage-render→install→uninstall 装载链全链实测、宿主装载 runbook 实测回填、渲染技能宿主消费 15 例已实证、install --dry-run 零写入预检；DSH 管线就绪脚本待密钥）；离线空间已尽（2026-10-27），剩余项均受阻于用户解锁或环境（README 离线边界节 13 项）。两个宿主均未获得 `host_verified` 或 `full`。

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
| 不可绕过的全宿主安全 | blocked | blocked | 启动失败、工具替换、PTC、子 Agent、Shell/OS 隔离；DSH apply() 抛错仅警告且退出码 0（实测），验收须解析警告 |
| 相对路径/Session cwd | contract_tested | blocked | ZCode 用事件 cwd；DSH 暂只接受绝对路径 |
| 技能渲染（上游管线 CI 复用） | rendered-experimental | rendered-experimental | CI 渲染成功（run 40464085183）；0.4.1 起装载链接通：stage-render→install→uninstall 全链实测（多文件技能含 registry 锚定摘要）；0.4.2 fixture 工作区 `.zcode/skills` 装载实测（runbook §2.2/2.3/2.5 回填）；不宣称 conformance/full；新会话自动拾取待用户受控会话解锁 |
| 渲染技能宿主消费 | workflow-evidence | activation-tested | 15 例已实证（+context-save/context-restore/diagram/make-pdf——后两者 BLOCKED/降级按其原文如实）：上下文注入消费、方法论遵循、技能自带降级与验证门槛执行（deslop 零候选为门槛正确运转）、语义审查真实拦截（spec flagged）、机制差距如实记录（见五份消费证据文档）；自动拾取未验证，非 host_verified |
| 原生询问桥 | implemented | implemented | `approvals ask` 阻塞式应答（exit 3 不自动同意）；宿主内嵌 UI 未接通 |
| 纵向流程（spec→ship） | workflow-evidence | planned | ZCode 侧六阶段+审批+交付已真实跑通（见 verification-2026-10-27-vertical-zcode.md，非 host_verified）；DSH 侧待密钥 |
| 开发/调查/review | planned | planned | 尚未用真实宿主执行纵向任务 |
| 子 Agent 与工作流恢复 | planned | planned | 核心日志已就绪；执行器、取消、恢复接线未做 |
| 独立模型复核 | mechanism-ready | mechanism-ready | 配置加载/黑名单/单次封顶/开关红线全部实测（批次 11，五段就绪验证）；runtime 真调用待解锁-⑨（用户手放网关配置+开关+键） |
| 浏览器/QA/设计 | planned | planned | 复用上游工具并迁移依赖 |
| ship/部署/监控 | planned | planned | 审批、测试证据与幂等边界 |
| 文档/记忆/GBrain | planned | planned | 对应原生工具与会话路径 |
| CSO/iOS/远程等专项 | planned | planned | Docker/设备/账号等依赖验收 |
| 真实模型质量对等 | not_run | not_run | 未调用模型，未使用预算 |

`contract_tested` 不是 `host_verified`。源码盘点仅枚举顶层源技能，不涵盖全部命令选项、独立二进制和生命周期语义；`fullParity` 固定为 false，避免空集合或局部盘点误报完整支持。macOS 仍未运行，不声明通过；CI 结果以 GitHub Actions 实际运行为准。
