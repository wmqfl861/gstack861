import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageDshProfile } from '../src/dsh-profile.mjs';

const guardAdapter=fileURLToPath(new URL('../src/adapters/dsh.mjs',import.meta.url));
const skillsAdapter=fileURLToPath(new URL('../src/adapters/dsh-skills.mjs',import.meta.url));
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
const options=f=>({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills});
const ioError=()=>Object.assign(new Error('fixture write failure'),{code:'EIO'});
const directoryLink=(target,link)=>fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');

test('generates DSH profile with complete dependency chain and local adapter shim',t=>{
 const f=fixture(t),r=stageDshProfile(options(f));
 assert.equal(r.status,'scaffolded-not-host-verified');
 const patch=fs.readFileSync(path.join(f.output,'cordis.patch.yml'),'utf8');
 assert.ok(patch.indexOf('system-prompt')<patch.indexOf('id: tools'));
 assert.ok(patch.indexOf('id: tools')<patch.indexOf('id: gstack861-guard'));
 assert.match(patch,/gstack861-skills/);
 const pkg=JSON.parse(fs.readFileSync(path.join(f.output,'package.json')));
 assert.equal(pkg.dependencies['gstack861-guard'],'file:./plugins/gstack861-guard');
 assert.ok(fs.readFileSync(path.join(f.output,'plugins/gstack861-guard/index.mjs'),'utf8').includes(pathToFileURL(f.adapter).href));
});
test('refuses existing output without touching operator files',t=>{
 const f=fixture(t); fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output,'notes'),'keep');
 assert.throws(()=>stageDshProfile(options(f)),/OUTPUT_EXISTS/);
 assert.equal(fs.readFileSync(path.join(f.output,'notes'),'utf8'),'keep');
});
test('refuses workspace-contained policy, symlinked adapter and missing skills root',t=>{
 const f=fixture(t),inside=path.join(f.workspace,'policy.json'); fs.writeFileSync(inside,fs.readFileSync(f.policy));
 assert.throws(()=>stageDshProfile({...options(f),policyPath:inside}),/POLICY_MUST_BE_OUTSIDE/);
 const g=fixture(t); fs.symlinkSync(g.adapter,path.join(g.root,'link'));
 assert.throws(()=>stageDshProfile({...options(g),adapterPath:path.join(g.root,'link')}),/ADAPTER_FILE_REQUIRED/);
 const h=fixture(t); assert.throws(()=>stageDshProfile({...options(h),skillsDir:path.join(h.root,'missing')}),/SKILLS_DIR_INVALID/);
});
test('rejects invalid profile name and malformed policy before creating output',t=>{
 const f=fixture(t); assert.throws(()=>stageDshProfile({...options(f),profileName:'../bad'}),/INVALID_PROFILE_NAME/);
 fs.writeFileSync(f.policy,'{'); assert.throws(()=>stageDshProfile(options(f)),/POLICY_FILE_INVALID/);
 assert.equal(fs.existsSync(f.output),false);
});

test('emits both importable plugin packages pointing to the real repository adapters',async t=>{
 const f=fixture(t),result=stageDshProfile({...options(f),adapterPath:guardAdapter});
 const pkg=JSON.parse(fs.readFileSync(path.join(f.output,'package.json')));
 assert.deepEqual(pkg.dsh.profile.bundles,[]);
 for (const [id,adapter] of [['gstack861-guard',guardAdapter],['gstack861-skills',skillsAdapter]]) {
  const relative=`plugins/${id}`,dir=path.join(f.output,relative);
  assert.equal(pkg.dependencies[id],`file:./${relative}`);
  assert.ok(result.files.includes(`${relative}/package.json`));
  assert.ok(result.files.includes(`${relative}/index.mjs`));
  const plugin=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
  assert.equal(plugin.name,id); assert.equal(plugin.type,'module'); assert.equal(plugin.main,'index.mjs');
  const shim=await import(pathToFileURL(path.join(dir,plugin.main)).href),real=await import(pathToFileURL(adapter).href);
  assert.deepEqual(Object.keys(shim),['apply','inject','name']);
  assert.equal(shim.name,id); assert.equal(shim.inject,real.inject); assert.equal(shim.apply,real.apply);
 }
 assert.equal(result.status,'scaffolded-not-host-verified');
});

test('file URL shims preserve spaces, Unicode and ADMINI~1 short-name spelling',async t=>{
 const f=fixture(t),dir=path.join(f.root,'ADMINI~1 space Ω'); fs.mkdirSync(dir);
 const adapter=path.join(dir,'guard # %.mjs'),skillsAdapterPath=path.join(dir,'skills 中文.mjs');
 fs.writeFileSync(adapter,'export const name="gstack861-guard", inject=[]; export function apply() {}');
 fs.writeFileSync(skillsAdapterPath,'export const name="gstack861-skills", inject=[]; export function apply() {}');
 stageDshProfile({...options(f),adapterPath:adapter,skillsAdapterPath});
 for (const [id,file] of [['gstack861-guard',adapter],['gstack861-skills',skillsAdapterPath]]) {
  const shim=path.join(f.output,'plugins',id,'index.mjs');
  assert.ok(fs.readFileSync(shim,'utf8').includes(pathToFileURL(file).href));
  assert.equal((await import(pathToFileURL(shim).href)).name,id);
 }
});

test('validates adapter files without evaluating caller code',t=>{
 const f=fixture(t),skillsAdapterPath=path.join(f.root,'caller-skills.mjs');
 fs.writeFileSync(f.adapter,'throw new Error("CALLER_GUARD_MUST_NOT_RUN");');
 fs.writeFileSync(skillsAdapterPath,'throw new Error("CALLER_SKILLS_MUST_NOT_RUN");');
 assert.equal(stageDshProfile({...options(f),skillsAdapterPath}).status,'scaffolded-not-host-verified');
});

test('rejects invalid complete policies before creating output',async t=>{
 const cases=[
  ['missing root arrays',raw=>{delete raw.writeRoots;}],
  ['unknown field',raw=>{raw.untrusted=true;}],
  ['malformed binding',raw=>{raw.bindings.dsh.Read={effect:'read',pathKey:'../file'};}],
  ['unknown host',raw=>{raw.bindings.other={};}],
  ['root outside workspace',(raw,f)=>{raw.readRoots=[f.root];}],
  ['oversized policy',raw=>{raw.bindings.dsh['x'.repeat(70000)]={effect:'read',pathKey:'file'};}]
 ];
 for (const [name,mutate] of cases) await t.test(name,t=>{
  const f=fixture(t),raw=JSON.parse(fs.readFileSync(f.policy)); mutate(raw,f);
  fs.writeFileSync(f.policy,JSON.stringify(raw));
  assert.throws(()=>stageDshProfile(options(f)),/POLICY_FILE_INVALID/);
  assert.equal(fs.existsSync(f.output),false);
 });
 if (process.platform!=='win32') await t.test('unsafe policy permissions',t=>{
  const f=fixture(t); fs.chmodSync(f.policy,0o666);
  assert.throws(()=>stageDshProfile(options(f)),/POLICY_FILE_INVALID/);
  assert.equal(fs.existsSync(f.output),false);
 });
});

test('rejects unsafe optional skills adapter paths without creating output',async t=>{
 for (const kind of ['relative','missing','directory','symlink','hardlink']) await t.test(kind,t=>{
  const f=fixture(t),candidate=path.join(f.root,'skills-adapter.mjs');
  if (kind==='directory') fs.mkdirSync(candidate);
  if (kind==='symlink' || kind==='hardlink') {
   const source=path.join(f.root,'other-adapter.mjs'); fs.writeFileSync(source,'export const name="gstack861-skills";');
   if (kind==='symlink') fs.symlinkSync(source,candidate);
   else fs.linkSync(source,candidate);
  }
  const skillsAdapterPath=kind==='relative'?'relative.mjs':candidate;
  assert.throws(()=>stageDshProfile({...options(f),skillsAdapterPath}),kind==='relative'?/ABSOLUTE_PATH_REQUIRED/:/ADAPTER_FILE_REQUIRED/);
  assert.equal(fs.existsSync(f.output),false);
 });
});

test('rejects linked ancestors of every scaffold input and output',async t=>{
 for (const kind of ['policy','guard','skills adapter','skills','workspace','output']) await t.test(kind,t=>{
  const f=fixture(t),link=path.join(f.root,'linked'),opts=options(f);
  if (kind==='policy') { directoryLink(path.dirname(f.policy),link); opts.policyPath=path.join(link,'policy.json'); }
  if (kind==='guard' || kind==='skills adapter') {
   const dir=path.join(f.root,'adapters'); fs.mkdirSync(dir);
   const adapter=path.join(dir,'adapter.mjs'); fs.writeFileSync(adapter,'export const name="fixture";');
   directoryLink(dir,link); opts[kind==='guard'?'adapterPath':'skillsAdapterPath']=path.join(link,'adapter.mjs');
  }
  if (kind==='skills') { directoryLink(f.workspace,link); opts.skillsDir=path.join(link,'.dsh','skills'); }
  if (kind==='workspace') {
   directoryLink(f.workspace,link); const raw=JSON.parse(fs.readFileSync(f.policy)); raw.workspace=link; fs.writeFileSync(f.policy,JSON.stringify(raw));
  }
  if (kind==='output') {
   const dir=path.join(f.root,'destination'); fs.mkdirSync(path.join(dir,'nested'),{recursive:true});
   directoryLink(dir,link); opts.output=path.join(link,'nested','profile');
  }
  const code=kind==='policy'?/POLICY_FILE_REQUIRED/:kind==='skills'?/SKILLS_DIR_INVALID/:kind==='workspace'?/POLICY_FILE_INVALID/:kind==='output'?/OUTPUT_PARENT_INVALID/:/ADAPTER_FILE_REQUIRED/;
  assert.throws(()=>stageDshProfile(opts),code);
  assert.equal(fs.existsSync(opts.output),false);
 });
});

test('rejects traversal and hardlinked source files before creating output',async t=>{
 for (const kind of ['output traversal','policy traversal','policy hardlink','guard hardlink']) await t.test(kind,t=>{
  const f=fixture(t),opts=options(f);
  if (kind==='output traversal') opts.output=f.root+path.sep+'workspace'+path.sep+'..'+path.sep+'profile';
  if (kind==='policy traversal') opts.policyPath=path.dirname(f.policy)+path.sep+'..'+path.sep+'private'+path.sep+'policy.json';
  if (kind==='policy hardlink') fs.linkSync(f.policy,path.join(f.root,'policy-copy'));
  if (kind==='guard hardlink') fs.linkSync(f.adapter,path.join(f.root,'guard-copy'));
  assert.throws(()=>stageDshProfile(opts),kind.startsWith('output')?/OUTPUT_PARENT_INVALID/:kind.startsWith('policy')?/POLICY_FILE_REQUIRED/:/ADAPTER_FILE_REQUIRED/);
  assert.equal(fs.existsSync(f.output),false);
 });
});

test('rejects output overlapping workspace or external skills inputs',async t=>{
 for (const kind of ['workspace','skills','namespace workspace']) await t.test(kind,t=>{
  const f=fixture(t),opts=options(f);
  if (kind==='skills') { const skills=path.join(f.root,'external-skills'); fs.mkdirSync(skills); opts.skillsDir=skills; opts.output=path.join(skills,'profile'); }
  else {
   opts.output=path.join(f.workspace,'profile');
   if (kind==='namespace workspace' && process.platform==='win32') opts.output='\\\\?\\'+opts.output;
  }
  assert.throws(()=>stageDshProfile(opts),/OUTPUT_OVERLAP/);
  assert.equal(fs.existsSync(opts.output),false);
  assert.deepEqual(fs.readdirSync(f.skills),[]);
 });
});

test('refuses identical-content policy replacement during its read',t=>{
 const f=fixture(t),read=fs.readFileSync,bytes=read(f.policy); let replaced=false;
 t.mock.method(fs,'readFileSync',function(file,...args){
  const result=read.call(this,file,...args);
  if (!replaced && String(result)===String(bytes)) {
   replaced=true; fs.renameSync(f.policy,path.join(f.root,'saved-policy.json')); fs.writeFileSync(f.policy,bytes,{mode:0o600});
  }
  return result;
 });
 assert.throws(()=>stageDshProfile(options(f)),/POLICY_FILE_(REQUIRED|INVALID)/);
 assert.equal(fs.existsSync(f.output),false);
 assert.deepEqual(read(f.policy),bytes);
});

test('refuses observed input identity swaps after creating output',async t=>{
 for (const kind of ['guard','skills adapter','skills directory']) await t.test(kind,t=>{
  const f=fixture(t),opts=options(f),skillsAdapterPath=path.join(f.root,'skills-adapter.mjs');
  fs.writeFileSync(skillsAdapterPath,'export const name="gstack861-skills";'); opts.skillsAdapterPath=skillsAdapterPath;
  const target=kind==='guard'?f.adapter:kind==='skills adapter'?skillsAdapterPath:f.skills;
  const mkdir=fs.mkdirSync; let swapped=false;
  t.mock.method(fs,'mkdirSync',function(dir,...args){
   const result=mkdir.call(this,dir,...args);
   if (!swapped && path.resolve(String(dir))===f.output) {
    swapped=true; fs.renameSync(target,target+'.saved');
    if (kind==='skills directory') { mkdir(target); fs.writeFileSync(path.join(target,'operator-note'),'keep'); }
    else fs.writeFileSync(target,fs.readFileSync(target+'.saved'));
   }
   return result;
  });
  assert.throws(()=>stageDshProfile(opts),kind==='skills directory'?/SKILLS_DIR_INVALID/:/ADAPTER_FILE_REQUIRED/);
  assert.equal(fs.existsSync(f.output),false);
  assert.ok(fs.existsSync(target+'.saved'));
  if (kind==='skills directory') assert.equal(fs.readFileSync(path.join(target,'operator-note'),'utf8'),'keep');
 });
});

test('retains the initial output parent snapshot across preflight inspection',t=>{
 const f=fixture(t),parent=path.join(f.root,'destination'),moved=path.join(f.root,'original-destination'); fs.mkdirSync(parent);
 f.output=path.join(parent,'profile'); const lstat=fs.lstatSync; let swapped=false;
 t.mock.method(fs,'lstatSync',function(file,...args){
  const result=lstat.call(this,file,...args);
  if (!swapped && path.resolve(String(file))===f.output) {
   swapped=true; fs.renameSync(parent,moved); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent,'operator-note'),'keep');
  }
  return result;
 });
 assert.throws(()=>stageDshProfile(options(f)),/OUTPUT_PARENT_INVALID/);
 assert.equal(fs.existsSync(f.output),false);
 assert.equal(fs.readFileSync(path.join(parent,'operator-note'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(moved),[]);
});

test('checks saved existing ancestors before refreshing a newly created output suffix',t=>{
 const f=fixture(t),parent=path.join(f.root,'destination'),moved=path.join(f.root,'original-destination'); fs.mkdirSync(parent);
 f.output=path.join(parent,'profile'); const mkdir=fs.mkdirSync; let swapped=false;
 t.mock.method(fs,'mkdirSync',function(dir,...args){
  const result=mkdir.call(this,dir,...args);
  if (!swapped && path.resolve(String(dir))===f.output) {
   swapped=true; fs.renameSync(parent,moved); mkdir(parent); mkdir(f.output); fs.writeFileSync(path.join(f.output,'operator-note'),'keep');
  }
  return result;
 });
 assert.throws(()=>stageDshProfile(options(f)),/OUTPUT_PARENT_INVALID/);
 assert.deepEqual(fs.readdirSync(f.output),['operator-note']);
 assert.equal(fs.readFileSync(path.join(f.output,'operator-note'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(path.join(moved,'profile')),[]);
});

test('removes only invocation-owned files and directories after a write failure',t=>{
 const f=fixture(t),write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',function(file,content,...args){
  if (content==='[]\n') throw ioError();
  return write.call(this,file,content,...args);
 });
 assert.throws(()=>stageDshProfile(options(f)),{code:'EIO'});
 assert.equal(fs.existsSync(f.output),false);
});

test('preserves concurrent foreign output entries on EIO cleanup',t=>{
 const f=fixture(t),write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',function(file,content,...args){
  if (content==='[]\n') { write(path.join(f.output,'operator-note'),'keep'); throw ioError(); }
  return write.call(this,file,content,...args);
 });
 assert.throws(()=>stageDshProfile(options(f)),{code:'EIO'});
 assert.deepEqual(fs.readdirSync(f.output),['operator-note']);
 assert.equal(fs.readFileSync(path.join(f.output,'operator-note'),'utf8'),'keep');
});

test('preserves an EEXIST collision created by another writer',t=>{
 const f=fixture(t),target=path.join(f.output,'cordis.yml'),open=fs.openSync,write=fs.writeFileSync;
 const collide=file=>{if (typeof file==='string' && path.resolve(file)===target && !fs.existsSync(target)) write(target,'operator content');};
 t.mock.method(fs,'openSync',function(file,...args){collide(file);return open.call(this,file,...args);});
 t.mock.method(fs,'writeFileSync',function(file,...args){collide(file);return write.call(this,file,...args);});
 assert.throws(()=>stageDshProfile(options(f)),{code:'EEXIST'});
 assert.deepEqual(fs.readdirSync(f.output),['cordis.yml']);
 assert.equal(fs.readFileSync(target,'utf8'),'operator content');
});

test('preserves same-inode operator edits and partial fd writes during EIO cleanup',t=>{
 const f=fixture(t),write=fs.writeFileSync,target=path.join(f.output,'package.json'); let before;
 t.mock.method(fs,'writeFileSync',function(file,content,...args){
  if (content==='[]\n') {
   assert.equal(typeof file,'number');
   before=fs.lstatSync(target,{bigint:true});
   write(target,'OPERATOR DATA');
   write(file,'[');
   throw ioError();
  }
  return write.call(this,file,content,...args);
 });
 assert.throws(()=>stageDshProfile(options(f)),{code:'EIO'});
 assert.ok(before);
 const after=fs.lstatSync(target,{bigint:true});
 assert.equal(after.dev,before.dev); assert.equal(after.ino,before.ino);
 assert.equal(fs.readFileSync(target,'utf8'),'OPERATOR DATA');
 assert.equal(fs.readFileSync(path.join(f.output,'cordis.yml'),'utf8'),'[');
 assert.deepEqual(fs.readdirSync(f.output).sort(),['cordis.yml','package.json']);
});

test('refuses scaffold success after a same-inode operator edit at a later fd write',t=>{
 const f=fixture(t),write=fs.writeFileSync,target=path.join(f.output,'package.json'); let before;
 t.mock.method(fs,'writeFileSync',function(file,content,...args){
  if (content==='[]\n') {
   assert.equal(typeof file,'number');
   before=fs.lstatSync(target,{bigint:true});
   write(target,'OPERATOR DATA');
  }
  return write.call(this,file,content,...args);
 });
 assert.throws(()=>stageDshProfile(options(f)),/OUTPUT_CHANGED/);
 assert.ok(before);
 const after=fs.lstatSync(target,{bigint:true});
 assert.equal(after.dev,before.dev); assert.equal(after.ino,before.ino);
 assert.equal(fs.readFileSync(target,'utf8'),'OPERATOR DATA');
 assert.deepEqual(fs.readdirSync(f.output),['package.json']);
});

test('preserves replaced generated files rather than deleting by name',t=>{
 const f=fixture(t),write=fs.writeFileSync,target=path.join(f.output,'package.json');
 t.mock.method(fs,'writeFileSync',function(file,content,...args){
  if (content==='[]\n') {
   fs.renameSync(target,path.join(f.root,'saved-package.json')); write(target,'operator replacement'); throw ioError();
  }
  return write.call(this,file,content,...args);
 });
 assert.throws(()=>stageDshProfile(options(f)),{code:'EIO'});
 assert.deepEqual(fs.readdirSync(f.output),['package.json']);
 assert.equal(fs.readFileSync(target,'utf8'),'operator replacement');
 assert.ok(fs.existsSync(path.join(f.root,'saved-package.json')));
});
