from pathlib import Path
import sys, shutil, subprocess
root = Path(sys.argv[1])
assets = Path(__file__).parent
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip() == 'bc929e6a1aa87b3422e5d22d58754cd89d6e4a84'
p=root/'src/json.mjs'
s=p.read_text().replace("if (Object.keys(value).length !== value.length) throw new Error('SPARSE_ARRAY');", "// A hole plus an unrelated property can have the same key count as length.\n      // Require the exact dense index set; otherwise [<hole>] could hash like [].\n      const keys = Object.keys(value);\n      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('SPARSE_ARRAY');")
p.write_text(s)
p=root/'src/install.mjs'
s=p.read_text()
start=s.index('    // Inside the lock only: clear temp entries')
end=s.index('    assertRegistryPathSafe(target);',start)
s=s[:start]+'''    // A temporary-looking name is not proof of ownership. In particular, a
    // failed preflight must not delete an operator's recovery files. Only clean
    // the unique directory THIS invocation created (the per-item finally below).
    // Preserve old orphans for explicit operator recovery rather than guessing.
'''+s[end:]
p.write_text(s)
p=root/'test/install.test.mjs'
s=p.read_text().replace("installSkills cleans leftover .gstack861-tmp-* entries under the lock and touches nothing else", "installSkills preserves unproven temporary-prefix entries and touches nothing else")
s=s.replace("assert.ok(!fs.existsSync(orphan), 'a crashed run\\'s temp directory must be cleaned inside the lock');", "assert.equal(fs.readFileSync(path.join(orphan, 'SKILL.md'), 'utf8'), 'half-written orphan', 'a name alone cannot authorize recovery-file deletion');")
s=s.replace("assert.ok(!fs.existsSync(path.join(target, '.gstack861-tmp-2222')));", "assert.equal(fs.readFileSync(path.join(target, '.gstack861-tmp-2222'), 'utf8'), 'a plain leftover file with our prefix');")
s=s.replace("assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, 'alpha', 'user-dir', 'user-file.txt']);", "assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, '.gstack861-tmp-2222', '.gstack861-tmp-deadbeef-1111', 'alpha', 'user-dir', 'user-file.txt']);")
p.write_text(s)
p=root/'src/stage.mjs'
s=p.read_text()
pos=s.index('// Inventory name ->')
s=s[:pos]+'''// Resolve the existing prefix without creating output directories. This catches
// output aliases through an ancestor symlink/junction, including non-existing leaves.
function realOutput(value) {
  const suffix = [];
  let current = path.resolve(value);
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      const real = fs.realpathSync.native(current);
      if (suffix.length && !fs.statSync(real).isDirectory()) fail('INVALID_STAGING');
      return path.join(real, ...suffix);
    }
    const parent = path.dirname(current);
    if (parent === current) fail('INVALID_STAGING');
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

'''+s[pos:]
s=s.replace("  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byString(a.name, b.name));\n  for (const entry of entries) {", "  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byString(a.name, b.name));\n  const names = new Set();\n  for (const entry of entries) {\n    const folded = entry.name.toLowerCase();\n    if (names.has(folded)) fail('RENDER_TREE_INVALID');\n    names.add(folded);")
s=s.replace("    const segments = [...prefix, entry.name];\n    if (entry.isDirectory())", "    const segments = [...prefix, entry.name];\n    assertSubPath(segments); // bound depth before descending, not after reaching a file\n    if (entry.isDirectory())")
s=s.replace("  if (contains(rendered, staging) || contains(staging, rendered)) fail('OVERLAPPING_PATHS');", "  const realRendered = fs.realpathSync.native(rendered), realStaging = realOutput(staging);\n  if (contains(realRendered, realStaging) || contains(realStaging, realRendered)) fail('OVERLAPPING_PATHS');")
s=s.replace("  const skillsRoot = path.join(rendered, `.${host}`, 'skills');\n  let entries;", "  const hostRoot = path.join(rendered, `.${host}`), skillsRoot = path.join(hostRoot, 'skills');\n  for (const dir of [hostRoot, skillsRoot]) {\n    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });\n    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('RENDER_TREE_INVALID');\n  }\n  let entries;")
p.write_text(s)
p=root/'src/model-review.mjs'
s=p.read_text()
pos=s.index('/** Stop reading as soon')
s=s[:pos]+'''// Cancellation itself is best-effort cleanup, never an unbounded prerequisite
// for reporting a timeout/refusal. Observe a rejected cancel promise, but do not
// await a transport-controlled promise that is allowed to remain pending.
function cancelQuietly(stream) {
  try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch { /* already locked/closed */ }
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

'''+s[pos:]
s=s.replace('async function boundedText(response) {','async function boundedText(response, signal) {')
s=s.replace('    const text = await response.text();','    const text = await abortable(response.text(), signal);')
s=s.replace('      const { done, value } = await reader.read();','      const { done, value } = await abortable(reader.read(), signal);')
s=s.replace("    if (!complete) { try { await reader.cancel(); } catch { /* preserve the original refusal */ } }\n    reader.releaseLock();", "    if (!complete) cancelQuietly(reader);\n    try { reader.releaseLock(); } catch { /* preserve the original refusal */ }")
s=s.replace(" * (redirect: 'error'), the request is armed with AbortSignal.timeout(timeoutMs), and every", " * (redirect: 'error'), one deadline covers headers, body and cleanup, and every")
s=s.replace("  // 4. The single capped call.\n  let response;", "  // Validate the entire wait budget before dispatch; Node's timer must not coerce\n  // an out-of-range value to 1 ms. Keep it referenced until the request settles.\n  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw fail('INVALID_REVIEW_TIMEOUT');\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(new DOMException('Review deadline exceeded', 'TimeoutError')), timeoutMs);\n  try {\n  // 4. The single capped call.\n  let response;")
s=s.replace("    response = await fetchImpl(joinUrl(gateway.baseUrl, 'chat/completions'), {", "    const dispatched = Promise.resolve(fetchImpl(joinUrl(gateway.baseUrl, 'chat/completions'), {")
s=s.replace("      signal: AbortSignal.timeout(timeoutMs),\n    });", "      signal: controller.signal,\n    }));\n    // An injected transport can ignore abort and eventually return a response.\n    // Dispose that late body rather than leaving an unread connection behind.\n    dispatched.then(late => { if (controller.signal.aborted) cancelQuietly(late?.body); }, () => {});\n    response = await abortable(dispatched, controller.signal);")
s=s.replace("  if (response.status >= 300 && response.status < 400) throw fail('GATEWAY_ERROR', `(redirect refused; status ${response.status})`);\n  if (!response.ok) throw fail('GATEWAY_ERROR', `(status ${response.status})`); // never echo the body", "  if (response.status >= 300 && response.status < 400) { cancelQuietly(response.body); throw fail('GATEWAY_ERROR', `(redirect refused; status ${response.status})`); }\n  if (!response.ok) { cancelQuietly(response.body); throw fail('GATEWAY_ERROR', `(status ${response.status})`); } // never echo the body")
s=s.replace('try { text = await boundedText(response); }','try { text = await boundedText(response, controller.signal); }')
s=s.replace("  return freeze({ verdict, findings: findings.map(value => redact(value, key)), usage: redactValue(payload.usage ?? null, key) });\n}", "  return freeze({ verdict, findings: findings.map(value => redact(value, key)), usage: redactValue(payload.usage ?? null, key) });\n  } finally { clearTimeout(timer); }\n}")
start=s.index('  // 4. The single capped call.')
end=s.index('  } finally { clearTimeout(timer); }',start)
s=s[:start]+''.join('  '+line if line.strip() else line for line in s[start:end].splitlines(keepends=True))+s[end:]
p.write_text(s)
for source, dest in [('regression.mjs','test/recheck-audit.test.mjs'),('report.md','docs/AUDIT-RECHECK-2026-10-29.md'),('verification.json','docs/verification-2026-10-29-recheck.json')]:
    shutil.copyfile(assets/source,root/dest)
p=root/'README.md'
s=p.read_text();s+='\n## 2026-10-29 二次复核\n\n在既有全库审核分支上修复网关等待/响应清理、安装误删临时项、渲染路径链接与大小写冲突，以及稀疏数组规范化碰撞。详见 [复核报告](docs/AUDIT-RECHECK-2026-10-29.md) 和 [测试摘要](docs/verification-2026-10-29-recheck.json)。安装器不再仅凭 `.gstack861-tmp-*` 前缀删除旧文件，历史临时项需操作员核对；只自动清理本次创建的临时目录。\n';p.write_text(s)
subprocess.run(['git','-C',str(root),'add','README.md','src/install.mjs','src/json.mjs','src/model-review.mjs','src/stage.mjs','test/install.test.mjs','test/recheck-audit.test.mjs','docs/AUDIT-RECHECK-2026-10-29.md','docs/verification-2026-10-29-recheck.json'],check=True)
actual=subprocess.check_output(['git','-C',str(root),'write-tree'],text=True).strip()
assert actual == 'eb1be0bad006f9d5a57c9017efff131421700f30', ('TREE_MISMATCH',actual)
print('VERIFIED_TREE',actual)
