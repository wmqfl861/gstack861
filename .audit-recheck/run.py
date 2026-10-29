# Transfer-only runner: preserve Git bytes across Windows line-ending defaults.
from pathlib import Path
import sys
filename = Path(__file__).with_name('apply.py')
code = filename.read_text(encoding='utf-8')
code = code.replace('p.write_text(s)', "p.write_text(s, encoding='utf-8', newline='\\n')")
code = code.replace('shutil.copyfile(assets/source,root/dest)', "(root/dest).write_bytes(subprocess.check_output(['git','show',f'HEAD:.audit-recheck/{source}']))")
exec(compile(code, str(filename), 'exec'), {'__file__': str(filename), '__name__': '__main__'})
