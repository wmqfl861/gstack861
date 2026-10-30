import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planZcodeConfig, applyZcodeConfigPlan, planZcodeUninstall } from '../src/zcode-profile.mjs';

function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g861-zcode-profile-'))); fs.mkdirSync(path.join(root,'.zcode'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,nodePath:process.execPath,cliPath:path.join(root,'bin','gstack861.mjs'),policyPath:path.join(root,'private','policy.json')};
}
test('merges workspace hook config while preserving unrelated settings and existing hooks',t=>{
 const f=fixture(t),file=path.join(f.root,'.zcode','config.json');
 const existing={theme:'dark',hooks:{enabled:true,events:{PreToolUse:[{matcher:'Write',hooks:[{type:'command',command:'other'}]}],Stop:[{matcher:'.*',hooks:[{type:'command',command:'stop'}]}]}}};
 fs.writeFileSync(file,JSON.stringify(existing));
 const plan=planZcodeConfig(f),r=applyZcodeConfigPlan(plan);
 assert.equal(r.changed,true);
 const config=JSON.parse(fs.readFileSync(file));
 assert.equal(config.theme,'dark'); assert.equal(config.hooks.events.Stop.length,1);
 assert.equal(config.hooks.events.PreToolUse.length,2);
});
test('apply is idempotent and uninstall removes only the exact owned hook',t=>{
 const f=fixture(t),first=planZcodeConfig(f); applyZcodeConfigPlan(first);
 const second=planZcodeConfig(f); assert.equal(second.changed,false); assert.equal(applyZcodeConfigPlan(second).changed,false);
 const remove=planZcodeUninstall(f); assert.equal(remove.changed,true); applyZcodeConfigPlan(remove);
 const final=JSON.parse(fs.readFileSync(path.join(f.root,'.zcode','config.json')));
 assert.equal(final.hooks,undefined);
});
test('optimistic concurrency refuses config changes between plan and apply',t=>{
 const f=fixture(t),plan=planZcodeConfig(f);
 fs.writeFileSync(path.join(f.root,'.zcode','config.json'),JSON.stringify({userSetting:true}));
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
});
test('refuses malformed, symlinked, hardlinked and disabled configs',t=>{
 const f=fixture(t),file=path.join(f.root,'.zcode','config.json');
 fs.writeFileSync(file,'{'); assert.throws(()=>planZcodeConfig(f),/ZCODE_CONFIG_INVALID/);
 fs.unlinkSync(file); fs.writeFileSync(file,'{}'); const link=path.join(f.root,'alias.json'); fs.linkSync(file,link);
 assert.throws(()=>planZcodeConfig(f),/ZCODE_CONFIG_UNSAFE/);
 fs.unlinkSync(file); fs.unlinkSync(link); fs.writeFileSync(file,JSON.stringify({hooks:{enabled:false}}));
 assert.throws(()=>planZcodeConfig(f),/ZCODE_HOOKS_DISABLED/);
});
test('refuses symlinked .zcode directory and preserves foreign hooks on uninstall',t=>{
 const f=fixture(t); fs.rmdirSync(path.join(f.root,'.zcode')); const elsewhere=path.join(f.root,'elsewhere'); fs.mkdirSync(elsewhere);
 fs.symlinkSync(elsewhere,path.join(f.root,'.zcode'));
 assert.throws(()=>planZcodeConfig(f),/ZCODE_CONFIG_DIR_UNSAFE/);
});
