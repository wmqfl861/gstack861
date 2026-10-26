# 功能与证据矩阵

状态：2026-10-26，M0/M1 基础开发。两个宿主均未获得 `host_verified` 或 `full`。

| 范围 | ZCode | DSH | 已有证据 / 剩余工作 |
|---|---|---|---|
| 固定上游版本 | implemented | implemented | 锁文件 + 固定子模块 |
| 源技能盘点器 | contract_tested | contract_tested | 临时 Git 仓库实测；完整上游盘点在 CI 中另跑 |
| 文件范围策略 | contract_tested | contract_tested | 真实临时文件、链接与配置测试 |
| 原生入口 | contract_tested | contract_tested | ZCode 真实 Hook 子进程；DSH guard 接口替身，不是宿主集成 |
| 自动安装/升级/卸载 | planned | planned | ZCode 仅输出配置，不改用户文件；DSH 仅提供插件入口 |
| 审批状态 | contract_tested | contract_tested | 真实文件与两个进程单次消费；未接宿主 UI |
| 不可绕过的全宿主安全 | blocked | blocked | 启动失败、工具替换、PTC、子 Agent、Shell/OS 隔离 |
| 相对路径/Session cwd | contract_tested | blocked | ZCode 用事件 cwd；DSH 暂只接受绝对路径 |
| 规划/规格/需求工作流 | planned | planned | 原生提问、plan mode 与模板 resolver |
| 开发/调查/review | planned | planned | 尚未用真实宿主执行纵向任务 |
| 子 Agent 与工作流恢复 | planned | planned | 执行器、取消、状态、恢复与去重 |
| 独立模型复核 | planned | planned | 显式模型配置、隔离上下文、授权 |
| 浏览器/QA/设计 | planned | planned | 复用上游工具并迁移依赖 |
| ship/部署/监控 | planned | planned | 审批、测试证据与幂等边界 |
| 文档/记忆/GBrain | planned | planned | 对应原生工具与会话路径 |
| CSO/iOS/远程等专项 | planned | planned | Docker/设备/账号等依赖验收 |
| 真实模型质量对等 | not_run | not_run | 未调用模型，未使用预算 |

`contract_tested` 不是 `host_verified`。源码盘点仅枚举顶层源技能，不涵盖全部命令选项、独立二进制和生命周期语义；`fullParity` 固定为 false，避免空集合或局部盘点误报完整支持。
