# 批次 3 实施计划（上游渲染管线复用 / 原生询问接线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础：上游渲染管线只读调研（本会话调研报告，file:line 引证）——`gen:skill-docs` 在固定提交存在；渲染路径 106 文件 BFS 零 npm 导入、零网络、零构建；宿主经 `hosts/index.ts` 注册表导入（overlay 必改之）；默认新宿主渲染 58 模板（含根路由，我们的盘点只见 57）。

**Goal:** 按审查第 9 条与蓝图第 1 节「先复用上游工具」：以**受限放宽**方式复用上游 `gen:skill-docs` 渲染管线为 zcode/dsh 产出可用技能（无未解析占位符），执行域限定 CI（固定 bun 1.4.2、离线、子模块副本+overlay，子模块本体永不弄脏）；同时接通离线可验证的**原生询问桥**（`approvals ask`，非交互无渠道即阻塞，绝不自动同意）。

**Architecture:** Lane A 交付宿主定义 overlay + 渲染编排器（副本化、注册表补丁、渲染后门禁、产物清单）+ CI 渲染作业；Lane B 交付 `approvals ask` 桥；两车道只写代码与测试，**README 全部改动归 Task 3 协调者**（避免双车道冲突）；渲染执行只发生在 CI（本地默认拒绝，`GSTACK861_RENDER=ci` 或 CI 环境才放行）。

**Tech Stack:** 仓库现状 + CI 增补 bun 1.4.2（oven-sh/setup-bun 按 SHA 固定，与上游一致）。

**Spec:** 调研事实表（本计划开头）、`docs/reviews/2026-10-27-claude-review.md` §二.9/§二.6、`upstream/gstack/docs/ADDING_A_HOST.md`、`docs/BLUEPRINT.md` 第 1 节、README「不执行上游代码」红线的受限放宽裁定（下述 R-Ruling）。

## Global Constraints

- 红线放宽的**精确边界**（本计划裁定 R1，写入 README）：上游代码执行仅限 `scripts/gen-skill-docs.ts` 渲染路径；仅限 CI 环境（`CI=true` 或显式 `GSTACK861_RENDER=ci`）+ bun 1.4.2 固定版本；离线（该路径零 npm/零网络已由调研证实）；在 `git archive` 子模块**副本**上执行，`upstream/gstack` 工作树渲染前后必须保持 pristine（编排器断言）；不运行 `./setup`、不装 Claude Code、不调模型。
- 宿主定义**只写有证据的字段**：tier `experimental`（默认）；能力取保守值——zcode `{toolExecution:true, questions:'native', planMode:false, delegation:false, browser:false, safetyHooks:'advisory'}`（AskUserQuestion 有据；plan/delegation 未验收不标）；dsh 同构但 `questions:'prose'`（无结构化提问证据）；**不发明 toolRewrites**（DSH shell 工具名无证据——留 TODO 注释，待管线级验证后补）。
- 沿用全部仓库约束（零依赖——编排器仅 node:*；UPPER_SNAKE；TDD；平台包裹；状态诚实：渲染产物标 `rendered-experimental`，绝不宣称 full/conformance）。
- 两车道文件不相交：A=`hosts-overlay/*`、`scripts/render-upstream.mjs`、`test/render-upstream.test.mjs`、`.github/workflows/ci.yml`；B=`bin/gstack861.mjs`、`test/adapters.test.mjs`。

## Review Focus

1. **子模块纯净性**：编排器任何路径（成功/失败/中断）都不得写 `upstream/gstack`；结束断言 `git status --porcelain` 为空。
2. **注册表补丁的正确性**：对副本 `hosts/index.ts` 的追加必须产出可被 `bun run` 接受的 TS（导入行 + `ALL_HOST_CONFIGS` 元素 + 再导出）；对上游 index.ts 结构漂移（若升级基线）要失败闭合而非静默错补。
3. **渲染后门禁**：输出零 `{{...}}` 残留；每宿主 `gstack-*` 技能目录数与盘点 57 交叉核对（差异=根路由等已知豁免须显式白名单）；渲染清单（每技能 sha256）落盘供安装链消费。
4. **ask 桥的阻塞语义**：stdin 无答案（EOF）→ exit 3 且状态不变；任何路径不得自动 approve；答案词表仅 `approve`/`reject`（含可选 reason 行）。
5. **本地默认拒绝渲染**：无 CI/无环境变量时编排器拒绝执行且不留临时目录。

---

### Task 1 (Lane A): 宿主 overlay + 渲染编排器 + CI 作业

**Files:**
- Create: `hosts-overlay/zcode.ts`、`hosts-overlay/dsh.ts`、`scripts/render-upstream.mjs`、`test/render-upstream.test.mjs`
- Modify: `.github/workflows/ci.yml`（新 job `render-upstream`）

**Interfaces:**
- `hosts-overlay/zcode.ts` / `dsh.ts`：`defineHost({ name, displayName })` + 上述保守能力显式声明 + 头注释（依据与 TODO：toolRewrites 待宿主工具名证据）。
- `scripts/render-upstream.mjs` 导出可测函数 + CLI：
  - `prepareCopy({ upstreamDir, commit, scratch })`：`git archive <commit> | tar -x`（Windows 用 `git archive --format=tar -o` + tar）；复制 overlay；`patchIndex(copyDir, hosts)`——**唯一补丁点是 `hosts/index.ts` 的字面量拼接**（`HOST_CONFIG_MAP`/`ALL_HOST_NAMES`/`HOST_PATHS`/`Host` 全部在模块求值期从该字面量派生，push 无效）：(i) 锚点断言 `import agy from './agy';` 存在后插入 `import zcode from './zcode';`/`import dsh from './dsh';`；(ii) 锚点断言**完整字面行** `export const ALL_HOST_CONFIGS: HostConfig[] = [claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, copilot, agy];` 存在后，在 `= [` 之后头部插入 `zcode, dsh, `；(iii) 文件尾追加 `export { zcode, dsh };`。任一锚点不匹配 → `OVERLAY_ANCHOR_MISSING`（防上游漂移静默错补）。overlay 文件复制到 `<copy>/hosts/*.ts`（`./define-host` 相对导入得以解析）。
  - `runRender({ copyDir, outDir, host, bunPath })`：`bun run scripts/gen-skill-docs.ts --host <h> --out-dir <out>`。
  - `verifyOutput({ outDir, inventoryJson })`：零占位符 + 每文件含 `AUTO-GENERATED` 横幅 + 无独立 `undefined` 词元；`<hostSubdir>/skills/`（hostSubdir 默认 `.{name}`，即 `.zcode`/`.dsh`）下 `gstack-*` 目录清单化（名称+sha256，去 `gstack-` 前缀后与盘点 57 技能集合比对，缺失→`RENDER_INCOMPLETE`）；**显式断言根路由 `<hostSubdir>/skills/gstack/SKILL.md` 存在**（目录名无连字符，glob 不可见；总数=57+1）；产出 `render-manifest-<host>.json`。
  - CLI 主流程：环境门为 **AND**——`process.env.CI === 'true' && process.env.GSTACK861_RENDER === 'ci'`（缺一 → `RENDER_NOT_ALLOWED` 且零副作用；CI 测试环境天然满足 CI=true 但无环境变量，本地拒绝测试稳定）；执行前 `bun --version` 必须恰为 `1.4.2`（否则 `BUN_VERSION_PIN_VIOLATED`——固定版本声明对每条放行路径成立）；scratch 用 mkdtemp；`finally` 清理；**前后各断言子模块 pristine**（非空 → `UPSTREAM_DIRTY_RENDER`）。
- CI job：ubuntu-latest；submodules checkout；oven-sh/setup-bun（SHA 固定，`bun-version: 1.4.2`）；`GSTACK861_RENDER=ci node scripts/render-upstream.mjs`；上传两宿主渲染产物 + manifest 为 artifacts（`actions/upload-artifact` SHA 固定，`retention-days: 30`，`timeout-minutes` 与既有作业一致）。PR 与 push 都跑（尽早信号；作业本身 fail-closed）。windows-latest 不跑该 job（bun 渲染与平台无关，README 注明）。
- 本地测试（无 bun）：环境门拒绝+零残留（子进程显式设/不设两变量，覆盖 AND 语义）；`prepareCopy` 对 `repository()` 式 git fixture 全链路（archive→解包→overlay→补丁，无 bun）；`patchIndex` 对真实上游 index.ts 字面副本成功、锚点漂移 fixture 抛 `OVERLAY_ANCHOR_MISSING`；`verifyOutput` 对手工 fixture（`{{X}}` 残留→拒；缺横幅→拒；57 齐全+根存在→过；缺一→`RENDER_INCOMPLETE`；缺根→拒）；pristine 断言（干净/弄脏 fixture git 仓库）。

- [ ] 失败测试 → 确认失败 → 实现 → `npm test` 全绿 → 本地实跑编排器确认 `RENDER_NOT_ALLOWED` → 提交（分支 `b3-lane-a`）

### Task 2 (Lane B): 原生询问桥 `approvals ask`

**Files:**
- Modify: `bin/gstack861.mjs`
- Test: `test/adapters.test.mjs`

**Interfaces:**
- `approvals ask --state D --id ID --host H --session S --run R --policy-hash HASH --action-file F [--prompt-file ABS]`：
  1. 打印结构化问题 JSON（id、state、subject 摘要字段、actionDigest=subjectDigest 前 16 位、expiresAt 剩余毫秒、prompt 文本）。
  2. 阻塞读 stdin 首行：`approve` 或 `reject`（后续可选行=reason，≤256 字符写入 changedAt 旁的 `reason` 字段?——不改记录 schema，reason 仅打印回显不落盘，避免动 schema；裁决记录之）。
  3. `approve` → `print(store.approve(...))`；`reject` → `print(store.reject(...))`（输出契约=先问题 JSON 后结果 JSON，均 stdout）；答案词匹配=trim 后精确小写 `approve`/`reject`；其余词/EOF → **exit 3 `ASK_UNANSWERED`，状态保持 pending 不变**。
  4. 已过期/已消费等照常透传错误码 exit 1。
- 测试：子进程管道 stdin `approve\n` → approved；`reject\n` → rejected；EOF → exit 3 且 `approvals show` 仍 pending；坏词 → exit 3；`--prompt-file` 内容进问题 JSON；usage 文本更新。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b3-lane-b`）

### Task 3 (协调者): README、证据、摘要、终审、推送

- [ ] README：新增「上游渲染（CI 受限执行）」节（R1 裁定全文+产物获取方式）；补四个 2026-10-27 验证 JSON 链接（批次 2 遗留 Minor）；`approvals ask` 进 usage 摘要与已实现列表
- [ ] VERIFICATION 第八轮 + 摘要重算（协议顺序）；全量门禁（check/test/doctor/8dot3 两卷/verify-dsh-guard 预期 exit 2）
- [ ] 终审（独立子代理）→ 修复轮 → 推送 main → CI 绿确认（含新 render job 首跑结果记录——若 bun/渲染作业失败，如实记录失败输出与后续修复，不宣称通过）

## Deferred

- DSH toolRewrites 与 zcode ApplyPatch 词汇表：待管线级/工具名证据（渲染先用无改写配置，产物标注 experimental）；渲染产物接入 install 链（render-manifest → staging 转换）留批次 4；conformance kit 与 `full` 认证远期。
- 待用户解锁：`DEEPSEEK_API_KEY`（DSH 管线级验证+纵向）；ZCode guard 层受控新会话验收（docs/integration/zcode-acceptance.md）。
