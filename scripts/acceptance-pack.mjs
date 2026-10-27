#!/usr/bin/env node
// Controlled acceptance pack generator (batch 10a unlock aid). Usage:
//   node scripts/acceptance-pack.mjs --out ABS_DIR [--rendered DIR --manifest FILE --host zcode]
//
// One command builds a ready-to-open acceptance pack under --out (which must be absolute
// and absent or empty; moving the finished pack invalidates every baked path):
//   OUT/workspace/        git-initialized fixture workspace with an editable src/notes.md
//                         (mixed Chinese/English content; GIT_INIT_FAILED leaves nothing behind)
//   OUT/policy.json       guard policy: workspace=OUT/workspace, readRoots=[workspace],
//                         writeRoots=[workspace/src] (a proper subset, so the out-of-scope
//                         checklist row has a real target), Read/Write/Edit on file_path,
//                         written with explicit mode 0o600 and self-validated through the
//                         real loadPolicy before the pack is declared generated
//   OUT/hook-snippet.json zcodeHookConfig output (this process.execPath + the repo CLI +
//                         this policy, matcher 'Read|Write|Edit') for the operator to merge
//   OUT/STEPS.md          step-by-step walkthrough quoting the manual checklists verbatim
//                         (zcode-acceptance.md §5 probes + §6 rows A–H; host-loading.md
//                         §2.4 rows A/B) with this pack's real absolute paths substituted
//                         in forward-slash form, plus absolute-path links to both manuals
//   OUT/staging-zcode/ + OUT/workspace/.zcode/skills/   only with --rendered (all three of
//                         --rendered/--manifest/--host binding, host must be zcode):
//                         stageRender into OUT/staging-zcode — KEPT, because §2.4 row C
//                         compares a loaded skill against the same-name staged SKILL.md —
//                         then installSkills into the workspace skills dir.
//
// Refusals (all UPPER_SNAKE, printed as 'gstack861: CODE' on stderr, exit 1): ABSOLUTE_PATH_REQUIRED
// (relative --out / relative --rendered), OUT_EXISTS (existing non-empty --out),
// INVALID_ARGUMENTS (missing --out / incomplete --rendered trio), INVALID_HOST (host other
// than zcode), GIT_INIT_FAILED (git missing or failing), and any stageRender/installSkills
// refusal passes its own code through verbatim — in every case no partial pack is left.
// Zero dependencies, node:* only, writes nothing outside --out, zero model calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { stageRender } from '../src/stage.mjs';
import { installSkills } from '../src/install.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const CLI = path.join(REPO, 'bin', 'gstack861.mjs');
const MANUAL_HOOK = path.join(REPO, 'docs', 'integration', 'zcode-acceptance.md');
const MANUAL_LOAD = path.join(REPO, 'docs', 'integration', 'host-loading.md');

const fail = code => { throw new Error(code); };
/** Forward-slash form of a native path: valid for Node on win32, Git Bash friendly, and
 *  stable in the baked STEPS.md/policy.json/hook-snippet.json bytes. */
const fwd = p => p.split(path.sep).join('/');
const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('ABSOLUTE_PATH_REQUIRED');
  return value;
};
function flags(tokens, allowed) {
  const result = {};
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key) || !tokens[i + 1] || tokens[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    result[key] = tokens[i + 1];
    i++;
  }
  return result;
}

// The editable fixture file: lives inside writeRoots, mixed 中文/English so acceptance
// runs also exercise multi-byte content handling through the guard.
const NOTES_MD = `# 验收笔记 Acceptance notes

受控验收 fixture（controlled acceptance fixture）。This file lives inside writeRoots — ask the model to read and edit it.

- 中文与 English 混排，顺带验证多字节内容处理（mixed-script content exercises multi-byte handling）。
- writeRoots 只包含本 src/ 目录（writeRoots covers this src/ directory only）；workspace 其余位置只读。
- 越界写示例目标（out-of-scope target）：workspace 根下的 notes.txt —— 在 workspace 内、writeRoots 外。
`;

/** The STEPS.md walkthrough. Manual checklist rows are quoted VERBATIM (zcode-acceptance §6
 *  rows A–H and host-loading §2.4 rows A/B); generated absolute paths are substituted into
 *  the 操作 column as parenthetical additions (row D replaces the manual's `workspace/.git/`
 *  placeholder directly). §2.4 C/D stay pointers because C compares against this pack's
 *  staging and D depends on the §2.5 rollback, both described inline. */
function stepsMd({ out, workspace, srcDir, policyPath, hookPath, staging, skillsTarget, withSkills }) {
  const O = fwd(out), W = fwd(workspace), SRC = fwd(srcDir);
  const NOTES = fwd(path.join(srcDir, 'notes.md'));
  const OOS = fwd(path.join(workspace, 'notes.txt'));
  const GITCFG = fwd(path.join(workspace, '.git', 'config'));
  const POL = fwd(policyPath), HOOK = fwd(hookPath), RESULTS = fwd(path.join(out, 'RESULTS.md'));
  const BIN = fwd(CLI), M1 = fwd(MANUAL_HOOK), M2 = fwd(MANUAL_LOAD), REPOF = fwd(REPO);
  const STG = fwd(staging), SKL = fwd(skillsTarget);
  const contents = [
    `| \`${W}\` | 受控试验工作区（已 git init；可编辑文件 \`${NOTES}\` 位于 writeRoots 内） |`,
    `| \`${POL}\` | 守卫策略：workspace=\`${W}\`、readRoots=[\`${W}\`]、**writeRoots=[\`${SRC}\`]**（proper 子集，使「越界写」项有真实目标）、protectedRoots=[]、只绑 Read/Write/Edit（file_path）、dsh 空；mode 0o600；生成时已用 loadPolicy 真实加载自校验 |`,
    `| \`${HOOK}\` | zcode-config 生成的 PreToolUse Hook 片段（matcher \`Read\\|Write\\|Edit\`；command=node、args 指向仓库 CLI 与本策略） |`,
    `| 本文件 | 逐步验收指引（清单项逐字引自两份手册，操作列代入本包真实路径） |`,
  ];
  if (withSkills) {
    contents.push(`| \`${STG}\` | stage-render 产物（**保留**，供第 5 节 C 项对照同名 SKILL.md） |`);
    contents.push(`| \`${SKL}\` | 已装载的渲染技能（install 链路落盘，target 根含 \`.gstack861-registry.json\`） |`);
  }
  const loading = withSkills
    ? `本包已把渲染技能装载到 \`${SKL}\`（staging 保留于 \`${STG}\`）。下表 A/B 两行逐字引自 host-loading.md §2.4（「§2.x」为该手册的节）：`
    : `**技能未装载**（本次生成未提供 \`--rendered\`）：host-loading.md §2.4 的观察项——尤其 A「新会话自动拾取」——须先把渲染技能装载进工作区技能目录 \`${W}/.zcode/skills/\`（按该手册 §2.2 stage-render + §2.3 install；或用本脚本带 \`--rendered\` 重新生成整包）才能验收，故本文件不引用该清单行。`;
  const observedRows = withSkills ? `
| # | 项 | 操作 | 观察点 | 出处 |
|---|---|---|---|---|
| A | 新会话自动拾取 | 装载完成后在该工作区新开 ZCode 会话，查看技能列表/系统提示 | 渲染技能（如 \`review\`、根路由 \`gstack\`）是否出现、能否触发。**自动拾取需新会话，未验证，属用户解锁项（受控 ZCode 新会话）** | 验收项 |
| B | 多余条目容忍度 | 同上会话中观察装载目录 | 技能目录内除 \`SKILL.md\`（及 \`sections/\`）外还有逐技能 \`manifest.json\`；技能根还有常驻 \`.gstack861-registry.json\`、漂移时的 \`.gstack861-backups/\`、安装瞬间的 \`.gstack861-install.lock/\`。**ZCode 对这些多余条目的容忍度未知**——若宿主拒绝加载或报错，如实记录 | 验收项 |

- C（内容一致性）：观察点见 host-loading.md §2.4 C 行——触发任一已装载技能，对照 staging 中同名 \`SKILL.md\`；本包 staging 已保留于 \`${STG}\`，「目录名 = frontmatter name = 盘点名」的一致性说明见该手册 §3。
- D（回滚后恢复）：先按该手册 §2.5 卸载（命令见本文件第 6 节）再开新会话；预期见 §2.4 D 行。
` : '\n';
  const skillsRollback = withSkills
    ? `- 技能（如已装载）：host-loading.md §2.5：\`node "${BIN}" uninstall --target "${SKL}"\`。\n`
    : '';
  return `# 受控验收开箱包 STEPS（gstack861 acceptance pack）

由 \`${fwd(SCRIPT)}\` 生成。**所有路径均为生成时的绝对路径（正斜杠 C:/ 形式）；移动本包目录会使全部烘焙路径失效**（policy.json、hook-snippet.json、本文件中的命令与清单）——请用原参数重新生成，勿手工改路径（同 [zcode-acceptance.md](${M1}) 第 4 节第 4 点：信任摘要绑定命令内容，移动仓库/策略文件或换 node 后须重新合并并重新确认）。

**验收方法：在 \`${W}\` 新开 ZCode 会话 → 按第 4/5 节清单逐项核对 → 把结果逐项记录到 \`${RESULTS}\`（自行创建）并连同本包交回项目。**在此之前宿主认证状态保持 \`not-host-verified\`（\`npm run doctor\`）。

## 0. 本包含什么

| 路径 | 内容 |
|---|---|
${contents.join('\n')}
${withSkills ? '' : '\n本包**未装载渲染技能**（生成时未提供 \`--rendered\`）——见第 5 节说明。\n'}

## 1. 前提

- 仓库检出位于 \`${REPOF}\`（\`npm run check\` 通过）；后续 Hook 使用的 node 即 \`${process.execPath}\`。
- 手册原文（绝对路径链接）：[zcode-acceptance.md](${M1}) · [host-loading.md](${M2})。下文「第 N 节」均指 zcode-acceptance.md 的节号，另注明的除外。

## 2. 离线探针（合并前先跑，不需要宿主；不经模型，0 次付费调用）

以下三条逐字引自手册第 5 节，\`/absolute/...\` 占位已代入本包真实路径（Git Bash）：

\`\`\`sh
# 范围内写（writeRoots 内、不存在的文件）：应输出 {} 且 exit 0
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"${SRC}/new-file.txt"}}' \\
  | node "${BIN}" hook zcode --policy "${POL}"; echo "exit=$?"

# 越界写（workspace 内但不在 writeRoots）：应输出下方 deny 且 exit 2
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"${OOS}"}}' \\
  | node "${BIN}" hook zcode --policy "${POL}"; echo "exit=$?"

# 受 VCS 保护路径：应 deny gstack861:PROTECTED_PATH 且 exit 2
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"${GITCFG}"}}' \\
  | node "${BIN}" hook zcode --policy "${POL}"; echo "exit=$?"
\`\`\`

预期输出形态与拒绝码一览见手册第 5 节（放行 = 弃权：stdout \`{}\`、exit 0，**空结果不是预批准**；拒绝：exit 2、\`permissionDecision: "deny"\` JSON，理由 \`gstack861:OUTSIDE_SCOPE\` 等）。

探针 3 注（诚实对照，勿记为缺陷）：本包策略 writeRoots=[\`${SRC}\`]，\`.git/\` 路径不在写根内，守卫先按范围拒绝——实测码为 \`gstack861:OUTSIDE_SCOPE\`（同为 deny、exit 2）；\`gstack861:PROTECTED_PATH\` 是写根覆盖该路径时的拒绝码（如 writeRoots=[整个 workspace]，[仓库已验证] \`test/policy.test.mjs\`「VCS metadata remains protected when the whole workspace is writable」）。两条码均为有效拒绝；探针判据是「被拒且未静默放行」。

## 3. 合并 Hook 片段并确认信任摘要（新会话）

按手册第 4 节：备份设置 → 把 \`${HOOK}\` 的 \`hooks\` 节合并进 ZCode 设置（合并前逐字审查 \`command\` 与 \`args\`）→ 创建**新会话**，核对 trust digest 与片段中 \`command\`+\`args\` 完全一致后才信任。该片段不改写任何文件、不自动授予 Hook 信任（手册第 3 节）。

## 4. 新会话验收清单（手册第 6 节，八行 A–H 逐字引用）

下表逐字引自手册第 6 节（「第 4 节」「第 7 节」为该手册的节）；操作列在原文之后以括注代入本包真实绝对路径（正斜杠，D 行的 \`workspace/.git/\` 占位直接代入）。逐项执行并把结果记录到 \`${RESULTS}\`。

| # | 项 | 操作 | 预期 | 出处 |
|---|---|---|---|---|
| A | 安装生效 | 完成第 4 节后在新会话发起一次范围内 Read（如 \`${NOTES}\`） | 宿主加载了 Hook（无启动报错）；读取正常 | 验收项 |
| B | 放行 = 弃权，不越过宿主权限 | 让模型写 \`writeRoots\` 内文件（如 \`${NOTES}\`） | 守卫不拦截；**宿主自身权限提示/策略仍照常生效**（守卫永不预批） | [仓库已验证] 弃权语义（\`src/adapters/zcode.mjs\` 注释）+ \`test/adapters.test.mjs\`「abstaining result」；宿主侧表现为验收项 |
| C | 越界拒 | 让模型写 \`writeRoots\` 外、workspace 内文件（如 \`${OOS}\`） | 工具调用被拒，理由含 \`gstack861:OUTSIDE_SCOPE\`；目标文件未被创建 | [仓库已验证] 同上探针；会话内链路为验收项 |
| D | VCS 保护 | 让模型改 \`${W}/.git/\` 下文件（如 \`${GITCFG}\`） | 拒绝 \`gstack861:PROTECTED_PATH\` | 同 C |
| E | 启动失败 fail-closed | 临时把片段中 \`--policy\` 指向不存在的路径（或临时改坏策略文件权限）再触发一次范围内调用；随后还原（本包策略文件：\`${POL}\`） | 该次调用被拒（\`gstack861:HOOK_INPUT_OR_POLICY_ERROR\` 或策略专属码），**绝不静默放行**；用第 5 节探针可离线复现诊断 | [仓库已验证] \`test/adapters.test.mjs\`「denies invalid JSON, missing policy, and oversized payloads」 |
| F | 超时行为 | 在**一次性验收用**设置里把 \`timeoutMs\` 改为 \`1\`，触发一次范围内调用，观察并记录宿主处置（放行/拒绝/报错）；测完还原 \`10000\` | 记录实测结果。本仓库**不断言**宿主超时语义——\`timeoutMs: 10000\` 只是片段设定值 | 片段值 [仓库已验证]；超时处置为验收项（README「仍需宿主级验证」） |
| G | updatedInput 共存禁令 | 审计该设置里**所有其他** Hook/插件：任何一个都**不得**返回 \`updatedInput\` | 必须为 0 个，否则本守卫验收不通过（见下） | [固定提交源码] 审查报告 §二.6 |
| H | 回滚 | 见第 7 节 | 干净移除，无残留 | [仓库已验证] 未改写任何文件 + 验收项 |

G 项依据原文（updatedInput「最后写入者胜」合并、合并后只做 schema 校验不重跑 Hook 等）见手册第 6 节表后段落。

D 项注（诚实对照，勿记为缺陷）：本包策略 writeRoots=[\`${SRC}\`]，\`${W}/.git/\` 下路径不在写根内，会话内实际拒绝码为先触发的 \`gstack861:OUTSIDE_SCOPE\`（同为拒绝）；\`gstack861:PROTECTED_PATH\` 是写根覆盖 .git 时的拒绝码（[仓库已验证] \`test/policy.test.mjs\`「VCS metadata remains protected when the whole workspace is writable」）。两码均为有效拒绝——本项判据是「被拒且 .git 未被改动」；如需实测 PROTECTED_PATH 码，可临时用 writeRoots=[整个 workspace] 的策略变体复测（勿用于其余项）。

## 5. 渲染技能装载观察（host-loading.md §2.4）

${loading}
${observedRows}
## 6. 回滚

- 守卫：手册第 7 节（还原设置备份或删除合并进去的 \`hooks\` 节 → 新开会话确认无 \`gstack861:\` 拒绝；策略文件可保留或删除）。
${skillsRollback}- 收尾：验收结果记录交回后，本包目录 \`${O}\` 可整体删除。

## 7. 记录结果并交回

把第 2/4/5 节逐项结果（命令、输出摘要、时间、环境）记录到 \`${RESULTS}\`（自行创建），连同本包交回项目——在此之前 ZCode 宿主层保持 \`not-host-verified\`（手册第 9 节）。

## 手册原文

- [zcode-acceptance.md](${M1})——守卫验收手册（第 4 节合并与信任、第 5 节探针、第 6 节清单、第 7 节回滚）
- [host-loading.md](${M2})——技能装载 runbook（§2.2 stage-render、§2.3 install、§2.4 观察项、§2.5 卸载）
`;
}

/**
 * Build the pack. Every refusal (ours, loadPolicy's, stageRender's, installSkills') throws
 * its own UPPER_SNAKE code with no partial pack left behind: entries this run created are
 * removed in reverse order, and --out itself only when it did not exist before.
 */
export function buildAcceptancePack({ out, rendered, manifestFile, host }) {
  if (typeof out !== 'string' || !path.isAbsolute(out)) fail('ABSOLUTE_PATH_REQUIRED');
  const existing = fs.lstatSync(out, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || fs.readdirSync(out).length > 0)) fail('OUT_EXISTS');
  const fresh = !existing;
  const withSkills = rendered !== undefined || manifestFile !== undefined || host !== undefined;
  // The render trio is binding, like stage-render's flags: any one without the others
  // refuses before a single byte is read or written.
  if (withSkills && (rendered === undefined || manifestFile === undefined || host === undefined)) fail('INVALID_ARGUMENTS');
  // The skills leg installs into workspace/.zcode/skills — a zcode-shaped pack only.
  if (withSkills && host !== 'zcode') fail('INVALID_HOST');
  const staging = path.join(out, 'staging-zcode');
  const workspace = path.join(out, 'workspace');
  const srcDir = path.join(workspace, 'src');
  const policyPath = path.join(out, 'policy.json');
  const hookPath = path.join(out, 'hook-snippet.json');
  const stepsPath = path.join(out, 'STEPS.md');
  const skillsTarget = path.join(workspace, '.zcode', 'skills');
  const created = [];
  let stageInfo = null;
  let installInfo = null;
  try {
    if (withSkills) {
      created.push(staging);
      // Refusals (INVALID_RENDERED, RENDER_*_INVALID, STAGING_NOT_EMPTY, OVERLAPPING_PATHS,
      // ...) pass through verbatim; stageRender itself guarantees zero staging bytes.
      stageInfo = stageRender({ rendered, manifestFile, host, staging });
    }
    fs.mkdirSync(workspace, { recursive: true });
    created.push(workspace);
    // git init first: a machine without git must fail before anything else is built.
    const gitRun = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8' });
    if (gitRun.error !== undefined || gitRun.status !== 0) fail('GIT_INIT_FAILED');
    // src/ must exist before the policy is written: loadPolicy's directory() check requires
    // every root to be a real directory on disk.
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'notes.md'), NOTES_MD);
    fs.writeFileSync(policyPath, `${JSON.stringify({
      schemaVersion: 1,
      workspace: fwd(workspace),
      readRoots: [fwd(workspace)],
      writeRoots: [fwd(srcDir)],
      protectedRoots: [],
      bindings: {
        zcode: {
          Read: { effect: 'read', pathKey: 'file_path' },
          Write: { effect: 'write', pathKey: 'file_path' },
          Edit: { effect: 'write', pathKey: 'file_path' },
        },
        dsh: {},
      },
    }, null, 2)}\n`, { mode: 0o600 });
    created.push(policyPath);
    // Self-check: the pack's own probes assume this exact policy loads for real. Any
    // policy-layer refusal (its own UPPER_SNAKE code) propagates with cleanup.
    loadPolicy(policyPath);
    fs.writeFileSync(hookPath, `${JSON.stringify(zcodeHookConfig({
      nodePath: process.execPath, cliPath: fwd(CLI), policyPath: fwd(policyPath), matcher: 'Read|Write|Edit',
    }), null, 2)}\n`);
    created.push(hookPath);
    if (withSkills) {
      installInfo = installSkills({ staging, target: skillsTarget });
      created.push(skillsTarget);
    }
    // STEPS.md last: it reports the skills-loading state that is now actually true.
    fs.writeFileSync(stepsPath, stepsMd({ out, workspace, srcDir, policyPath, hookPath, staging, skillsTarget, withSkills }));
  } catch (error) {
    for (const entry of created.reverse()) fs.rmSync(entry, { recursive: true, force: true });
    if (fresh) fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
  return {
    out: fwd(out), workspace: fwd(workspace), policy: fwd(policyPath), hookSnippet: fwd(hookPath),
    steps: fwd(stepsPath), skillsLoaded: withSkills,
    ...(withSkills ? {
      staging: fwd(staging), skills: fwd(skillsTarget),
      staged: stageInfo.staged, installed: installInfo.installed,
    } : {}),
  };
}

const USAGE = `Usage: node scripts/acceptance-pack.mjs --out ABS_DIR [--rendered DIR --manifest FILE --host zcode]
Generates a controlled acceptance pack (ready to open in a NEW ZCode session):
  OUT/workspace          git-initialized fixture workspace (editable OUT/workspace/src/notes.md)
  OUT/policy.json        guard policy: read = whole workspace, write = workspace/src ONLY,
                         Read/Write/Edit bound, written 0o600, self-validated with loadPolicy
  OUT/hook-snippet.json  PreToolUse hook snippet (matcher Read|Write|Edit) to merge by hand
  OUT/STEPS.md           step-by-step walkthrough quoting the manual checklists verbatim
                         (zcode-acceptance.md section 5 probes + section 6 rows A-H;
                         host-loading.md section 2.4 rows A/B) with real absolute paths
                         substituted, plus absolute-path links to both manuals
With --rendered (ALL THREE of --rendered/--manifest/--host binding, --host must be zcode):
  also stage-render into OUT/staging-zcode (kept for the section 2.4 row-C comparison) and
  install the rendered skills into OUT/workspace/.zcode/skills via the standard chain.
Refusals: ABSOLUTE_PATH_REQUIRED / OUT_EXISTS (non-empty OUT) / INVALID_ARGUMENTS /
  INVALID_HOST / GIT_INIT_FAILED, plus stage-render and install codes passed through verbatim.
All generated paths are baked: moving OUT invalidates them — regenerate instead.
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const options = flags(args, ['--out', '--rendered', '--manifest', '--host']);
    if (options['--out'] === undefined) fail('INVALID_ARGUMENTS');
    const pack = buildAcceptancePack({
      out: absolute(options['--out']),
      rendered: options['--rendered'] === undefined ? undefined : absolute(options['--rendered']),
      manifestFile: options['--manifest'] === undefined ? undefined : path.resolve(options['--manifest']),
      host: options['--host'],
    });
    process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`gstack861: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SCRIPT);
if (invoked) main();
