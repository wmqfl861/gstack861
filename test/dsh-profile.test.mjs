import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageDshProfile } from '../src/dsh-profile.mjs';

function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g861-dsh-profile-')));
 const workspace=path.join(root,'workspace'), outside=path.join(root,'private');
 fs.mkdirSync(workspace); fs.mkdirSync(outside); const skills=path.join(workspace,'.dsh','skills'); fs.mkdirSync(skills,{recursive:true});
 const policy=path.join(outside,'policy.json'), adapter=path.join(root,'dsh.mjs');
 fs.writeFileSync(policy,JSON.stringify({schemaVersion:1,workspace,readRoots:[workspace],writeRoots:[],protectedRoots:[],bindings:{zcode:{},dsh:{}}}),{mode:0o600});
 fs.writeFileSync(adapter,'export const name="gstack861-guard";');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,workspace,policy,adapter,skills,output:path.join(root,'profile')};
}
test('generates DSH profile with complete dependency chain and local adapter shim',t=>{
 const f=fixture(t),r=stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills});
 assert.equal(r.status,'scaffolded-not-host-verified');
 const patch=fs.readFileSync(path.join(f.output,'cordis.patch.yml'),'utf8');
 assert.ok(patch.indexOf('system-prompt')<patch.indexOf('id: tools'));
 assert.ok(patch.indexOf('id: tools')<patch.indexOf('id: gstack861-guard'));
 assert.match(patch,/gstack861-skills/);
 const pkg=JSON.parse(fs.readFileSync(path.join(f.output,'package.json')));
 assert.equal(pkg.dependencies['gstack861-guard'],'file:./plugins/gstack861-guard');
 assert.ok(fs.readFileSync(path.join(f.output,'plugins/gstack861-guard/index.mjs'),'utf8').includes(new URL('file://'+f.adapter).href));
});
test('refuses existing output without touching operator files',t=>{
 const f=fixture(t); fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output,'notes'),'keep');
 assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills}),/OUTPUT_EXISTS/);
 assert.equal(fs.readFileSync(path.join(f.output,'notes'),'utf8'),'keep');
});
test('refuses workspace-contained policy, symlinked adapter and missing skills root',t=>{
 const f=fixture(t),inside=path.join(f.workspace,'policy.json'); fs.writeFileSync(inside,fs.readFileSync(f.policy));
 assert.throws(()=>stageDshProfile({output:f.output,policyPath:inside,adapterPath:f.adapter,skillsDir:f.skills}),/POLICY_MUST_BE_OUTSIDE/);
 const g=fixture(t); fs.symlinkSync(g.adapter,path.join(g.root,'link'));
 assert.throws(()=>stageDshProfile({output:g.output,policyPath:g.policy,adapterPath:path.join(g.root,'link'),skillsDir:g.skills}),/ADAPTER_FILE_REQUIRED/);
 const h=fixture(t); assert.throws(()=>stageDshProfile({output:h.output,policyPath:h.policy,adapterPath:h.adapter,skillsDir:path.join(h.root,'missing')}),/SKILLS_DIR_INVALID/);
});
test('rejects invalid profile name and malformed policy before creating output',t=>{
 const f=fixture(t); assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills,profileName:'../bad'}),/INVALID_PROFILE_NAME/);
 fs.writeFileSync(f.policy,'{'); assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills}),/POLICY_FILE_INVALID/);
 assert.equal(fs.existsSync(f.output),false);
});
