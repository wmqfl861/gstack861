# gstack861 项目审查（2026-10-27）

- 审查对象：`wmqfl861/gstack861` @ `d89eab1`（0.2.1）
- 对照基线：`upstream.lock.json` 固定的 gstack `5755601`、ZCode `3c5b227`、DSH `22ddee3`（三者源码均已拉取核对）
- 运行环境：Linux，Node v22.23.4。`npm run check` 通过，`npm test` 100/100 通过，CI 各步骤逐一本地复跑。Windows / macOS 未运行。
- 修复状态：第 1–4 条、第 8 条的错误码、第 5 条中 `.git` 的名称检查已在分支 `claude/review-2026-10-27` 的提交 `968e8de` 中修复（见附录 A）；其余条目待处理。

## 结论

代码本身写得认真：零依赖，默认拒绝贯彻一致，测试用的是真实子进程、真实链接和双进程竞争，状态标注克制。需要优先处理的是三件事：

1. CI 已连续 4 次失败，文档没有察觉；
2. 有 4 个可稳定复现的缺陷，其中安装/卸载问题直接违背 README 的“绝不覆盖或删除用户文件”；
3. 生成器和 DSH 防护在平行重写上游 / 宿主已有的能力，而生成器目前的产物不能直接使用。

---

## 一、已复现的缺陷（建议立即修）

### 1. CI 从 3634295 起连续 4 次失败，README 命令也跑不通

- `3634295` 在 `bin/gstack861.mjs:61` 给 `inventory` 加了 `absolute()`，但 CI 最后一步和 README 都写 `--upstream upstream/gstack`（相对路径）。
- 本地复现：`node bin/gstack861.mjs inventory --upstream upstream/gstack` → `gstack861: ABSOLUTE_PATH_REQUIRED`，退出码 1；改用绝对路径则成功（57 个技能）。
- GitHub Actions：run #4–#7（3634295、f2bbeda、1c13d5e、d89eab1）全部失败；最新一次 ubuntu 与 windows 两个 job 都停在 “Inventory pinned upstream without executing its code”。
- 修复：`inventory` 对只读路径用 `path.resolve()`，或把 CI / README 改成绝对路径。

### 2. ZCode Hook 误拒含中文的大文件写入

- 位置：`bin/gstack861.mjs:41-47`，`input += chunk` 逐块把 stdin 的 Buffer 转成字符串；多字节字符跨 64 KiB 块边界时被解码成 `U+FFFD`。
- ZCode 写给 Hook 的 stdin 里 `toolInput` 有两份（camelCase 原字段 + snake_case 别名，见 ZCode `configured-runner-input.ts`）。两份在不同位置被截坏，`alias()` 判定冲突，最终 `INVALID_EVENT`。
- 实测：同一个范围内路径、20 组不同长度，ASCII 内容 20/20 放行，中文内容 20/20 被拒。
- 修复：收集 Buffer，最后 `Buffer.concat(chunks).toString('utf8')` 一次性解码。

### 3. 安装 / 卸载：三个会丢用户数据或卡死的场景（`src/install.mjs`）

| 场景 | 现在的结果 |
|---|---|
| 用户手动删除一个已安装的技能目录，再执行 `uninstall` | 永久 `USER_FILE_REFUSED`，其余技能也卸不掉，只能手改注册表。`verifyOwned`（第 198 行）把“目录不存在”也当成“不是我们的” |
| 用户修改过已安装的 SKILL.md 或放了自己的文件，再安装新版本 | `classify`（第 139–152 行）只看目录内 manifest 的 `generator`，把整个目录移进 `.gstack861-backups`，只报告为 `backedUp`；随后 `uninstall --purge` 将其删除。卸载侧已按 Codex 审计改为内容验证，安装侧没有同步 |
| 写入阶段中途出现一次 I/O 错误（Windows 上杀软 / 索引器锁文件很常见） | 留下空目录；旧版本已进备份，注册表仍指向旧摘要；之后重试 `install` 和 `uninstall` 都是 `USER_FILE_REFUSED` |

FEATURE_MATRIX 中“两阶段原子性……备份回滚均有测试”不成立：代码只有“先校验后写入”，没有回滚。

修复思路（已在 `968e8de` 实现）：安装前用与卸载相同的内容验证；每个技能先在 target 内的临时目录写完整，再用 rename 换入，并逐个提交注册表；卸载时把已不存在的目录视为已卸载。顺带让安装写入的正是校验过的那份字节，README 中列为已知边界的 staging TOCTOU 随之消除。

### 4. 嵌套仓库的 `.git` 不受保护

- `src/policy.mjs:64` 只把 `<workspace>/.git` 加入 protectedRoots。
- 实测（writeRoots = 整个工作区）：`vendor/lib/.git/hooks/pre-commit` → `IN_SCOPE`；子模块 / worktree 的 `.git` 指针文件 → `IN_SCOPE`；`.git` 文件指向的 gitdir 下的 hooks → `IN_SCOPE`。写 hooks 等于下一次 git 操作时执行任意代码。
- 修复：对目标路径相对工作区的每个分量做 `.git` 名称检查（已在 `968e8de` 实现，覆盖前两种）；gitfile 重定向的 gitdir 需要解析 `.git` 文件内容，尚未覆盖。

---

## 二、安全设计问题（源码核实，未在宿主上实跑）

### 5. Windows 8.3 短名 / 大小写不敏感文件系统可绕过 `.git` 与 protectedRoots

- 比较依赖 `path.relative` 字符串，规范化用的是 JS 版 `fs.realpathSync`；它不会把 `GIT~1` 展开为 `.git`，也不修正大小写。结果：允许名单（read/writeRoots）多拒，拒绝名单（protectedRoots、`.git`）会漏。
- Windows 上 `path.win32.relative` 已忽略大小写，所以大小写别名主要影响 macOS（默认 APFS 不区分大小写）。但 Windows 上开启 8.3 短名的卷（系统盘通常开启，用 `fsutil 8dot3name query C:` 确认）上，`C:\ws\GIT~1\config` 很可能被放行。Git 的 CVE-2014-9390 修的就是同一类问题（`.GIT` / `git~1`）。
- 建议：规范化改用 `fs.realpathSync.native`；protectedRoots 按 `(dev, ino)` 身份比较；`.git` 再叠加名称检查（`968e8de` 已加入 `git~N`、尾随点/空格、`::$` 流名的名称判断）。验证脚本见附录 B。

### 6. ZCode 下守卫看到的不一定是最终执行的输入

ZCode 源码中：

- 所有 PreToolUse Hook 依次执行，但拿到的是同一份原始输入（`hooks/runner.ts`）；
- 任一 Hook 返回的 `updatedInput` 按“最后写入者胜”合并（`hooks/output.ts` 的 `mergeHookRunResult`）；
- 合并后的输入只做 schema 校验，不会重跑 Hook（`tool/executor/call-runner.ts`）；
- 之后 PermissionRequest Hook 还能返回修改后的输入（`tool/executor/hook-flow.ts`）。

因此只要同时装了任何会改写输入的 Hook 或插件，gstack861 的 abstain 就可能作用于另一条路径。README 里“其他 Hook 顺序”需要写成明确约束（例如“不得与任何返回 updatedInput 的 Hook 共存”），并纳入宿主验收。作为对照，DSH 的 guard 在 `tools/pre-execute` 之后执行，合同明确不允许改写参数（`core/tools/src/contracts.ts`），这个接入点选得对。

### 7. “一个工具 = 一个 pathKey + 一个 effect”表达不了真实工具

- ZCode `ApplyPatch`：路径写在 `patch_text` 里，可增删改移多个文件；ZCode 匹配 Hook 时把它当作 `Write` / `Edit` 的别名（`tool/compat.ts`），但事件里的工具名仍是 `ApplyPatch`，在 gstack861 中永远是 `UNMAPPED_TOOL`。凡是走 ApplyPatch 的修改都会被拒，且无法通过绑定解决（`patch_text` 含换行，会被判非法路径）。需要专门的适配：解析补丁中的每个路径（含 move 目标）逐一评估。
- DSH `str_replace_editor`：`command`（view / create / str_replace / insert）决定读写。若为了能 view 把它绑成 `read`，实测 `create` 写进 protectedRoots 和 `.git/hooks` 都返回 `IN_SCOPE`，`compilePolicy` 不报错。建议 schema 支持按参数区分 effect（未知取值按 write），或禁止此类工具绑成 read。

### 8. 大文件写入上限实际约 512 KiB，且错误码被吞

`toolInput` 被发两份，1 MiB 上限下 520 KiB 的 Write 即被拒；拒绝原因是笼统的 `HOOK_INPUT_OR_POLICY_ERROR`，真正的 `INPUT_TOO_LARGE` 丢失。`package-lock.json` 这类文件会碰到。建议提高上限，或只解析需要的字段；至少透传错误码（`968e8de` 已做）。

---

## 三、架构方向

### 9. 生成器产物不可用，上游已有现成的多宿主系统

- 固定提交的 57 个技能全部来自 `SKILL.md.tmpl`。生成器原样复制，装进宿主的是含 `{{PREAMBLE}}`、`{{SECTION:...}}` 等未解析占位符的骨架。模板体积约为渲染后的 20%–45%：review 26 KB / 81 KB，qa 12 KB / 51 KB，office-hours 18 KB / 95 KB。
- `inventory` 正则要求 `<name>/SKILL.md`，仓库根目录的 `gstack` 路由技能（`SKILL.md.tmpl`）从未被盘点。
- 同一固定提交里，gstack 已有声明式宿主系统 `defineHost()`（`docs/ADDING_A_HOST.md`、`hosts/*.ts`）：`toolRewrites`、`pathRewrites`、`suppressedResolvers`、`capabilities`（questions 原生/文本、planMode、delegation、browser、safetyHooks enforced/advisory）、`tier`（full / experimental / instruction-only），外加 conformance kit 与以 CI 运行记录为证据的认证流程。inventory 检测的 `host-interaction`、`claude-reference`、`template-resolvers` 正是它要处理的东西。
- 建议：写 `hosts/zcode.ts`、`hosts/dsh.ts`（子模块补丁或直接向上游提 PR），用上游 `gen:skill-docs --host zcode` 渲染，先以 `experimental` 档跑通。代价是放宽“不执行上游代码”，可限定为 CI 中、固定 bun 版本、离线执行生成脚本。蓝图第 1 节自己写了“先复用上游工具和工作流”。

### 10. DSH 侧以宿主原生沙箱为主

- DSH 固定提交已有 `dsh-fs-sandbox`（按会话把文件写入限制在工作区）和进程沙箱（Linux bwrap / Landlock、macOS Seatbelt、Windows 受限令牌 + ACL），后者覆盖 shell——正是 gstack861 只能整体拒绝的部分。
- 建议以 DSH 的 workspace-write 沙箱为基础，gstack861 guard 只补 DSH 没有的：读范围限制、`.git` 与 protectedRoots。
- DSH 固定提交中的真实文件工具：`read` / `write` / `edit` / `read_image`（参数 `file_path`），`str_replace_editor`（`path` + `command`），`grep`（可选 `path`，可相对），`glob`。可直接写进示例策略。

### 11. 证据体系以 CI 为准

`scripts/check.mjs` 的 HEAD 证据门只能证明“有人在这个提交上重算过摘要”，不能证明测试跑过：`round-digests.mjs` 只改写 `testedFiles`，`commands` 中的通过数是手写的。CI 红了 4 次、文档仍逐轮记录通过，就是它的盲区，而且每次修复都多一步重算摘要。上游 gstack 的认证表直接放 Actions 运行链接。建议让 CI 绿灯成为合并门槛，VERIFICATION 记录 run 链接，弱化或移除摘要门。

---

## 四、次要问题

- `inventory()` 的 `ls-tree` / `show` 仍用 `HEAD`，而非已校验的 `actual`（`src/inventory.mjs:15,22`），“出处固定”只修了一半；生成器也没校验字节的 git blob 哈希是否等于 `manifest.blob`。
- `GENERATOR_VERSION` 仍是 `'0.2.0'`（`src/generate.mjs:9`）；`doctor` 版本硬编码，建议都读 `package.json`。
- ZCode 的 `matchesHookMatcher` 把 `*` 当作“匹配全部”（`hooks/output.ts`），`src/adapters/zcode.mjs:27` 注释和测试中“宿主无法编译 `*`”与源码不符。拒绝它无害，但说明审计结论没有对照宿主源码核实。
- `uninstall --purge` 的 `/-\d+$/` 也会匹配用户命名的 `notes-2024` 一类目录；时间戳可要求 13 位以上并核对目录内 manifest。
- TaskStore：`interrupted` 不能转 `cancelled`；没有 owner / lease，无法区分“别的进程在跑”与“进程已崩溃”。
- ApprovalStore 只存 `subjectHash`，`approvals show` 看不到要批准的内容，操作员只能凭外部信息核对。
- `generate --commit` 测试开关暴露在生产 CLI 上，而 `install` 不校验 `manifest.commit` 是否等于锁文件。
- 生成中途失败会留下半成品 staging，`install` 不检查 staging 是否完整、是否同一 host / 同一提交。
- 双进程安装竞争测试依赖忙等观察锁目录，在高负载 CI 上有偶发失败的可能。

## 五、做得好的地方

- 零依赖、模块小而清楚；默认拒绝与 fail-closed 一致（未知工具、策略错误、非法 matcher）。
- 编译后的策略冻结并用 WeakSet 防伪造；`wx` + 临时文件 + rename、锁目录、`nlink` / 符号链接检查到位。
- 测试使用真实子进程、真实符号链接 / 硬链接和双进程竞争。
- 锁文件 + 子模块固定上游；CI action 按 SHA 固定、最小权限、`persist-credentials: false`。
- DSH 本机调研文档的证据分级（实跑 / 源码 / 未验证）规范，发现了 `apply()` 抛错只告警且退出码为 0 这类关键宿主行为。

---

## 附录 A：修复提交 `968e8de`（分支 `claude/review-2026-10-27`）

- 覆盖：第 1 条（inventory 接受相对路径）、第 2 条（UTF-8 解码）、第 3 条三个场景、第 4 条（嵌套 `.git` 与指针文件）、第 5 条中 `.git` 的名称检查、第 8 条（错误码透传）。新增 5 个回归测试。
- 验证：105/105 通过；把这 5 个新测试放到 `d89eab1` 的代码上，5 个全部失败，其余 100 个通过。本轮 Linux 证据见 `docs/verification-2026-10-27-review-fixes.json`。
- 未覆盖：用户自定义 protectedRoots 的 8.3 / 大小写别名（需在 Windows / macOS 上验证后改用 `realpathSync.native` + 身份比较）；gitfile 重定向的 gitdir；第 6、7 条的设计问题。进程被强杀时可能残留 `.gstack861-tmp-*` 目录，可在下次安装时清理。

## 附录 B：Windows 8.3 短名验证脚本

脚本在 `scripts/verify-8dot3.mjs`，在 Windows 本机运行：

```sh
node scripts/verify-8dot3.mjs            # 默认在系统临时目录所在的卷上测试
node scripts/verify-8dot3.mjs D:\work    # 测试工作区实际所在的卷
```

它在指定目录下建一个一次性工作区，读取 NTFS 为 `.git` 和一个长名受保护目录生成的 8.3 短名，再让策略评估“经短名写入”是否被拒。出现绕过时打印 `RESULT: alias bypass reproduced` 并以退出码 1 结束；该卷未生成短名时不适用。本分支已对 `.git` 做名称检查，所以预期只会在自定义受保护目录上复现。

## 附录 C：核对过的上游 / 宿主源码位置

- gstack `5755601`：`docs/ADDING_A_HOST.md`、`hosts/opencode.ts`、`hosts/cursor.ts`、根目录 `SKILL.md.tmpl`
- ZCode `3c5b227`（`apps/zcode-cli/` 下）：`docs/usage/09-hooks.md`；`packages/core/src/hooks/{runner,output,configured-runner-input}.ts`；`packages/core/src/tool/{compat,path-policy,path-normalization}.ts`；`packages/core/src/tool/executor/{call-runner,hook-flow}.ts`；`packages/contracts/src/tools/{read,write,edit,apply-patch}.ts`
- DSH `22ddee3`：`packages/core/tools/src/contracts.ts`；`packages/sandbox/README.md`；`packages/fs/fs-sandbox/README.md`；`packages/fs/tool-fs/src/{read,write,edit}.ts`；`packages/fs/tool-str-replace-editor/src/index.ts`
