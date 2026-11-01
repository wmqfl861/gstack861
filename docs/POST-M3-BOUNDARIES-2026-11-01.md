# POST-M3 边界与下一轮计划 — 2026-11-01（交付 B 批 2）

> 基线：`work/m3-post-integration-hardening-20261101`（A=PR #4 之上）。本文承接
> docs/INTEGRATION-2026-11-01.md §8 与 LOCAL-M3-HANDOFF §5，记录 B4/B5 环境判定、
> ZC-07/sweep 边界（B6）、渲染证据分层与 /investigate、/review 下一轮计划（B7）。

## 1. B4：真实 DSH 原生文件工具零模型验收 — not_run（附执行前置）

上轮真实宿主验收（cce238ac，DSH0.2.1-rc.3 ASAR carrier）驱动的是
`tools.register + ToolRuntime.execute` 的 **fixture_write/read**；run-guide 原文
明确 "It does not establish native file tools, model consumption…"。本轮红线
（不启动宿主）使 ASAR 内建文件工具探测无法进行；fixture 工具证据继续保留原名，
不改称原生工具证据。下次授权轮执行前置：
1. 确认 DSH 安装仍在位（版本与 ASAR 锚点对齐 host-feasibility.md）；
2. 在隔离 carrier 内探测内建文件工具的注册 ID 与**无模型会话**直接执行语义；
3. 复用上轮五重隔离 fixture（独立 DSH_HOME/USERPROFILE/cwd、tripwire 生效）；
4. 断言集合：合法读写、工作区外写拒绝、`.git`/config 受保护路径拒绝、运行中
   策略损坏→拒绝、拒绝后工具主体 0 执行与哨兵字节不变；
5. 若原生执行必须创建模型会话或读取用户凭据 → 升级为 BLOCKED 并记录证据。

## 2. B5：ZCode 隔离宿主验收 — BLOCKED（沿用上轮，未变）

依据 zcode/host-feasibility.md：config loader 在环境覆盖生效前读取默认路径且可
持久化自动迁移写入（zcode.cjs:2180/2181 锚点）；`ZCODE_STORAGE_DIR` 不改用户
配置路径；无受支持的用户级隔离 override。仅重定向 HOME/USERPROFILE 不构成充分
隔离。最小授权需求：disposable Windows 账户/VM，或 ZCode 官方支持的用户级配置
隔离。获得前不启动默认宿主；CLI 协议子进程证据不提升为真实宿主证据；不为通过
测试授予用户生产工作区信任。

## 3. B6：ZC-07 与线性 sweep——保持 OPEN（威胁模型细化）

**威胁模型**：同用户攻击者可在「路径已通过验证」与「该路径被实际用于 I/O」
之间的最终 syscall 窗口内替换目标（文件或目录，恢复相同身份外观）。

- 可观察面（现有实现已覆盖，有回归）：写前每次 `assertPlainPathUnchanged` 全链
  身份复验（witness 逐条独立打开比对）；期望缺失保持缺失；nlink/symlink/控制
  字符/`..` 拒绝；write fd 的 `assertPlainFileDescriptor` 双向绑定；清理的 digest
  所有权。
- 不可观察面（残余窗口）：两次复验之间**完全恢复**的替换（同 dev/ino 外观）——
  线性 sweep 已把复验压到每次写前（f4d1bd3 批准的时序权衡），但打开与 use 之间
  的最终 syscall 原子性超出 portable Node 可证明范围。
- 候选方案（仅评估，本轮不实施、不引入原生扩展/重写；任何采用需独立设计审核）：
  1. OS 原子重命名布局（写入临时名+原子 rename）——把「路径使用」缩到单次
     rename syscall；评估点：Windows 目录语义、跨设备、清理路径。
  2. 句柄约束布局（全程 fd 相对 I/O）——Node 无可移植 openat；评估点：需要原生
     绑定或放弃可移植性。
  3. 宿主/OS 隔离边界（受管运行时内同用户不可并发）——把威胁降为跨用户，交给
     运行环境；评估点：与 §1/§2 的隔离授权同一前置。
- 结论：ZC-07 维持 OPEN；本轮 B1 补齐的 witness close-fault 回归属可观察面加固，
  不改变上述边界。

## 4. B7：渲染证据分层与下一轮计划

**渲染证据**：托管 `render-upstream` 已在 PR #4 两个 run（push 41271155176 /
pull_request 41271199633，head c9e76f7）实际执行且 success，产物锚定
upstream.lock 的 `5755601`；本地 Windows 未安装 Bun 且渲染入口按设计仅限 CI
执行策略——本地未渲染、不以 CI=true 伪造。两层层级互不替代。

**/investigate 与 /review 下一轮可执行计划**（依据 FEATURE_MATRIX 现状：两宿主
均为生命周期能力切片实证，非技能方法论消费）：

| 项 | 入口 | 产物 | 审批 | 取消/恢复 | 验证方式 | 剩余权限 |
|---|---|---|---|---|---|---|
| /investigate 契约层 | workflow 层 investigate 阶段 CLI | 调查日志+证据摘要（离线 harness 记账已有） | ApprovalStore 门（已有） | cancelWorkflow 故障安全序（已有） | 离线 harness 回归+键控切片 | 无（下轮首批） |
| /review 契约层 | review 阶段 CLI + verify-model-review | review 记录+差异清单 | 审批门复用 | 恢复腿复用 | 离线回归 | 无 |
| /investigate 宿主真实消费 | DSH 隔离 carrier（§1 前置成立后） | 真实技能索引消费记录 | 同上 | 同上 | 上轮 carrier 模式五控制 | DSH 安装在位+探测授权 |
| /review 宿主真实消费 | 同上 | review 技能真实执行记录 | 同上 | 同上 | 同上 | 同上 |

（本轮不启动任何真实模型流程；前两行属无模型离线工作，列入下轮首批。）

## 5. 蓝图状态增量（FEATURE_MATRIX 精确更新）

- 命令别名生命周期（M3 组）：**implemented + contract_tested**（PR #4=c9e76f7
  整合树 1389/1369/0/20 三环境；本 B 分支 336f05f 树 1397/1377/0/20=B1 +1、B3 +7）；
  host_verified 维持 DSH fixture 管线级（cce238ac），原生工具/模型消费 not_run（§1）。
- DSH 宿主配置生命周期新增 `dsh-profile-verify`：**implemented + contract_tested**
  （7 测试含逐检查红例与只读断言）；host_verified 不变。
- ZCode 真实宿主各项：维持 blocked（§2）；本轮 P2/P3（严格 UTF-8、驱动器根拒绝）
  为 contract_tested 增量。
- 全宿主不可绕过安全：维持 blocked（INTEGRATION §8 三层边界表）。

## 6. 证据

批 1/批 2 验证日志与变异 RED 记录入 `docs/evidence/post-m3-2026-11-01/`
（manifest 更新，SHA256 逐文件）；PR #4 双 run 快照随本提交发布。
