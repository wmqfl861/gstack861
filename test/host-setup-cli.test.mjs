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
 const git=spawnSync('git',['init','--quiet',workspace],{encoding:'utf8'});assert.equal(git.status,0,git.stderr);
 const policy=path.join(outside,'policy.json'),adapter=path.join(root,'dsh.mjs');
 fs.writeFileSync(policy,JSON.stringify({schemaVersion:1,workspace,readRoots:[workspace],writeRoots:[],protectedRoots:[],bindings:{zcode:{},dsh:{}}}),{mode:0o600});
 fs.writeFileSync(adapter,'export const name="gstack861-guard";');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,workspace,outside,skills,policy,adapter};
}
const run=(args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
function snapshot(directory) {
 return Object.fromEntries(fs.readdirSync(directory,{recursive:true,withFileTypes:true}).map(entry=>{
  const file=path.join(entry.parentPath,entry.name);
  return [path.relative(directory,file),entry.isDirectory()?'directory':entry.isSymbolicLink()?'symlink:'+fs.readlinkSync(file):fs.readFileSync(file).toString('hex')];
 }).sort(([left],[right])=>left.localeCompare(right)));
}
test('dsh-profile-stage CLI creates scaffold and never runs package manager',t=>{
 const f=fixture(t),out=path.join(f.root,'profile');
 const r=run(['dsh-profile-stage','--output',out,'--policy',f.policy,'--adapter',f.adapter,'--skills',f.skills]);
 assert.equal(r.status,0,r.stderr); const result=JSON.parse(r.stdout);
 assert.equal(result.status,'scaffolded-not-host-verified');
 assert.ok(fs.existsSync(path.join(out,'plugins/gstack861-skills/index.mjs')));
});
test('zcode config CLI previews without writes then applies and uninstalls explicitly',t=>{
 const f=fixture(t),file=path.join(f.workspace,'.zcode','config.json');
 const original=snapshot(f.root);
 let r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy]);
 assert.equal(r.status,0,r.stderr); assert.equal(fs.existsSync(file),false);
 assert.deepEqual(snapshot(f.root),original);
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(fs.readFileSync(file)).hooks.events.PreToolUse.length,1);
 const installed=snapshot(f.root);
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).changed,false);assert.deepEqual(snapshot(f.root),installed);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy]);
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).changed,true);assert.deepEqual(snapshot(f.root),installed);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(fs.readFileSync(file)).hooks,undefined);
 assert.equal(fs.existsSync(path.join(f.workspace,'.zcode','.gstack861-zcode-config.json')),false);
 const removed=snapshot(f.root);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).changed,false);assert.deepEqual(snapshot(f.root),removed);
});
test('zcode CLI refuses policy under workspace before config write',t=>{
 const f=fixture(t),inside=path.join(f.workspace,'policy.json');fs.writeFileSync(inside,fs.readFileSync(f.policy));
 const r=run(['zcode-config-install','--workspace',f.workspace,'--policy',inside,'--apply']);
 assert.equal(r.status,1);assert.equal(fs.existsSync(path.join(f.workspace,'.zcode','config.json')),false);
});
test('zcode CLI retains pre-existing enabled and foreign hooks through install and uninstall',t=>{
 const f=fixture(t),file=path.join(f.workspace,'.zcode','config.json');fs.mkdirSync(path.dirname(file));
 const existing={theme:'dark',hooks:{enabled:true,events:{PreToolUse:[{matcher:'Write',hooks:[{type:'command',command:'foreign'}]}],PermissionRequest:[{hooks:[{type:'command',command:'foreign-transformer'}]}]}}};
 fs.writeFileSync(file,JSON.stringify(existing));const preview=snapshot(f.root);
 let r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy]);
 assert.equal(r.status,0,r.stderr);assert.deepEqual(snapshot(f.root),preview);
 r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);assert.equal(r.status,0,r.stderr);
 const installed=JSON.parse(fs.readFileSync(file));assert.equal(installed.hooks.events.PreToolUse.length,2);
 assert.deepEqual(installed.hooks.events.PermissionRequest,existing.hooks.events.PermissionRequest);
 r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,'--apply']);assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),existing);
});
test('zcode CLI refuses malformed config, hook shapes and unknown ownership receipts without changing bytes',t=>{
 for(const content of ['{','[]','{"hooks":null}','{"hooks":{"events":[]}}']) {
  const f=fixture(t),file=path.join(f.workspace,'.zcode','config.json');fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,content);
  const before=snapshot(f.root);
  for(const command of ['zcode-config-install','zcode-config-uninstall'])for(const apply of [[],['--apply']]) {
   const r=run([command,'--workspace',f.workspace,'--policy',f.policy,...apply]);
   assert.equal(r.status,1);assert.match(r.stderr,/ZCODE_(CONFIG|HOOKS|EVENTS)_INVALID/);assert.deepEqual(snapshot(f.root),before);
  }
 }
 const f=fixture(t),zdir=path.join(f.workspace,'.zcode');fs.mkdirSync(zdir);fs.writeFileSync(path.join(zdir,'.gstack861-zcode-config.json'),'{"foreign":true}\n');
 const before=snapshot(f.root),r=run(['zcode-config-install','--workspace',f.workspace,'--policy',f.policy,'--apply']);
 assert.equal(r.status,1);assert.match(r.stderr,/ZCODE_RECEIPT_INVALID/);assert.deepEqual(snapshot(f.root),before);
});
test('zcode CLI rejects linked directories and config files for both lifecycle commands',t=>{
 for(const kind of ['directory','symlink','hardlink']) {
  const f=fixture(t),zdir=path.join(f.workspace,'.zcode'),foreign=path.join(f.outside,'config.json');fs.writeFileSync(foreign,'{ "keep": true }\n');
  if(kind==='directory')fs.symlinkSync(f.outside,zdir,'junction');
  else {fs.mkdirSync(zdir);if(kind==='symlink')fs.symlinkSync(foreign,path.join(zdir,'config.json'));else fs.linkSync(foreign,path.join(zdir,'config.json'));}
  const before=snapshot(f.root);
  for(const command of ['zcode-config-install','zcode-config-uninstall']) {
   const r=run([command,'--workspace',f.workspace,'--policy',f.policy,'--apply']);
   assert.equal(r.status,1);assert.match(r.stderr,/ZCODE_CONFIG(_DIR)?_UNSAFE/);assert.deepEqual(snapshot(f.root),before);
  }
 }
});
test('uninstalling an absent workspace config is a zero-write CLI no-op',t=>{
 const f=fixture(t),before=snapshot(f.root);
 for(const apply of [[],['--apply']]) {
  const r=run(['zcode-config-uninstall','--workspace',f.workspace,'--policy',f.policy,...apply]);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).changed,false);assert.deepEqual(snapshot(f.root),before);
 }
});
