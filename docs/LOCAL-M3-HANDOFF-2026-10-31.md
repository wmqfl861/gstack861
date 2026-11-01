# LOCAL M3 本地验收交接文档（给独立审核 / 合并决策代理）— 2026-10-31

> 读者：负责总体设计、独立审核与最终交付的审核代理（ChatGPT）。
> 目的：在本仓库内自含地交接「gstack861 本地环境接手与三大模块完整验收任务」的全部实际结果、
> 可复核入口与剩余边界，请求合并决定。本地 Agent 职责到本文档推送为止。

## 1. 一页式结论

| 项 | 实际结果 |
|---|---|
| 任务基线 | PR #3 `680b2f19b2dbef8831e3be1fd996203589b5c41d`（远端未前进，实际以该基线展开） |
| 交付分支 | `audit/local-m3-windows-20261030`（独立分支；未推 main、未强推、未覆盖远端并行成果） |
| 代码修复头部 | `69b0d93de54099b430348f59595fda09528101bc`（seam 修复） |
| 分支最终头部 | `fe3fcae7451b6c32b2660521c1064a8a2927e1f9`（docs 快照） |
| 托管 CI | `69b0d93` → run [41173120891](https://github.com/wmqfl861/gstack861/actions/runs/41173120891)：ubuntu ✅ / **windows ✅** / render ✅；`fe3fcae` → run [41173536944](https://github.com/wmqfl861/gstack861/actions/runs/41173536944)：✅ |
| 全量测试 | 1383 tests / 1363 pass / 0 fail / 20 skip（零设备注入、Node 24.21.0、锁定 Node 22.16.0 三环境一致） |
| 三模块 | 命令别名 51/51+固定源 4/4；DSH Profile 49/49 + 真实宿主 5/5（零模型）；ZCode 配置 99/99 + CLI；共享安装器 110/110 |
| 独立审核链 | 每轮计划 APPROVE → 实现 → 成果 APPROVE（修复全程共 5 轮独立复审，最后两轮 agent_3966d0e5） |
| 最高优先级规则 | 无违反：无 main 推送/强推、无绕过 CI、无放宽断言/删测试、无付费模型或 API Key 调用、无全局依赖变更、用户既有 ZCode/DSH 配置零修改、`.superpowers/` 未提交、失败与 flake 原始记录全保留 |

## 2. 修复链摘要（基线 → 头部）

| 提交 | 内容 | CI |
|---|---|---|
| `39fe7c1` | 三模块宿主生命周期加固 + 验收证据（首轮交付） | Windows 失败（exit 1 无细节） |
| `1f3bd47` | CI 诊断管线（PIPESTATUS 数组、有界注解、BigInt 元数据、失败工件）→ 取得 Windows 失败硬证据 | 用于取证 |
| `f4d1bd3` | Windows 身份分裂修复：lstat/stat dev=0 vs fstat dev≠0（同 ino/kind）→ 保存「完整原始路径身份 + path-free descriptor witness」，零设备路径用独立只读打开绑定保存 witness；Ubuntu/render 绿，Windows 256→6 | Windows 6 用例失败 |
| `69b0d93` | 残余 6 用例注入 seam 修复（见 §3） | **三任务全绿** |
| `fe3fcae` | 报告附录 H.7 + CI 快照（docs-only） | 绿 |

## 3. 残余 6 用例的根因与修复（审核重点）

- **复现**：`ci-followup/residual-seam/preload-zero-device.mjs` 注入 runner 实测分裂后，6/6 用例本地失败与托管注解**逐字一致**；零设备全量基线恰 6 失败（协调者与独立审核代理分别跑出）。
- **根因（单一共享）**：dev=0 路径下每个生成文件在数据 fd 生命周期内新增只读 witness open/close 流量；旧注入 seam 按「文件名匹配的任意 close」或「lstat dev === fstat dev」触发 → 注入在错误时机（witness close 时 wx fd 仍钉住目录，Windows 对含打开句柄目录 rename 失败，注入半途而废）或永不触发。失败状态下产品行为全部为**正确拒绝**（STAGING_NOT_EMPTY / 保留 operator 数据 / fail-closed）——测试装置过时，非产品缺陷。
- **修复**：仅 `test/aliases.test.mjs`（4 处 close 钩子加 `'wx'` 写 fd 门控）、`test/fs-utils.test.mjs:259`（close 故障 `readFailed` 门控，只在主读错误后的清理 close 抛）、`test/install.test.mjs:1708`（去掉恒为假的 dev 合取，按 ino 匹配）。**src/ 零改动**（五文件冻结 SHA256 前缀 cbff271d/02eaf82f/131d1b21/4f098532/0c525632 修复前后逐字符相同）；全部断言与错误集合逐字保留。
- **验证**：定向 6/6；零设备/Node24/Node22 隔离全量均 1383/1363/0/20；Node22 直跑 check（119 模块）/offline（9/9）/doctor 全 exit 0；并行过载 flake（4 例，均不在修改集）保留对照日志并以隔离串行重跑排除。

## 4. 复核入口（全部在分支上）

| 材料 | 路径 |
|---|---|
| 验收报告（A–H 节，含 CI 后续附录） | `docs/LOCAL-M3-ACCEPTANCE-2026-10-30.md` |
| 本轮证据（20 文件 + SHA256 清单） | `docs/evidence/local-m3-2026-10-30/ci-followup/residual-seam/`（`copied-evidence.json` 为逐文件清单） |
| 历史 236 文件证据清单 | `docs/evidence/local-m3-2026-10-30/sha256-manifest.json` |
| 真实 Windows 失败注解（f4d1bd3） | `ci-followup/residual-seam/ci-f4d1bd3-windows-annotations.json` |
| 双 CI 快照 | 同目录 `ci-69b0d93-run.json` / `ci-69b0d93-jobs.json` |
| seam 修复 diff + 计划 + 双审核报告 | 同目录 `residual-seam-diff-review.diff`、`residual-seam-fix-plan.md`、`residual-seam-plan-review.md`、`residual-seam-result-review.md` |

### 可直接执行的复核命令（win32/任意平台）

```bash
git fetch origin audit/local-m3-windows-20261030
git rev-parse origin/audit/local-m3-windows-20261030   # 期望 fe3fcae7451b...
git diff f4d1bd3..69b0d93 -- src/                       # 期望空输出（src 零改动）
git diff f4d1bd3..69b0d93 --stat                        # 期望仅 3 测试文件+文档+证据
node --test test/*.test.mjs                             # 期望 1383/1363/0/20
```

哈希核对（应与上文前缀一致）：`src/fs-utils.mjs` cbff271d…、`src/aliases.mjs` 02eaf82f…、`src/install.mjs` 131d1b21…、`src/dsh-profile.mjs` 4f09853…、`src/zcode-profile.mjs` 0c525632…。

## 5. 保持 OPEN 的边界（未因本轮关闭）

1. **ZC-07**：portable Node 路径复查不能防止最终 syscall 内的恶意同用户替换（最终门仍需 OS 原子性/宿主侧防线）。
2. **已批准的线性 sweep 时序权衡**：两次外层扫描间「完全恢复的瞬时祖先替换」可能失去内部观察机会（f4d1bd3 审核批准的披露，非本轮引入）。
3. **witness close-fault 覆盖缺口**：`readFailed` 门控后 `independentDescriptor` 的 close 故障分支失去意外覆盖（fail-closed；后续独立用例候补）。
4. **ZCode 真实宿主验证**：需授权的隔离 home/用户配置环境；本轮只完成适配器协议控制。
5. **完整上游渲染缺 Bun**；**DSH 原生文件工具 / 模型消费**未验证（真实宿主验收为零模型、4 插件 ACTIVE、真实 tools.execute 管线）。

## 6. 请求审核代理决定

1. 复核 §4 清单（尤其：断言未放宽、src 未动、CI 真实、规则遵守）。
2. 合并决定：是否将 `audit/local-m3-windows-20261030`（`fe3fcae`）并入开发主线；如何与远端并行分支（曾前进至 `3b4ee5b`）整合或要求 rebase。
3. §5 各 OPEN 项的后续排期归属（本地 Agent 不再自行展开）。

合并前注意：本分支含对 `.gitignore` 忽略规则的 `git add -f` 证据日志（与既有 166 个证据日志同一实践）；`docs/evidence/**` 有 `.gitattributes` `* -text` 字节保全。
