# 宿主装载 runbook（渲染技能 → ZCode 工作区；DSH 边界）

日期：2026-10-27（批次 5）。范围：操作员把上游渲染技能**装载进宿主技能目录**的可复现步骤：`stage-render`（渲染树 → staging）→ `install`（staging → 目标技能目录）→ 新会话验收观察 → `uninstall` 回滚；以及 DSH 侧的机制差异与待验证项。

与 [ZCode 受控接入验收手册](zcode-acceptance.md) 的分工：那本手册覆盖 **PreToolUse 守卫 Hook** 的接入与验收（走宿主设置文件）；本手册覆盖**渲染技能的目录装载**（走宿主技能目录）。两套机制互不相交，本文不重复守卫验收内容。

## 0. 状态与出处约定（先读）

每条断言标注出处，三类（同 zcode-acceptance.md）：

- **[仓库已验证]**：本仓库测试（`npm test`）覆盖的行为（标注实现/测试文件），含本机真实渲染产物全链实跑（[批次 4 证据](../verification-2026-10-27-batch4.json)）。
- **[固定提交源码]**：从固定提交上游源码读出、未执行的结论（gstack `5755601`；ZCode 宿主 `3c5b227`）。
- **[验收项]**：宿主侧行为，本仓库不断言结果，须由操作员在新会话中实测确认并回填。

**「待实测」标注约定**：本手册由批次 5 Lane A 先行成稿；ZCode 装载路径的每个命令节成稿时标「待实测」，由批次 5 Task 3 在临时 fixture 工作区实跑后回填为「已实测」并附证据。**合并而未回填 = 未验证**——只要任一「待实测」标注还在，宿主侧装载就不得视为已验证，宿主状态保持 `not-host-verified`（`npm run doctor`）。

付费模型调用：装载命令本身 0 次（纯文件操作，不经过模型）；新会话验收对话产生的宿主调用按宿主自身计费规则，与本项目无关。

## 1. 装载链总览

```text
CI 渲染 / 本地维护者复现          stage-render                        install
rendered/.zcode/skills/<dir>  ──►  staging/<盘点名>/             ──►  <target>/<盘点名>/
+ render-manifest-zcode.json       SKILL.md + 辅助文件                SKILL.md + 辅助文件
                                   + manifest.json                    + manifest.json
                                                                     + .gstack861-registry.json（target 根）
```

- **渲染**：`scripts/render-upstream.mjs`（仅 CI 或维护者 `CI=true` + `GSTACK861_RENDER=ci` 通道，bun 1.4.2），产物每宿主 57 技能 + 根路由 `gstack`，附 `render-manifest-<host>.json`（记录各 SKILL.md 摘要）；经 CI artifacts（30 天）获取。**[仓库已验证]**（`test/render-upstream.test.mjs`；[批次 3](../verification-2026-10-27-batch3.json)/[批次 4](../verification-2026-10-27-batch4.json) 证据）。
- **staging**：`stage-render` 把渲染树 + render-manifest 转换为 `install` 可消费的 staging——逐技能校验（AUTO-GENERATED 横幅、零未解析占位符、SKILL.md 字节摘要、辅助文件递归清点）全部通过后，按**盘点名**落盘，并写入逐技能 `manifest.json`（含辅助文件摘要表）。**[仓库已验证]**（`src/stage.mjs`；`test/stage.test.mjs`）。
- **安装**：`install --staging S --target T` 先全量校验 staging、再逐技能原子写入，target 根的注册表 `.gstack861-registry.json` 是卸载信任锚。**[仓库已验证]**（`src/install.mjs`；`test/install.test.mjs`）。

批次 4 已在本机用真实渲染产物实跑过全链（临时目录，**非宿主工作区**）：`57 技能 + 根 → 安装 58 → 幂等重装 skip 58 → 卸载清空`，篡改场景 `USER_FILE_REFUSED`（[批次 4 证据](../verification-2026-10-27-batch4.json)）。第 2 节把同一链路落成针对 ZCode 工作区的操作步骤；命令对宿主工作区的实跑属批次 5 Task 3。

## 2. ZCode 工作区装载（本批实测对象）

### 2.1 前提

1. Node.js 22+、本仓库检出（`npm run check` 通过）。渲染产物来源二选一：CI artifacts 下载解包，或本地维护者复现（`CI=true GSTACK861_RENDER=ci node scripts/render-upstream.mjs --upstream ... --out ...`，须恰好 bun 1.4.2）。
2. 一个**受控试验工作区**（fixture）。装载点是其工作区级技能目录 `<workspace>/.zcode/skills/`；**绝不写入用户级 `~/.zcode`**（本仓库硬约束：用户级目录禁改）。
3. `--rendered`/`--staging`/`--target` 必须是绝对路径，相对值由 CLI 的路径包装层以 `gstack861:ABSOLUTE_PATH_REQUIRED` 拒绝（`bin/gstack861.mjs` 的 `absolute()`，退出码 1；同一包装层在 approvals 路径上有测试覆盖，`test/adapters.test.mjs`）。**[仓库已验证]** 库层的 `INVALID_RENDERED`/`INVALID_STAGING`/`INVALID_TARGET` 只出现在**绝对但非法**的值上（不存在、非目录、符号链接等，`src/stage.mjs`/`src/install.mjs`）。（`--manifest` 例外：允许相对，按 cwd 解析，`bin/gstack861.mjs`。）
4. （操作建议，非断言）Windows（Git Bash）下路径参数建议直接写 `C:/...` 形式（Node 正斜杠合法）；避免 `/c/...` 形式——按 Node 的 win32 路径语义（`path.win32` 把无盘符的 `/...` 视为「当前盘符根下」），它会解析为当前盘符根下的 `\c\...`，不是 Git Bash 的挂载点含义。

### 2.2 第一步：stage-render（渲染树 → staging）「已实测 2026-10-27，证据：docs/verification-2026-10-27-render-consumption.md」

```sh
node bin/gstack861.mjs stage-render \
  --rendered /abs/rendered \
  --manifest /abs/render-manifests/render-manifest-zcode.json \
  --host zcode \
  --staging /abs/staging-zcode
```

`--rendered` 指渲染输出根目录（其下须存在 `.zcode/skills/`）；`--manifest` 指该轮的 `render-manifest-zcode.json`；`--staging` 必须不存在或为空目录，且与 `--rendered` 互不包含。

预期输出（stdout JSON；数值以实际渲染轮次为准，批次 4 真实产物为 57 技能 + 根、30 个辅助文件）。**[仓库已验证]**（`src/stage.mjs`；`test/stage.test.mjs`）：

```json
{
  "schemaVersion": 1,
  "host": "zcode",
  "staging": "/abs/staging-zcode",
  "staged": 57,
  "files": 30,
  "root": { "name": "gstack", "sha256": "<sha256>", "files": 0 }
}
```

要点：

- staging 下每技能一个目录，**目录名 = 盘点名**（根路由为 `gstack`）；目录内为 `SKILL.md` + 辅助文件（多文件技能的 `sections/` 等，按渲染树原样逐字节复制）+ `manifest.json`。
- 任何校验失败——摘要不符、占位符残留、缺 AUTO-GENERATED 横幅、树与清单集合不一致、staging 非空、路径重叠——**零写入整体拒绝**，退出码 1，错误码 `gstack861:RENDER_TREE_INVALID` / `gstack861:RENDER_MANIFEST_INVALID` / `gstack861:STAGING_NOT_EMPTY` / `gstack861:OVERLAPPING_PATHS`（路径重叠）等。

### 2.3 第二步：install（staging → 工作区技能目录）「已实测 2026-10-27，证据：docs/verification-2026-10-27-render-consumption.md」

```sh
node bin/gstack861.mjs install \
  --staging /abs/staging-zcode \
  --target <workspace>/.zcode/skills
```

**target 即技能目录本身**：每个技能落为 target 的**一个子目录**（不是在 target 下再嵌套一层安装根）。target 不存在时自动连同父目录创建（0755）。

预期输出（stdout JSON，`installed` 为 staging 全部名字的列表，含根路由 `gstack`）。**[仓库已验证]**（`src/install.mjs`；`test/install.test.mjs`）：

```json
{ "installed": ["…58 个名字（盘点名 + gstack）…"], "skipped": [], "backedUp": [] }
```

装载后布局：

```text
<workspace>/.zcode/skills/
  review/                  ← 每技能一个子目录（目录名 = 盘点名）
    SKILL.md               ← 渲染正文（frontmatter name == 目录名，见第 3 节）
    sections/…             ← 多文件技能的辅助文件（如有）
    manifest.json          ← gstack861 逐技能安装清单（注册表记录与之对照）
  gstack/                  ← 根路由技能（同样含 SKILL.md + manifest.json）
  …（其余技能，同构）
  .gstack861-registry.json ← 卸载信任锚（首次安装后常驻 target 根）
```

要点（全部 **[仓库已验证]**）：

- 幂等：同内容重装返回 `skipped` 全量、技能目录零写入（注册表文件仍会重写、`updatedAt` 刷新，`src/install.mjs`）；版本漂移（SKILL.md 摘要或辅助文件表不一致）先备份再替换，旧目录移入 `.gstack861-backups/<name>-<13位毫秒时间戳>/`，`backedUp` 列出。
- 只动自己的名字：与 staging 名字不冲突的既有目录一律不读不写（与 fixture 工作区既有技能可共存）；名字冲突且目标非本项目产物 → `USER_FILE_REFUSED` 整体拒绝、零写入。
- 互斥锁：安装/卸载期间 target 根短暂存在 `.gstack861-install.lock/`；崩溃残留的锁使后续操作以 `INSTALL_BUSY` 拒绝，须人工检查后删除，不自动清理。

### 2.4 新会话验收观察项（不宣称结果）

装载完成后，**在该工作区新开 ZCode 会话**逐项观察并记录（清单风格同 zcode-acceptance.md 第 6 节）。以下全部为**验收项**——ZCode 对工作区级 `.zcode/skills/` 的实际拾取行为本仓库未验证，预期栏只写观察点、不写结论：

| # | 项 | 操作 | 观察点 | 出处 |
|---|---|---|---|---|
| A | 新会话自动拾取 | 装载完成后在该工作区新开 ZCode 会话，查看技能列表/系统提示 | 渲染技能（如 `review`、根路由 `gstack`）是否出现、能否触发。**自动拾取需新会话，未验证，属用户解锁项（受控 ZCode 新会话）** | 验收项 |
| B | 多余条目容忍度 | 同上会话中观察装载目录 | 技能目录内除 `SKILL.md`（及 `sections/`）外还有逐技能 `manifest.json`；技能根还有常驻 `.gstack861-registry.json`、漂移时的 `.gstack861-backups/`、安装瞬间的 `.gstack861-install.lock/`。**ZCode 对这些多余条目的容忍度未知**——若宿主拒绝加载或报错，如实记录 | 验收项 |
| C | 内容一致性 | 触发任一已装载技能，对照 staging 中同名 `SKILL.md` | 技能按渲染内容行事；frontmatter `name`/`description` 与目录名一致（第 3 节） | 验收项 |
| D | 回滚后恢复 | 执行 2.5 后再开新会话 | 技能不再出现；干净移除 | [仓库已验证] 卸载语义（离线）+ 验收项（会话内） |

结果（无论通过与否）回填 `docs/verification-*.json` 对应轮次；在此之前宿主认证状态不升级。

### 2.5 回滚（uninstall）「已实测 2026-10-27，证据：docs/verification-2026-10-27-render-consumption.md」

```sh
node bin/gstack861.mjs uninstall --target <workspace>/.zcode/skills
```

- 只删除**注册表记录且内容校验仍属本项目**的技能目录；用户改过的技能或目录内多余文件 → `USER_FILE_REFUSED` 整体拒绝、零删除。**[仓库已验证]**
- 卸载后残留：`.gstack861-registry.json` 保留（`skills` 清空为 `[]`）；`.gstack861-backups/` 保留，除非加 `--purge`——只删除同时满足 `<name>-<13位时间戳>` 命名且目录内 `manifest.json` 仍证明为本项目生成的备份，用户放入备份目录的其他内容保留。**[仓库已验证]**
- 工作区内与本项目无关的既有技能目录不受影响。收尾可按需删除整个 fixture 工作区。

## 3. 目录名 = frontmatter name = 盘点名（一致性说明）

- **渲染树的形态**：上游渲染器以 `externalSkillName` 规则输出目录 `gstack-<name>`（已带 `gstack-` 前缀的名字直通，根路由为 `gstack`），而 ZCode overlay 使用 `defineHost` 默认 frontmatter（未设 `nameMatchesDirectory`），SKILL.md 的 `name:` 保持**裸盘点名**。**[固定提交源码]**（gstack `5755601`：`scripts/external-skill-names.ts`、`scripts/gen-skill-docs.ts` 的 `fmName` 分支、`hosts/define-host.ts` 默认 frontmatter）
- **因此不要把 `rendered/.zcode/skills` 原样拷进宿主技能目录**：目录名会是 `gstack-review` 而 frontmatter 是 `name: review`，两者不一致；且没有逐技能 `manifest.json` 与注册表锚，无法走 `install` 的漂移备份与 `uninstall` 的所有权校验。
- **stage-render 正是归一化步骤**：staging 目录名 = frontmatter name = 盘点名（三者一致），`install` 原样落盘到 target。此一致性按**源码链**成立：渲染目录名由 `externalSkillName` 从「frontmatter name（缺省回落到模板目录名）」派生，frontmatter `name:` 本身是模板原名（`gen-skill-docs.ts` 的 `fmName` 分支，ZCode 未设 `nameMatchesDirectory`），stage-render 又按同一盘点名落盘——**[固定提交源码]**（gstack `5755601`：`scripts/external-skill-names.ts`、`scripts/gen-skill-docs.ts`）+ **[仓库已验证]** 落盘部分（`src/stage.mjs` 按盘点名落盘；`test/stage.test.mjs` 断言 staging manifest `name`）。注意：本仓库测试用的是合成渲染树，**不解析 SKILL.md frontmatter**；批次 4 的树/清单集合相等门比对的是**渲染目录名**与清单键，通过结果与上述源码链一致（佐证），但三段一致本身的依据是源码而非仓库测试。
- **上游 `nameMatchesDirectory` 注意点**：该 host 配置位（gstack `docs/ADDING_A_HOST.md` 的 `frontmatter.nameMatchesDirectory`）为「按 frontmatter name 索引/去重技能的宿主」把 `name:` 改写为 `gstack-<skill>`，避免裸名（如 `review`）被宿主内其他同名技能遮蔽。本项目 ZCode overlay **刻意未设**（无证据不虚报宿主行为，见 `hosts-overlay/zcode.ts` 头注）。若 2.4 的 A/B 项实测发现 ZCode 按 frontmatter name 索引且裸名会被遮蔽，应回到 overlay 增设该位并重渲染，而不是手工改已装载的 SKILL.md——当前对此不做断言。

## 4. DSH 侧（机制差异，如实）「待 DSH 侧验证」

DSH **没有 gstack 式技能目录**：无目录自动扫描，技能/能力装载走 Cordis profile 插件机制。ZCode 的「目录装载」路径在 DSH 不存在对应物，本批**不提供 DSH 装载命令**，只如实记录。本节沿用调研文档的证据标记体系（**[源码]** = 从本机安装的 asar 内包源码读出未执行；**[实跑]** = 调研中真实执行的命令与输出），出处均指向该文档：

1. **插件发现机制**（[DSH 本机调研](dsh-local-findings.md) 第 2 节）：profile 为 `$DSH_HOME/profiles/<name>/`，插件条目经 `cordis.patch.yml` 组合声明，无目录扫描。**[源码]**（本机 0.2.1-rc.3）
2. **配置格式与隔离**（同调研第 3 节）：YAML patch 列表、`config` 整值替换不合并、`DSH_HOME` 环境变量整体隔离 harness home。**[实跑]**（调研冒烟）
3. **渲染产物的当前可用形态**：`rendered/.dsh` 树（57 技能 + 根，与 ZCode 侧同构渲染）**可作为上下文/文档注入**——把渲染出的 `SKILL.md` 及其 `sections/` 作为参考资料交给会话（例如放入项目文档目录或按需附上），属上下文注入式消费，**不构成宿主技能装载**。
4. **插件式技能装载——已验证至 activation-tested（2026-10-27 批次 10b）**：`gstack861-skills` 插件（`src/adapters/dsh-skills.mjs`）经 `systemPrompt.section` 注入技能索引（读取 install 链目标目录与注册表，sha256 信任锚，fail-closed）；无密钥三控实测通过（干净激活/坏目录拒绝/无 systemPrompt 服务 pending）——证据 `docs/verification-2026-10-27-batch10b.json` 与调研文档批次 10b 附录。**运行时消费半边待 DEEPSEEK_API_KEY（边界①），且届时策略 readRoots 须覆盖技能目录**（否则运行时测试假失败）；机制细节见调研第 2/3 节与附录。

## 5. 证据与回填

- 本手册 ZCode 命令节（2.2/2.3/2.5）已由批次 5 Task 3 于 2026-10-27 在 fixture 工作区实跑并回填「已实测」；证据见 `docs/verification-*.json` 与渲染技能消费流程文档。
- DSH 节保持「待 DSH 侧验证」，不随批次 5 回填。
- 宿主认证状态不因本手册合并而改变：在 2.4 观察项全部实测回填前，ZCode/DSH 保持 `not-host-verified`（`npm run doctor`）。
