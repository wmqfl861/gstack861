# 功能与证据矩阵

状态：2026-10-26，M0/M1 基础 + M2 前置批次（任务日志/生成/安装/审批 CLI/DSH 调研）；Windows 离线回归已接入。两个宿主均未获得 `host_verified` 或 `full`。

| 范围 | ZCode | DSH | 已有证据 / 剩余工作 |
|---|---|---|---|
| 固定上游版本 | implemented | implemented | 锁文件 + 固定子模块 |
| 离线回归平台 | contract_tested | contract_tested | Linux 首轮；真实 Windows 本机 86/86 + CI 双平台矩阵 |
| 源技能盘点器 | contract_tested | contract_tested | 临时 Git 仓库实测；完整上游盘点已在真实 Windows 本机跑通（57 技能） |
| 文件范围策略 | contract_tested | contract_tested | 真实临时文件、链接与配置测试 |
| 原生入口 | contract_tested | activation-tested | ZCode 真实 Hook 子进程；DSH 已在本机 0.2.1-rc.3 隔离配置真实加载激活（见调研文档），工具执行级拒绝路径未验证 |
| 技能生成器 | contract_tested | contract_tested | 字节级复制断言、上游漂移拒绝；产物标记 generated-not-host-verified |
| 安装/卸载注册 | contract_tested | contract_tested | 两阶段原子性、用户文件保护、备份回滚均有测试；未接入真实宿主技能目录 |
| 任务持久化/断点恢复 | contract_tested | contract_tested | 状态机、跨进程锁、防篡改；未接宿主执行器 |
| 审批状态 | contract_tested | contract_tested | 真实文件与两个进程单次消费；CLI 操作员通道已接通，宿主内询问 UI 未接通 |
| 自动安装/升级/卸载（宿主级） | planned | planned | ZCode 仅输出配置，不改用户文件；DSH 安装片段需含 system-prompt+tools 闭包（调研结论） |
| 不可绕过的全宿主安全 | blocked | blocked | 启动失败、工具替换、PTC、子 Agent、Shell/OS 隔离；DSH apply() 抛错仅警告且退出码 0（实测），验收须解析警告 |
| 相对路径/Session cwd | contract_tested | blocked | ZCode 用事件 cwd；DSH 暂只接受绝对路径 |
| 规划/规格/需求工作流 | planned | planned | 原生提问、plan mode 与模板 resolver |
| 开发/调查/review | planned | planned | 尚未用真实宿主执行纵向任务 |
| 子 Agent 与工作流恢复 | planned | planned | 核心日志已就绪；执行器、取消、恢复接线未做 |
| 独立模型复核 | planned | planned | 显式模型配置、隔离上下文、授权 |
| 浏览器/QA/设计 | planned | planned | 复用上游工具并迁移依赖 |
| ship/部署/监控 | planned | planned | 审批、测试证据与幂等边界 |
| 文档/记忆/GBrain | planned | planned | 对应原生工具与会话路径 |
| CSO/iOS/远程等专项 | planned | planned | Docker/设备/账号等依赖验收 |
| 真实模型质量对等 | not_run | not_run | 未调用模型，未使用预算 |

`contract_tested` 不是 `host_verified`。源码盘点仅枚举顶层源技能，不涵盖全部命令选项、独立二进制和生命周期语义；`fullParity` 固定为 false，避免空集合或局部盘点误报完整支持。macOS 仍未运行，不声明通过；CI 结果以 GitHub Actions 实际运行为准。
