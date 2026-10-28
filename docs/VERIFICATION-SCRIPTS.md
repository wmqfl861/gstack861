# 验证脚本参考总表（VERIFICATION-SCRIPTS）

批次 17 收口：`scripts/` 下 10 个验证/工作流脚本的统一参考表。三方一致性由
test/verification-scripts.test.mjs 钉死（本表 ↔ `scripts/` 目录 ↔ `bin/gstack861.mjs doctor`
的 `verticals` 输出：无孤儿、无幽灵、证据路径真实存在、密钥列与 doctor keyed 布尔一致）。
表行以行首 `| scripts/` 精确解析，增删脚本必须同步改本表与 doctor。

| 脚本 | 目的（一句） | 密钥 | CI 可跑 | 运行方式 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| scripts/verify-8dot3.mjs | Windows 8.3 短名别名探针 | 密钥无 | CI 不可跑（卷相关，manual） | node scripts/verify-8dot3.mjs | round-5 记录（$?-chain 诚实注记） | docs/VERIFICATION.md |
| scripts/verify-dsh-guard.mjs | guard deny 管线键控验证 | 密钥需 | 冒烟可（无密钥 exit 2） | DEEPSEEK_API_KEY=... node scripts/verify-dsh-guard.mjs | deny-verified (2026-10-27) | docs/verification-2026-10-27-dsh-pipeline.md |
| scripts/verify-dsh-skills.mjs | 技能激活三控（无任务启动） | 密钥无 | CI 不可跑（需本机 DSH） | node scripts/verify-dsh-skills.mjs | activation-verified (batch 10b) | docs/verification-2026-10-27-batch10b.json |
| scripts/verify-dsh-vertical.mjs | 技能运行时消费+allow 路径 | 密钥需 | 冒烟可 | DEEPSEEK_API_KEY=... node scripts/verify-dsh-vertical.mjs | verified (2026-10-27) | docs/verification-2026-10-27-dsh-vertical.md |
| scripts/verify-dsh-robustness.mjs | 同会话 deny→allow 一致性 | 密钥需 | 冒烟可 | DEEPSEEK_API_KEY=... node scripts/verify-dsh-robustness.mjs | verified (2026-10-28) | docs/verification-2026-10-28-dsh-robustness-vertical.md |
| scripts/verify-model-review.mjs | 模型复核五段就绪检查 | 密钥无 | 可跑 | node scripts/verify-model-review.mjs | readiness-verified (batch 11) | docs/verification-2026-10-27-batch11.json |
| scripts/dsh-mini-vertical.mjs | spec→implement→qa+记账 | 密钥需 | 冒烟可 | DEEPSEEK_API_KEY=... node scripts/dsh-mini-vertical.mjs | vertical-verified (2026-10-28) | docs/verification-2026-10-28-dsh-robustness-vertical.md |
| scripts/dsh-ship-vertical.mjs | ship+审批集成 | 密钥需 | 冒烟可 | DEEPSEEK_API_KEY=... node scripts/dsh-ship-vertical.mjs | vertical-verified (2026-10-28) | docs/verification-2026-10-28-batch14-dsh-ship.md |
| scripts/dsh-recovery-vertical.mjs | 崩溃恢复 reap→resume | 密钥需 | 冒烟可 | DEEPSEEK_API_KEY=... node scripts/dsh-recovery-vertical.mjs | vertical-verified (2026-10-28) | docs/verification-2026-10-28-batch16.json |
| scripts/zcode-workflow-vertical.mjs | ZCode 六阶段工作流层离线 harness | 密钥无 | 可跑（整跑） | node scripts/zcode-workflow-vertical.mjs | offline-harness PASS (2026-10-28) | docs/verification-2026-10-28-batch16.json |

## 密钥预算纪律

- **throw-before-launch ≤200 字符**：每个键控脚本的提示词在代码里硬性 ≤200 字符
  （`PROMPT_MAX_CHARS=200`），超长在任何键控启动**之前**抛出（`PROMPT_TOO_LONG`），
  绝不静默截断或超发。
- **密钥只进子进程 env**：`DEEPSEEK_API_KEY` 仅从环境变量读取、仅传给带密钥子进程；
  离线子进程（profile seeding、`--dump-config` 组合检查等）一律剥除；绝不读取
  `~/.dsh/.credentials.yaml` 等用户级配置，绝不打印，绝不落盘。
- **逐批上限**：每批计划写明键控任务数上限，上限是脚本内硬编码结构（非命令行开关）；
  本批（17）0 密钥，统一回归 runner 只做无密钥 BLOCKED 冒烟。
- **累计数**：键控运行的累计次数以 docs/VERIFICATION.md 各轮记录为准（截至批次 16
  项目累计 12 次，批次 17 不新增）。

## CI 安全边界

统一回归 runner（`npm run verify-offline`，见 `.github/workflows/ci.yml` 的
offline-contracts 两腿）只纳入 CI 结构性安全的部分：六个键控脚本的 BLOCKED 冒烟
（env 检查即返回 exit 2，不触 DSH）、`zcode-workflow-vertical` 整跑（纯离线 harness）、
`verify-model-review`（node 内建 + 仓库 src + tmpdir 夹具，网络仅 127.0.0.1 回环）。
runner 自身零网络（超出回环）零模型调用。以下两类脚本**不入**统一回归：

- `verify-dsh-skills`：虽零密钥，但需要一个本机 DSH 安装做真实 boot 三控
  （激活正控 + 两个负控），GitHub runner 上结构性不可行——local-only。
- `verify-8dot3`：NTFS 8.3 短名是否生成取决于卷状态与主机注册表配置，结果在
  runner 的卷上无法与验收记录对照解释——manual 探针，不在 CI 复跑。
