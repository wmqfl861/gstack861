# 批次 21 计划：gstack-slug 两段移植（身份解析 + checkpoint 簿记）（2026-10-28）

## 目标

按 OFFLINE-COMPLETE §二 评估，把上游 `bin/gstack-slug`（880 行）分两段移植为零依赖 Node，外加薄 CLI：

1. **Lane A——身份 slug 解析器**：`src/remote-identity.mjs`（上游 lib/remote-identity.ts 109 行逐字移植）+ `src/slug.mjs`（解析规则 0-4 + v2 缓存 + 自愈）。
2. **Lane B——checkpoint 桶簿记**：`src/slug-checkpoints.mjs`（纯函数：分类/盖章/指针/newer-task/adopt-legacy，身份一律作参数注入——**不依赖 Lane A**）。
3. **Lane C（A+B 合并后串行）——薄 CLI**：`bin/gstack861-slug.mjs` 模式分发 + 测试。

## Lane A：src/remote-identity.mjs + src/slug.mjs + test/slug-identity.test.mjs

### remote-identity.mjs（上游 TS 孪生逐字）

- `canonicalRemote(rawUrl)`：scheme/scp/file 三路解析；userinfo/凭据/端口剥离；host ASCII 小写；尾部 `.git`/斜杠清理；hosted 规范化（Azure `v3/`+`_git`、`*.visualstudio.com→dev.azure.com`、Bitbucket `scm/`）；本地路径原样。
- `remoteSlug(canonical)`：hosted 3+ 段 → `<last-two>-<sha256(canonical) 前 16 hex>`；否则 legacy last-two 逐字节；同时返回 legacy slug（供 ID_LEGACY）。
- 净化字母表 `[^a-zA-Z0-9._-]`。

### slug.mjs（解析顺序，上游规则 0-4）

- 0. `GSTACK_PROJECT_SLUG` env 覆盖。
- 1. 自 $(pwd) 向上找**最外层**含标记（`.git`, `.project.yaml`, `package.json`, `pyproject.toml`, `Cargo.toml`, `Gemfile`, `go.mod`）的祖先=项目根；构建产物（`.vercel/.next/dist/node_modules` 等）**不是**标记。
- 2. 最外层**带 origin remote 的真 git 仓库**（`.git` 目录或 worktree/submodule 的 `.git` 文件）赢；slug=按 remote-identity 解析（owner-repo）；纯标记祖先只锚 basename 回退、不得遮蔽真 remote（2026-08-17 空壳 ~/.git 退化 bug 的修复语义）。
- 3/4. basename 回退链。
- **v2 缓存**：键=git common dir（从 `.git` 文件/目录**不 spawn git** 读出：gitfile→gitdir→commondir；主仓直读）；条目 `v2:<slug>`；未版本化旧条目重算一次并改写（pre-#3003 last-two 值保留——粘性身份）；miss 时主仓旧条目优先于当前目录旧条目；**双键写**（commondir+pwd）；毒化条目自愈改写（单发、键局部）。
- `resolveIdentity({env, cwd})` → `{slug, branch(净化当前分支), remote, projectRoot, legacySlug, formerSlugs}`；`--identity` 字段集即此。

### 测试（库级，真实目录/git fixture）

env 覆盖；标记上溯（含产物非标记负控）；空壳 ~/.git 退化修复；gitlab 3+ 段桶规则 vs GitHub 2 段不变；ssh 别名 vs https 不同 host；净化；缓存：命中零 git spawn（以 spy/计数断言）、旧条目重算改写、worktree 共享 commondir 键、毒条目自愈；`GSTACK_PROJECT_SLUG` 钉身份。

## Lane B：src/slug-checkpoints.mjs + test/slug-checkpoints.test.mjs（纯函数，身份参数化）

- `checkpointFields(file)`：仅 leading frontmatter 的 `remote:`/`project_root:`（首见优先）。
- `classifyCheckpoint(fields, {remote, projectRoot})` → `match | match-root | foreign | unstamped`（上游四态判定逐字）。
- `checkpointMeta(file)`：`<branch>↔<root>↔<worktree>↔<title>`（frontmatter + `## Working on:` 标题；缺省回退=文件名去日期前缀）。
- `normTitle`（小写、去前导日期、标点空白折叠、通用词 wip|checkpoint|save|notes|todo→空）；`ticketTokens`（`#123`、`ABC-123` 去重排序）；`pointerTarget`。
- 模式函数（身份/根路径作参数）：
  - `stampCheckpoint(file, identity)`：frontmatter 写 `remote:/project_root:/head:`（幂等：已盖不重写）。
  - `classifyCheckpoints(paths, identity)`：stdin 语义→逐路径状态行。
  - `checkpointsBelow(cwd, stateRoot, identity)`：列 cwd 之下**其他桶**的 checkpoint+指针。
  - `pointFrom(dir, checkpointFile, stateRoot)`：嵌套仓保存指针。
  - `newerTask(branch, candidates, identity)`：同名任务较新 checkpoint。
  - `adoptLegacy({mode: review|copy|from|dismiss}, …)`：预 #3003 桶审阅/复制/合并/除名；`.former-slugs` 记录；上游唯一 `/dev/tty` 交互确认→Node 以 stdin 行读取实现（非 TTY 可测），账本记录。
- 测试：四态分类矩阵；meta 解析（含日期回退）；normTitle/ticketTokens 边界；盖章幂等；below/point-from/newer-task 场景；adopt 四模式（review/copy/from/dismiss，from 合并后 former-slugs 清理）；指针跟随。

## Lane C（合并 A+B 后串行子代理）：bin/gstack861-slug.mjs + test/slug-cli.test.mjs

- 模式：default（打印 `SLUG=`/`BRANCH=`）、`--identity`、`--get NAME`（白名单 SLUG|BRANCH|PROJECT_REMOTE|PROJECT_ROOT|LEGACY_SLUG|FORMER_SLUGS，exit 2）、六个 checkpoint 模式（参数校验同上游 usage 文本）。
- **状态根（原生映射，账本记录）**：上游 `~/.gstack` + state-root 链 → 本项目 `GSTACK861_STATE_ROOT` env 或缺省 `~/.gstack861`（**绝不触碰 `~/.gstack`**——用户可能有上游安装）；账本记此为安全映射差异。
- 输出经 `SLUG_ALPHABET` 净化（shell 注入防线，逐字）；`--help` 移植。
- CLI 测试：全模式主路径 + `--get` 白名单拒绝 + 净化 + 隔离状态根（env 指向 temp，绝不写真实 home——断言）。

## 密钥预算

0（全离线）。

## 文档与版本（最终 HEAD）

0.4.20；VERIFICATION 第二十九轮；OFFLINE-COMPLETE §二 slug→ported（两段+CLI）；FEATURE_MATRIX 辅助工具注记；证据 JSON；摘要重算。

## 流程

计划 → 独立审计划 → Lane A/B 并行 → 合并 → Lane C 串行 → 独立审成果（整批含 CLI 胶水）→ 0.4.20 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| remote-identity 规则移植偏差 | 逐字移植 TS 孪生（比 bash 少一层）；向量测试（gitlab/github/azure/bitbucket/ssh 别名/本地路径） |
| 缓存"零 git spawn"难证 | resolveIdentity 接受注入 git runner（计数 spy）；命中路径断言零调用 |
| adopt-legacy 交互移植走样 | 唯一交互点定位（上游 870 行 read </dev/tty）；stdin 行读取等价实现+账本 |
| 状态根污染真实 home | 隔离默认+测试断言只写 env 指向的 temp 根 |
| B 误依赖 A | 纯函数纪律：身份全参数化，B 的 import 列表禁止出现 slug.mjs（审查检查项） |

## 非目标

- redact/issue-links（后续批次）。
- 上游 TODOS.md 中的退化桶数据迁移（上游明示"不要在此加数据迁移"）。
- `~/.gstack` 兼容读写（安全边界：不触碰）。

## 审计划必改落实（2026-10-28，独立审计划 6 项）

1. **remote-identity API 形状**：TS 孪生是三个导出——`canonicalRemote(raw)→{canonical,hosted,segments}`、`legacyRemoteSlug(url)→string`（独立，pre-#3003 逐字节）、`remoteSlug(url)→string`（仅新 slug）；"同时返回 legacy"是 bash 孪生行为。`resolveIdentity().remote` = **canonical remote 字符串**（如 `github.com/owner/repo`）非 slug。
2. **canonicalRemote 补四分支**：scp 的 Windows 盘符排除（`!/^[A-Za-z]:([/\]|$)/`，win32 载重）；IPv6 `[..]` host 先于端口切分；空 URL→空 canonical；本地路径 keepRoot 尾斜杠（`/` 存活；hosted 剥空）。规范化补：`*.visualstudio.com` 剥 DefaultCollection **并前插 org 段**；Bitbucket `scm/` 仅 `host!=="dev.azure.com"&&segments>=3` 时剥。测试向量补盘符+IPv6。
3. **标记两层制**：STRONG（.git/.project.yaml/package.json/pyproject.toml/Cargo.toml/Gemfile/go.mod）+ WEAK（README.md/README/README.rst/LICENSE/LICENSE.md）；最外 STRONG 胜、否则最外 WEAK。**机制是 allow-list 非产物 denylist**（产物名只出现在注释）——按 allow-list 移植。
4. **未版本化缓存规则纠正（原计划写反）**：保留旧值**除了** cached===hosted 3+ 段 remote 的 legacy slug 且新 slug 不同 → **升级为哈希 slug** 并置 LEGACY_NOTICE（一次性 stderr，仅旧桶目录存在时）——这正是 #3003 桶迁移点。
5. **stampCheckpoint 四字段刷新式**：`remote:`（ID_REMOTE 非空时）、`project_root:`、`worktree:`（盖章 cwd 的 git toplevel≠ID_ROOT 时）、`head:`（当前 HEAD）；awk 语义=删除旧字段行重插新值（head 每次刷新），**非**已盖跳过。
6. **模式 I/O 契约定死**：below=本桶指针恒出+**仅在 git 外**（GIT_COMMON_DIR 空）列他桶 checkpoint，读上限 200 文件名降序、输出 head-20、cwd==HOME 时按项目根去重（每项目最新一条）；point-from=指针 JSON `{checkpoint,bucket,project_root}` 落 `projects/<start-slug>/checkpoint-pointers/<stem>--<bucket>.json`、校验 checkpoint 在 `projects/<bucket>/checkpoints/`、同桶静默 exit 0、**递归重解析** start 目录 slug；newer-task 签名补 cwd git 拓扑参数（`here`=cwd toplevel、`main`=commondir 父目录当 basename==.git）——首行候选必须是目标分支否则 exit 0、后续按文件名前 15 字符过滤、匹配=异分支+（worktree 在主仓下|normTitle 等非空|共享 ticket token）、输出 `NEWER_TASK <path>`。

另采纳建议：零 git spawn 测试须避开两个自愈形状（#1125：cached==pwd-basename 而根≠pwd；2026-08-17：cached==root-basename 且根 .git origin 失效而下方有真 remote 仓）；MAIN_CACHE_FILE=commondir 父目录键（basename==.git 时）、读序 commondir→MAIN→pwd；`--identity` 的 %q 引用换 Node 等价并账本；**两个日期剥离正则不得合并**（meta 回退 `^[8d]-[6d]-?` vs normTitle 全日期时间形）；ticketTokens 从**标题+分支**提取；缓存键 `tr '/' '_'` 的 win32 行为定死并账本；`GSTACK_PROJECT_SLUG` 净化后 `.`/`..` 忽略且**永不写缓存**；homedir 回退用 os.homedir()；.former-slugs 追加触发条件（非 pwd 键命中+legacy pwd 条目异非退化 slug+旧桶非空）。目录布局：`<root>/slug-cache/<key>`（`v2:<slug>`）、`<root>/projects/<slug>/checkpoints/*.md`、`checkpoint-pointers/*.json`、`.former-slugs`。
