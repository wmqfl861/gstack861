# 批次 25 计划：③ ZCode 受控会话验收（无头真实派生）（2026-10-29）

## 突破与前提（已实证）

- **ZCode 有无头 CLI**：`ELECTRON_RUN_AS_NODE=1 ZCode.exe resources/glm/zcode.cjs --prompt ... --cwd <dir> --mode <mode> --json`（--help 实测；as-node 模式绕过 Electron 应用引导与单实例锁，DSH 同款模式）。
- **acceptance-pack 现成**：workspace git fixture、policy（write=workspace/src、Read/Write/Edit 绑定）、hook-snippet.json（完整 `{"hooks":{...}}` settings 片段，命令=node+仓库 CLI+策略路径）。
- ③ 的"需要用户开新会话"定式写于无人调查无头派生之前——本批以与 DSH 密钥验证**完全相同的标准**（真实宿主进程+真实模型+真实钩子）执行受控验收。

## 设计：scripts/zcode-acceptance-vertical.mjs + 测试

### 装配（全离线）

1. `acceptance-pack.mjs --out <temp>/pack` 生成基座。
2. **自动化"手工合并"步**：hook-snippet.json 深合并进 `pack/workspace/.zcode/settings.json`（新增文件；不触碰用户级 ~/.zcode）。
3. 安装一个**标记技能 fixture**（`workspace/.zcode/skills/<name>/SKILL.md`，YAML 头+不可猜标记行 G861-ZC-<hex>）——验收问题是宿主是否拾取工作区技能，非具体是哪套技能（诚实注记：非渲染技能；渲染链装载已有 runbook 实证）。
4. 组合检查（零模型）：直接以 stdin 事件调用钩子命令（STEPS.md 第 5 节探针：src 内放行/outside 拒绝/.git 拒绝）——钩子本身绿了再花模型钱。

### 密钥任务（zcode 无头，预算 3：冒烟 1 + 任务 2）

- **冒烟**（机制验证）：`--cwd workspace --mode yolo --json --prompt "Reply with exactly: OK"`——验证 as-node 派生+凭据继承+JSON 事件流可解析。失败即 BLOCKED 如实记录（不烧后续）。
- **任务 1 自动拾取**：`--prompt "Use the Skill tool to load <skill-name>, then output verbatim the line containing G861-ZC-"`——判定：标记行逐字 + 零 gstack861 码（索引注入+Skill 工具装载全链）。
- **任务 2 guard 双向**：`--prompt "用Write工具先创建<ws>/outside.txt内容z（第一个报错也要执行第二个），再创建<ws>/src/ok.txt内容y；逐字输出两次工具结果。"`（DSH 鲁棒性同款，≤200 字符 throw-before-launch）——判定：outside 拒 `gstack861:OUTSIDE_SCOPE` + 文件不存在；src 放行 + 文件内容精确；恰两次 Write 调用。
- **记账**：host='zcode' subject 走 tasks CLI create→start→complete/fail（首次真实 zcode 宿主记账）。

### 判定码/输出

`PASS | PICKUP_MARKER_NOT_VERBATIM | GUARD_DENY_NOT_OBSERVED | OUTSIDE_FILE_CREATED | ALLOW_FILE_MISSING/CONTENT_MISMATCH | CALL_COUNT_WRONG | SMOKE_FAILED(blocked)`；解析 `--json` 事件流（type/tool/status 字段按实测形状适配，冒烟时钉死）。

## 测试（test/zcode-acceptance-vertical.test.mjs，全离线）

提示词上限三档+工具钉死；hook-snippet→settings 深合并纯函数（含已存在 settings 的合并语义）；标记技能 fixture 形状；判定码全形；无凭据/无 ZCode.exe → exit 2 BLOCKED；组合检查探针三态。

## 密钥预算与诚实分级

3 个 zcode 无头调用（用户账户，已授权付费调用类）。状态升级措辞：**zcode 受控会话验收（无头派生，pipeline 级：自动拾取+guard 双向经真实 PreToolUse）**——不宣称 full host_verified/conformance（上游认证套件与 UI 会话仍属用户/后续）；macOS 不变。

## 流程

计划 → 独立审计划 → 单 lane 实现（协调者直做，b14 先例）+ 离线测试全绿 → 密钥三段 → 独立审成果 → 0.4.24 文档（FEATURE_MATRIX ③ 行/doctor hosts.zcode 升级）→ 摘要 → push → CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| as-node 无头不读登录态 | 冒烟先行，失败=BLOCKED 如实（机制发现本身入档） |
| 无头会话不加载工作区 hooks | 任务 2 的 deny 观察即检验；若 abstain-with-deny 缺失→如实 FAIL+记录（这本身就是③要回答的问题） |
| 嵌套 Electron 单实例锁 | as-node 模式跳过应用引导（--help 已证）；冒烟兜底 |
| --json 事件形状未知 | 冒烟输出全量入证据，解析器按实测钉死再跑任务 |
| 写用户级 ~/.zcode | 全部派生带 --cwd fixture；测试断言用户级未动 |

## 非目标

- full host_verified/conformance（上游认证流程）。
- 渲染技能的拾取（标记 fixture 即可答"是否拾取"；渲染链另有实证）。
- ⑨ 网关真调用（仍待用户配置）。
