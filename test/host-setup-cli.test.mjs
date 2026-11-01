import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli=fileURLToPath(new URL('../bin/gstack861.mjs',import.meta.url));
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g861-host-cli-')));
 const workspace=path.join(root,'workspace'),outside=path.join(root,'private'),skills=path.join(workspace,'.dsh','skills');
 fs.mkdirSync(workspace);fs.mkdirSync(outside);fs.mkdirSync(skills,{recursive:true});
 const policy=path.join(outside,'policy.json'),adapter=path.join(root,'dsh.mjs');
 fs.writeFileSync(policy,JSON.stringify({schemaVersion:1,workspace,readRoots:[workspace],writeRoots:[],protectedRoots:[],bindings:{zcode:{},dsh:{}}}),{mode:0o600});
 fs.writeFileSync(adapter,'export const name="gstack861-guard";');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,workspace,outside,skills,policy,adapter};
}
const run=(args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
test('dsh-profile-stage CLI creates scaffold and never runs package manager',t=>{
 const f=fixture(t),out=path.join(f.root,'profile');
 const r=run(['dsh-profile-stage','--output',out,'--policy',f.policy,'--adapter',f.adapter,'--skills',f.skills]);
 assert.equal(r.status,0,r.stderr); const result=JSON.parse(r.stdout);
 assert.equal(result.status,'scaffolded-not-host-verified');
 assert.ok(fs.existsSync(path.join(out,'plugins/gstack861-skills/index.mjs')));
});
test('zcode config CLI previews without writes then applies and uninstalls explicitly',t=>{
 const f=fixture(t),file=path.join(f.workspace,'.zcode','config.json');
 let r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy]);
 assert.equal(r.status,0,r.stderr); assert.equal(fs.existsSync(file),false);
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(fs.readFileSync(file)).hooks.events.PreToolUse.length,1);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);
 assert.equal(fs.existsSync(file),false,'the originally absent config is restored to absence');
 assert.equal(fs.existsSync(path.join(f.workspace,'.zcode','.gstack861-zcode-receipt.json')),false,'no ownership receipt remains');
});
test('zcode CLI preserves existing settings and foreign hooks through repeat install and uninstall', t => {
 const f=fixture(t),zdir=path.join(f.workspace,'.zcode'),config=path.join(zdir,'config.json');fs.mkdirSync(zdir);
 const original={theme:'fixture',hooks:{events:{PreToolUse:[{matcher:'Read',label:'operator-owned',hooks:[{type:'command',command:'echo fixture'}]}],Stop:[]}}};
 fs.writeFileSync(config,JSON.stringify(original));const before=fs.readFileSync(config);
 let r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy]);
 assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readFileSync(config),before);
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);const installed=fs.readFileSync(config);
 const receipt=fs.readFileSync(path.join(zdir,'.gstack861-zcode-receipt.json'));
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readFileSync(config),installed);assert.deepEqual(fs.readFileSync(path.join(zdir,'.gstack861-zcode-receipt.json')),receipt);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(config,'utf8')),original);
});
test('zcode owned uninstall remains available after its policy is deleted or corrupted', t => {
 for (const fault of ['deleted','corrupt']) {
  const f=fixture(t),file=path.join(f.workspace,'.zcode','config.json');
  let r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
  assert.equal(r.status,0,r.stderr);
  if(fault==='deleted')fs.unlinkSync(f.policy);else fs.writeFileSync(f.policy,'{');
  r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);
  assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(file),false);
 }
});
test('zcode CLI binds an external policy to the selected workspace before any mutation', t => {
 const f=fixture(t),other=path.join(f.root,'other'); fs.mkdirSync(other);
 const policy=JSON.parse(fs.readFileSync(f.policy,'utf8'));
 policy.workspace=other; policy.readRoots=[other];
 fs.writeFileSync(f.policy,JSON.stringify(policy));
 for (const apply of [[],['--apply']]) {
  const r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,...apply]);
  assert.equal(r.status,1); assert.match(r.stderr,/POLICY_WORKSPACE_MISMATCH/);
  assert.equal(fs.existsSync(path.join(f.workspace,'.zcode')),false);
 }
});
test('zcode CLI refuses an inside-target policy whose declared workspace points elsewhere', t => {
 const f=fixture(t),other=path.join(f.root,'other');fs.mkdirSync(other);
 const inside=path.join(f.workspace,'policy.json');
 const policy=JSON.parse(fs.readFileSync(f.policy,'utf8'));policy.workspace=other;policy.readRoots=[other];
 fs.writeFileSync(inside,JSON.stringify(policy));
 const r=run(['zcode-config-install','--workspace',f.workspace,'--policy',inside,'--apply']);
 assert.equal(r.status,1); assert.match(r.stderr,/POLICY_WORKSPACE_MISMATCH|POLICY_MUST_BE_OUTSIDE_WORKSPACE/);
 assert.equal(fs.existsSync(path.join(f.workspace,'.zcode')),false);
});
test('zcode CLI refuses linked workspace ancestors on both lifecycle commands', t => {
 const f=fixture(t),view=path.join(f.root,'view');
 fs.symlinkSync(f.root,view,process.platform==='win32'?'junction':'dir');
 for (const command of ['zcode-config-install','zcode-config-uninstall']) {
  const r=run([command,'--workspace',path.join(view,'workspace'),'--policy',f.policy,'--apply']);
  assert.equal(r.status,1); assert.match(r.stderr,/WORKSPACE_INVALID|ZCODE_CONFIG_UNSAFE/);
  assert.equal(fs.existsSync(path.join(f.workspace,'.zcode')),false);
 }
});
test('zcode CLI refuses policy under workspace before config write',t=>{
 const f=fixture(t),inside=path.join(f.workspace,'policy.json');fs.writeFileSync(inside,fs.readFileSync(f.policy));
 const r=run(['zcode-config-install','--workspace',f.workspace,'--policy',inside,'--apply']);
 assert.equal(r.status,1);assert.equal(fs.existsSync(path.join(f.workspace,'.zcode','config.json')),false);
});
