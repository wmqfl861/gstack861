# Transfer-only runner: preserve Git bytes across Windows line-ending defaults.
from pathlib import Path
import sys, json, hashlib, subprocess
filename = Path(__file__).with_name('apply.py')
code = filename.read_text(encoding='utf-8')
code = code.replace('p.write_text(s)', "p.write_text(s, encoding='utf-8', newline='\\n')")
code = code.replace('shutil.copyfile(assets/source,root/dest)', "(root/dest).write_bytes(subprocess.check_output(['git','show',f'HEAD:.audit-recheck/{source}']))")
exec(compile(code, str(filename), 'exec'), {'__file__': str(filename), '__name__': '__main__'})
root = Path(sys.argv[1])
p = root/'test/full-audit.test.mjs'
s = p.read_text(encoding='utf-8')
old = "  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };"
new = "  // Git for Windows does not accept Node's DEVNULL device path as a config file.\n  // A private empty file isolates user/system config identically on every platform.\n  const gitConfig = path.join(base, 'empty-git-config'); fs.writeFileSync(gitConfig, '');\n  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };"
new = new.replace('DEVNULL', chr(92)*2 + '.' + chr(92)*2 + 'nul')
assert s.count(old) == 1
p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')
p = root/'docs/AUDIT-RECHECK-2026-10-29.md'
append = "\n## Windows CI 夹具修复\n\n首次双平台复测中，Linux 通过；Windows 的三项既有 full-audit 用例均在 `git init` 前置步骤失败：Git for Windows 不接受 Node `os.devNull` 返回的 `DEVNULL` 作为配置文件。改为每个临时仓库独立的空配置文件，仍隔离用户/系统 Git 设置，原安全断言全部保留；没有跳过这三项测试或扩大超时。修复后的 Windows 结果以对应 CI 运行记录为准。\n"
append = append.replace('DEVNULL',chr(92)*2 + '.' + chr(92) + 'nul')
p.write_text(p.read_text(encoding='utf-8')+append,encoding='utf-8',newline='\n')
p = root/'docs/verification-2026-10-29-recheck.json'
d = json.loads(p.read_text(encoding='utf-8'))
b = (root/'test/full-audit.test.mjs').read_bytes()
d['windowsFixtureFix']='private empty Git config replaces os.devNull; same three security assertions retained'
d['files'].append({'path':'test/full-audit.test.mjs','sha256':hashlib.sha256(b).hexdigest(),'gitBlob':subprocess.check_output(['git','-C',str(root),'hash-object','test/full-audit.test.mjs'],text=True).strip()})
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
subprocess.run(['git','-C',str(root),'add','test/full-audit.test.mjs','docs/AUDIT-RECHECK-2026-10-29.md','docs/verification-2026-10-29-recheck.json'],check=True)
actual=subprocess.check_output(['git','-C',str(root),'write-tree'],text=True).strip()
assert actual == '8a9bf54b89b7dca95216f202b9abddd4409b7bf9', ('FINAL_TREE_MISMATCH',actual)
print('VERIFIED_FINAL_TREE',actual)
