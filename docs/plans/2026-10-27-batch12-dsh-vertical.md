# 批次 12 实施计划（解锁①后：toolRewrites 实装 + 边界②运行时 + DSH 最小纵向）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础：`docs/verification-2026-10-27-dsh-pipeline.md`——真实管线已实证工具名 `write`/参数 `file_path`；guard 拒绝路径已验证；密钥使用模式已确立（~/.dsh refs 提取→仅子进程 env→零打印零落盘；单次最小任务）。

**Goal:** (1) **toolRewrites 实装**：`hosts-overlay/dsh.ts` 增加 `toolRewrites`——**从 EXEC_STYLE_TOOL_RETRIES/EXEC_STYLE_TOOL_REWRITES 常量中仅取 Read/Write/Edit 的六个短语条目**（'the Read tool'→'the read tool' 等短语级 replaceAll；绝不裸词替换、绝不整体展开常量——其中 Agent/Grep 条目对 DSH 无据或有害）；**不加 Bash→exec**（无 DSH 证据且模板零命中=不可验证 diff）；同步更新 overlay 头注释（原「toolRewrites 待证据」已过时）并逐词标注证据层级（write=pipeline-observed；read/edit=pinned-commit source-inspected）；+ CI 重渲染验证产物差异；(2) **边界②运行时半边**：密钥任务 A——技能库**staging 在临时 workspace 内**（`<root>/workspace/skills`，否则 readRoots 违反 ROOT_OUTSIDE_WORKSPACE、策略无法编译）；策略文件在 workspace 外；readRoots=[workspace]、writeRoots=[workspace/src]；fixture SKILL.md 内写**不可猜的唯一标记行**（索引只暴露 name|description|path，按名引用技能（「read the SKILL.md of skill X listed in the gstack861 skills index」）并要求逐字输出标记行——证明真实读文件而非猜测；(3) **DSH 最小纵向 allow 半边**：密钥任务 B——**预建 workspace/src/**、目标为启动前断言不存在的全新唯一文件名；判定=文件存在+内容逐字匹配+输出零 `gstack861:` 码（guard abstain）。离线 composeCheck 断言**两个插件 id** 均在 dump。成本上限措辞=**2 个密钥任务**（各含宿主 session-title 微请求，既知 caveat）。纯函数（提示词构建+上限、判定解析、fixture 构建）导出并配离线单测（首个 verify 脚本测试模式，CI 无 DSH）。版本 0.4.11。

**Architecture:** 单实现车道（overlay 改动 + 新验证脚本 + 测试）+ 协调者收尾；两段密钥验证均延续既定密钥处理模式。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M2/M3、dsh-pipeline 证据、批次 10b 的 skills 插件与验证器、批次 3 渲染管线。

## Global Constraints

- 密钥：仅从 ~/.dsh/.credentials.yaml refs 提取到子进程 env；零打印/零落盘；每任务提示词 ≤200 字符（代码内 PROMPT_MAX_CHARS throw-before-launch，同 verify-dsh-guard）；**本批密钥任务上限 2 个**（各含宿主 session-title 微请求 caveat）。
- 沿用全部仓库约束；诚实分级：纵向/运行时结果按实际观察记录，模型不遵循索引不算通过（如实记 blocked）。
- toolRewrites 必须逐词有据（渲染产物 diff 展示改动点），不发明别名。

## Review Focus

1. toolRewrites 词表逐项对照 pipeline 证据与调研（Bash→exec 是否有据——EXEC_STYLE_TOOL_REWRITES 常量；无据则不加）。
2. 密钥任务判定的可证伪性：模型引用 SKILL.md 首行必须与磁盘内容逐字比对；allow 任务必须断言文件真实创建且 guard 未拒绝。
3. 渲染产物差异可审查（重渲染前后 manifest/sha 对比）。

---

### Task 1 (Lane): overlay toolRewrites + verify-dsh-vertical.mjs + 测试
**Files:** Modify `hosts-overlay/dsh.ts`、Create `scripts/verify-dsh-vertical.mjs`、Test `test/verify-dsh-vertical.test.mjs`（离线单测：脚本的环境组装/判定函数；密钥路径由协调者实跑）
- overlay：`toolRewrites` 按词表（Read/Write/Edit→小写；Bash 仅在有据时映射）；其余字段不动。
- 脚本三段：环境组装（guard+skills+策略：readRoots 含技能目录，writeRoots=[workspace/src]）；任务A（≤200 字符）：读索引指定 SKILL.md 并输出其第一行正文——判定=逐字等于磁盘内容；任务B：在 writeRoots 内创建文件——判定=文件存在且任务无 gstack861: 错误。exit 0 全过/1 失败/2 无密钥受阻。
### Task 2 (协调者): 实跑密钥验证、渲染差异、证据、终审、推送
- 实跑 verify-dsh-vertical（两任务）；`CI=true GSTACK861_RENDER=ci` 重渲染验证 toolRewrites 产物 diff（新旧 manifest 对比入证据）；VERIFICATION 第十九轮 + 0.4.11 + 摘要 → 终审 → 推送 → CI 绿。
