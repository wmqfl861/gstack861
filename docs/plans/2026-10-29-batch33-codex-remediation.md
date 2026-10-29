# 批次 33 计划：Codex 审计（gpt-6-astra/max）修复循环（2026-10-29）

## 审计输入

Codex 独立审计（用户指令：模型 gpt-6-astra、思考等级 max）判定 **FAIL**，14 项发现（1-9 Important，10-14 Minor），全部附真实复现依据。用户指令：按意见修复→复审→直至通过→推送。

## 修复清单（逐项对审计编号）

| # | 位置 | 修复 |
|---|---|---|
| 1 | policy.mjs:207 | **已修复**：gitfile 正则 `(\S+)`→`(.+)`+trim（对齐 git 自身 gitfile 解析；无 gitdir 行的内容仍忽略）；测试=真实 `git init --separate-git-dir` 写入含空格 gitdir 路径（审计原复现）+ 手写相对/绝对含空格指针，三腿全部 PROTECTED_PATH |
| 2 | install.mjs:241 | **已修复**：classify 无注册表记录且盘上 manifest 声明 files 时，用 manifest 自身声明（sha256+files）构造伪记录跑 verifyOwned——用户新增文件即 USER_FILE_REFUSED；测试=带 files 技能装好→删注册表→加 user-notes.txt→拒绝（不取备份、不动文件）；去掉用户文件后纯净恢复路径保留（backup+replace 成功） |
| 3 | install.mjs:313 | **已修复**：写阶段逐技能回滚（backupPath 追踪）——新目录 rename 失败→移出的备份还原回原位、backedUp 弹出、注册表零写入；注册表提交失败（writeRegistry temp+rename 原子）→新目录移除+merged/installed 回退+外层还原备份；故障注入测试两处（renameSync 计数注入 / 首个注册表 temp 写注入 EIO），断言盘上/注册表/备份根三处终态+故障移除后恢复安装成功 |
| 4 | install.mjs:373 | **已修复**：onPath 收集每个列出路径的累计前缀（sections、sections/deep、sections/deep/nested）；测试=4 段路径 sections/deep/nested/detail.md 全生命周期：install→重装 skip（verifyOwnede 累计目录全合法）→v2 backup 替换→uninstall 整树移除 |
| 5 | tasks.mjs:86 | **已修复**： leased start/resume 锁内在租约落位后铸造 attemptToken（32 hex）；仅执行侧转换（heartbeat/complete/fail，fence: true）要求回呈 token（缺失=TASK_ATTEMPT_TOKEN_REQUIRED，不符=TASK_ATTEMPT_MISMATCH）；监管侧（reap/interrupt/cancel/requeue）不查 token（对记录而非代表某次尝试行动）；token 只存在于 running 记录（任何离开 running 的转换即清除——收割/中断/完成/失败/重排）；无租约尝试零 token（无租约即不可被收割，围栏无对象）；CLI 增 --attempt-token（heartbeat/complete/fail 专属，格式校验）；6 个 vertical 脚本线程化；回归测试编码审计原攻击链（A 租约启动→过期→收割→B resume 铸新 token→A 迟到 complete/fail/heartbeat 全拒、A 无 token complete 拒、B 自有转换全成）+ 无租约全程零 token |
| 6 | model-review.mjs:116 | **已修复**：redact() 先脱敏后截断——先字面替换密钥本身（≥8 字符才启用），再 Bearer/sk-/authorization/api[-_]?key/x-api-key 形态→[REDACTED]，然后才 1KiB 截断；三条回显路径（坏 JSON 体/缺 content/坏 verdict）+ error.message/stack 零键断言 + sk- 异体密钥形态断言 |
| 7 | dev-gateway.mjs:40 | **已修复**：唯一名额在通过门槛时（读正文前）同步 posts+=1；429 拒绝路径 drain 正文使慢写方可读结构化错误；不变量=封顶计数的是上游 POST（断连于上游发出前释放名额，发出后名额永久占用）；并发半包/慢正文/断连三测试各自断言上游恰 1 次（旧逻辑对照复现 2 次，测试为承重） |
| 8 | dev-gateway-certs.json | **已修复（收窄而非仅披露）**：重新生成为自签**叶证书**（CA:FALSE、keyUsage 无 keyCertSign、SAN 恰为 IP:127.0.0.1/IP:::1/DNS:localhost）——NODE_EXTRA_CA_CERTS 指向它只信任这三个回环名，签发任意身份的攻击从构造上消除；测试经 node:crypto X509Certificate 钉死 ca:false、无 Certificate Sign、SAN 精确集合；OFFLINE-COMPLETE §一2 补信任范围披露（只为专用子进程设置，绝不全局长期信任） |
| 9 | banned-terms.mjs:196 | **已修复（本行按实做更新）**：按上游语义恢复真实路径包含检查——assertInsideRoot（ship-policy.ts 538-556）逐字内联进 bin，realpath 包含于 repoRoot（非字符串前缀，也非全面禁链：解析后仍在库内的链接放行，与上游一致），逃逸→BANNED_TERMS_INVALID 退出 3。账本第 3 项更正：原"固定路径天然在库内、越界不可经 CLI 到达"判断**错误**——`.gstack` 目录（或配置文件）以符号链接/junction 外指即到达，`check --policy-from head` 曾读库外配置并退出 0；该检查现已恢复，差异关闭。差分/回归测试 4 条：.gstack 目录链接外指（审计原始复现）、配置文件符号链接外指、base 缺失→工作树回退（RC1）路径、库内链接目标正控（钉"realpath 包含"而非"禁链接"） |
| 10 | model-review.mjs:82 | **已修复**：loadGateway 在加载层拒绝 query/fragment/userinfo（UNSAFE_BASEURL）并将尾斜杠规范化去除；执行器 joinUrl 经 URL 对象重组 pathname（去尾斜杠+拼接，search/hash 清空）——双侧防御；load→真实请求目标联动测试（含尾斜杠变体恰命中 `<base>/chat/completions`） |
| 11 | approvals.test.mjs:29 | **已修复**：过期消费回归（有效期内 approve → 恰在 expiresAt 拒绝 consume=APPROVAL_EXPIRED → 盘上记录仍 approved 未 consumed、changedAt 未改写；expiresAt-1 最后一刻可消费）；既有"过期不可批准或消费"测试补上其名承诺的 consume 断言；边界契约（now >= expiresAt 即过期）以注释钉死 |
| 12 | 双进程测试 | **已修复**：两类证据口径分立——原子性类（自由竞争：子进程输出机器可读 JSON 行 {ok,code}，败方码必须匹配结构化 APPROVAL_/TASK_(BUSY|WRONG_STATE)，模块加载错误无 JSON 行即不可通过；磁盘终态恰一次落地）+ 争用类（确定性：持有方子进程 mkdir 库自身 lock 目录并写 lock-held 标记，父进程轮询标记后放败方——败方运行时**确证**他进程持锁，仅可能 BUSY；释放后新子进程成功证伪"任意失败"）；approvals 与 tasks 双文件同口径 |
| 13 | OFFLINE-COMPLETE/FEATURE_MATRIX | **已修复**：落款刷新为 2026-10-29 批次 33 / 0.4.32；批次 18 快照标注为历史；§二表 redact/redact-prepush 行改 ported（批次 22/23 实况，含 hook 子命令回填与 5 个上游测试文件向量回放）；"3 项 deferred"→"唯一剩余离线余量=命令别名 1 项"；交叉引用验证轮次刷新（42 轮/批次 32，本批为第 43 轮）；FEATURE_MATRIX 状态行同步（批次 2–33、二进制收口、8 键控能力切片不计数） |
| 14 | OFFLINE-COMPLETE:47 | **已修复**：§一5 正文改为能力切片口径（装载/索引/读取技能正文/随机标记回显/键控记账链路；技能正文为合成 fixture），明示 8 切片**不增加** 15 例方法论消费计数、与 FEATURE_MATRIX"非方法论消费"口径一致；原始技能行为与降级/验证门槛仍列独立待验收项 |

## 第三轮复核（FAIL：#2/#3/#5/#6 部分解决 + 新发现 #15-#18）→ 修复如下

| # | 位置 | 修复（按实做） |
|---|---|---|
| 2r | install.mjs classify | 无注册表记录时**无条件**校验：files-bearing 用 manifest 自身 files 声明，files-less 用 `{sha256}`（其声明即"除 SKILL.md/manifest.json 外无他物"，多一个文件同样拒绝）；新增 files-less 差分测试（user-notes.txt 拒绝 + 纯净恢复控制） |
| 5r | tasks.mjs | 铸造与租约**解耦**（每 attempt 必铸，租约与否无关）——审计复现链"A 租约启动→收割→B 无租约 resume→A 携旧 token complete"现被拒绝（B 的 attempt 2 有自己的 token：MISMATCH/TOKEN_REQUIRED）；guard 前置于 fence（保留"无租约 heartbeat=TASK_LEASE_REQUIRED"既有可观测契约）；新回归测试编码该链；leaseless 生命周期测试改铸 token 断言；全部调用方（lease-race CLI、adapters 冒烟、workflow 状态机、keyed-scripts 稳定性、既有 36 项 tasks 测试）线程化 |
| 6r | model-review redact | 字面脱敏条件 ≥8 → ≥1（resolveKey 接受任意非空键，7 字符键同样泄漏）；新增 7 字符键回归测试 |
| 15 | install.mjs 回滚 | "目标目录仍存在"**不再**作为删除备份的依据——组合故障（注册表提交 EIO + 回滚删除新目录 EPERM）下旧版本必须在备份中存活；组合故障注入测试断言备份恰一条且含旧版本内容 |
| 16 | test/lease-race.test.mjs | leasedTask 返回 start 铸造的 token 并穿入竞争的 heartbeat 子进程（--attempt-token）；保留原合法胜者/败者断言，未放宽败方码集合 |
| 17 | test/dev-gateway.test.mjs | 弃用 X509Certificate.keyUsage（实为 EKU OID/undefined，旧文本检查对带 keyCertSign 的证书空洞通过）——新增 minimal DER 解析器直读 2.5.29.15 BIT STRING 内容字节；嵌入式负控证书（CA:FALSE+keyCertSign，私钥已弃）证明解析器真能看见该位；shipped 证书断言 bit5=0 |
| 18 | src/gateway.mjs | userinfo 拒绝补 `url.password`（`https://:pw@host` 此前被接受并静默剥离）；测试补 仅密码/仅用户名/两者 三形态 |

## 第四轮复核（8 项全部已解决；新发现 #19/#20/#21 → FAIL）→ 修复如下

| # | 位置 | 修复（按实做） |
|---|---|---|
| 19 | scripts/dsh-mini-vertical.mjs main() | start 返回值捕获 attemptToken 并**硬校验**（缺 token 即抛 TASKS_CLI_FAILED，绝不静默省略）；complete/fail 无条件附 --attempt-token |
| 20 | scripts/dsh-ship-vertical.mjs:279 | runCli 无 .parsed 字段（恒 undefined 的读取已删）——改从 JSON.parse(startRun.stdout) 取 token + 硬校验；终态无条件附 --attempt-token |
| 21 | test/model-review.test.mjs | 短键测试重写：键不带任何 Bearer/Authorization/api-key 前缀（裸 `diag <key>` 形态，通用正则不可能匹配），覆盖坏 JSON/缺 content/无效 verdict 三路径——字面阈值回退 ≥8 时必失败（承重） |
| 新增 | test/dsh-keyed-scripts.test.mjs | 真实 CLI 编排测试：导出的 tasksArgs 构造器 + 真实 bin/gstack861.mjs，create→start（断言 stdout 记录携带 32hex token）→complete/fail 两腿附 token 落终态——钉死 mains 必须遵守的接线契约（键控 mains 无法离线跑，此为最接近的离线等价） |

## 流程

计划（本文件）→ 独立审计划 → 修复（协调者直做 #1-6/#10 + 三条并行子代理 lane：#7+#8 网关/证书、#9 banned-terms、#11+#12 测试补强）→ 全量测试绿（1036 tests / 1016 pass / 0 fail / 20 平台跳过）→ **独立子代理审开发成果** → **Codex 复审（同模型同等级）** → 未过则迭代 → 通过 → 0.4.32 文档+摘要 → push → CI 3/3。

## 密钥预算

0（全部离线修复；无 DSH/zcode/网关调用）。
