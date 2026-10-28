# 批次 18 计划：蓝图剩余项终版盘点与收口（2026-10-28）

## 目标

1. **终版盘点**：对 BLUEPRINT 全部剩余项逐条判定——离线仍可推进 / 待用户解锁 / 环境受阻——并输出终版清单 `docs/OFFLINE-COMPLETE.md`，用户侧解锁项（③ ZCode 受控会话、⑨ 网关配置等）列明**精确触发方式**。
2. **最后一个离线工程项**：把两次被记为非目标的"真实多进程租约竞争"转为离线实证——**两个真实 Node 子进程**在同一任务记录上竞争 reap/heartbeat（锁目录串行化），确定性断言"恰一胜者+败者正确错误码+记录与胜者一致"。
3. **矩阵真值同步**：`开发/调查/review` 行（"尚未用真实宿主执行纵向任务"——对 DSH 已不真实：批次 13/14/16 键控运行了 spec/implement/qa/ship/恢复五类真实模型任务）。

## 逐项盘点（计划的核对基线；审计划独立复核）

| 项 | 现状 | 判定 | 依据 |
|---|---|---|---|
| 多进程租约竞争 | 两轮记非目标 | **离线可推进（本批 Lane A）** | 双子进程+短租约可确定性测试；锁目录串行化正是要验证的机制 |
| 开发/调查/review 行 | planned/planned，理由过时 | **文档真值同步（本批 Lane B）** | DSH 侧已有键控纵向五类；ZCode 侧仍待③ |
| ③ ZCode 受控会话+自动拾取 | acceptance-pack 就绪 | 待用户解锁 | 清单给精确命令 |
| ④ 宿主内嵌审批 UI | planned | 待用户解锁/宿主侧 | 无 ZCode/DSH 内嵌 UI 接口可用离线做 |
| ⑤ GBrain | 待①②③ | 环境受阻 | ③ 是前置 |
| ⑥⑦⑧ 浏览器/iOS/远端 | planned | 环境受阻 | 浏览器栈/设备/远端不可用 |
| ⑨ model-review runtime | mechanism-ready | 待用户解锁 | 用户手放网关配置+开关+键 |
| ⑩⑪ 余项（宿主内执行器中断源/子 Agent 继承） | planned | 待③（ZCode）/后续 DSH 深化 | 事件源在宿主进程内 |
| ⑫ 独立二进制 | planned | 环境受阻 | 上游二进制前提逐项声明（蓝图 M3 原则） |
| ⑬ macOS | not-run | 环境受阻 | 无 Mac；CI 无 macOS 腿（加腿=付费 runner，不动） |
| ⑭ M4 full/host_verified | 阻断于以上全部 | 阻断 | 蓝图退出条件明确 |
| 真实模型质量对等 | not_run | 待③+⑨+预算 | 双宿主真模型对拍；ZCode 侧=③ |

结论：**除 Lane A/Lane B 两项外，离线空间已尽**——本批即是离线收口批。

## Lane A：真实双进程租约竞争测试（test/lease-race.test.mjs 新）

- 竞争载体：真实 `bin/gstack861.mjs tasks` CLI 子进程（锁纪律在 TaskStore，CLI 路径最真实）。
- 子进程封装：`node -e` 先睡（等租约过期/对齐起跑）再 spawnSync CLI 并透传 exit/stdout/stderr——全部内联在测试文件，不新增仓库 fixture 文件。
- 场景 1（reap vs heartbeat）：任务带 40ms 租约；两个子进程各睡 60ms 后同时发起（spawn 不等待，Promise.all 收割）。**确定性结果集断言**（两种合法顺序都接受，但必须自洽）：
  - heartbeat 胜：heartbeat exit 0，reap 失败 `TASK_LEASE_ACTIVE`；终态 running 且 leaseExpiresAt 在未来；
  - reap 胜：reap exit 0，heartbeat 失败 `TASK_WRONG_STATE`；终态 interrupted 且无 leaseExpiresAt；
  - 无论如何：恰一个 exit 0；记录字段与胜者完全一致；无损坏（get 可读、schema 合法）。
- 场景 2（reap vs reap，双收割者）：恰一个 exit 0，另一个 `TASK_WRONG_STATE`；终态 interrupted；attempts 仍为 1（收割不 bump）。
- 场景 3（控制组，无竞争）：单 reap 在过期后必成功——证明测试装置本身有效（若装置坏了测试红，不会假绿）。
- 平台：全程 Windows/Linux 通用（spawn+CLI 纯 Node）；超时 120s（三场景各 ~2s）。
- 不改 src/（锁机制已实现，本批只补实证）；若测试暴露真实竞态缺陷→按根因修 src（走失败诚实记录路径）。

## Lane B：终版清单 + 矩阵真值同步（docs/OFFLINE-COMPLETE.md 新 + docs/FEATURE_MATRIX.md + README）

### B1. docs/OFFLINE-COMPLETE.md（终版清单）

结构：一句话结论（截至 2026-10-28 离线空间已尽，0.4.17）→ 三节：
1. **待用户解锁**（每项：是什么/为什么需要你/精确触发方式/触发后我们做什么）：
   - ③ ZCode 受控会话：`node scripts/acceptance-pack.mjs --out <dir>` → 按 `<dir>` 内打印清单在 fixture 工作区开新 ZCode 会话 → 把 doctor 输出与清单结果发回。触发后：自动拾取/容忍度验收 → FEATURE_MATRIX ③ 行升级。
   - ⑨ model-review runtime：网关配置文件放哪（`src/gateway.mjs` 读取的显式配置路径——以代码为准）、开关红线、密钥注入方式（仅子进程 env）；触发后：`node scripts/verify-model-review.mjs` 升级为真调用验证。
   - ④ 宿主内嵌 UI / ⑩⑪ 宿主内执行器接线：需要宿主侧 API/会话（同③的会话触发）。
2. **环境受阻**（浏览器栈/设备/远端/Mac/上游二进制——各一句"缺什么"）。
3. **离线已尽清单**（指向 VERIFICATION-SCRIPTS.md 总表 + 25 轮验证记录）。
- 清单内每一项与 FEATURE_MATRIX 行、README 边界节交叉引用；不新增任何"完成"宣称。

### B2. FEATURE_MATRIX 真值同步

- `开发/调查/review` 行：DSH 列 planned → `vertical-slice-verified`（批次 13/14/16 键控真实任务：spec 转述/精确实现/qa 校验/ship 负控/恢复复跑；ZCode 列仍 planned 待③——理由列更新）。
- 第 25 行补一句：多进程租约竞争已双进程离线实证（本批 Lane A；措辞以 Lane A 实测结果为准，合并后落终稿）。

### B3. README

边界节开头加一行：终版盘点见 `docs/OFFLINE-COMPLETE.md`（离线已尽/待解锁/环境受阻三分类）。

## 密钥预算

0（全离线）。项目累计 12 不变。

## 文档与版本（合并后最终 HEAD）

0.4.17；VERIFICATION 第二十六轮（含 Lane A 实测的胜者分布与装置控制组结果）；证据 JSON `docs/verification-2026-10-28-batch18.json`；摘要重算。

## 流程

计划 → 独立审计划（重点复核逐项盘点表：是否有漏判的离线可推进项——这是本批最重要的审查点）→ 双 lane 并行（A: test/lease-race.test.mjs；B: OFFLINE-COMPLETE.md+FEATURE_MATRIX+README；零文件重叠）→ 独立审成果 → 合并 → 0.4.17 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 双进程时序在慢 CI 上偶发（两子进程未真正重叠） | 场景本身对"是否重叠"不敏感：无论锁序如何，结果集断言都成立；控制组钉死装置有效性 |
| 子进程封装（node -e）跨平台引号问题 | args 数组式 spawnSync，无 shell 字符串拼接；Windows/CI 实测 |
| 测试暴露 src 真实竞态 | 那是测试的价值：按根因修 src + 诚实记录（本批允许 src 改动，需在成果审查中单独说明） |
| 盘点漏项 | 审计划独立逐行复核盘点表 vs BLUEPRINT M2-M4 + FEATURE_MATRIX 全部 planned/blocked 行 |

## 非目标

- ③⑨ 的实际触发（用户侧动作，清单只给方法）。
- macOS CI 腿新增（付费 runner，不动）。
- 任何新的功能组实现（浏览器/设备等环境受阻项）。

## 审计划必改落实（2026-10-28，独立审计划 4 项 → 批次扩为三 lane）

1. **Lane A 断言集修正**：锁竞争败者可能撞 `TASK_BUSY`（transition 的 mkdir 失败统一映射，src/tasks.mjs:81）——败者错误码集改为场景相关的 {TASK_LEASE_ACTIVE, TASK_WRONG_STATE, TASK_BUSY}；确定性不变式：恰一 exit 0 + 终态记录与胜者 stdout 一致 + 结果集自洽。控制组保留。文档措辞承认既有双进程 start 竞争测试（test/tasks.test.mjs:222）——本批不是首个双进程测试，新增的是租约时序+败者码+记录一致性。
2. **盘点表补洞**（并入 Lane B 清单）：补 README⑪（宿主级安装/升级/卸载，待③）；M3 生命周期·迁移**判定为离线可推进**（上游有 gstack-migrate-claude-code，本项目装载链先例支持离线先行）→ 进"离线余量"而非"已尽"；⑫ 二进制按前提拆分：make-pdf/diagram/浏览器类=前提受阻，**纯工具类（slug/redact/paths 等）=离线可推进**（后续批次移植）；补判 FM L19（DSH 相对路径/Session cwd）、L27 设计组（属密钥预算类而非浏览器类）、L29（learn/retro 已消费；document-* 未）、L30 CSO、命令别名、团队引导。**终版结论改为"离线余量=纯工具二进制移植+原生迁移工具（后续批次）；其余待解锁/环境受阻"——不宣称离线已尽。**
3. **⑨ 触发方式落实为真入口（新 Lane C）**：`verify-model-review.mjs` 增 `--gateway-config <abs>` 真调用模式（loadGateway 全 schema 校验 + GSTACK861_MODEL_CALL=1 红线 + apiKeyEnv 注入 + 单次封顶不变；离线自测用其既有回环服务器模式，生产红线不放松：官方主机黑名单、显式开关、单次上限）。清单可打印一条精确可运行命令。
4. **B2 措辞修正**：DSH 升级理由明确为"生命周期能力切片（逐字标记读/精确单写/回读/ship 负控+审批门/崩溃→收割→恢复复跑）"，**非** /investigate、/review 技能方法论消费（两宿主均未跑）；第 25 行"非目标"子句**替换**（非追加）且提及既有双进程 start 测试。

版本/矩阵终稿（含第 25 行措辞对照 Lane A 实测胜者分布）在合并后由协调者落盘——成果审查把"终稿措辞 vs 实测"列为检查点。
