import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { planZcodeConfig, applyZcodeConfigPlan, planZcodeUninstall } from '../src/zcode-profile.mjs';

function fixture(t, directory = true) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g861-zcode-profile-'))); if (directory) fs.mkdirSync(path.join(root,'.zcode'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,workspace:root,nodePath:process.execPath,cliPath:path.join(root,'bin','gstack861.mjs'),policyPath:path.join(root,'private','policy.json')};
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

const configFile = f => path.join(f.root, '.zcode', 'config.json');
const receiptFile = f => path.join(f.root, '.zcode', '.gstack861-zcode-config.json');
function bytesIn(directory) {
 if (!fs.existsSync(directory)) return null;
 return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
  const file=path.join(directory,name),stat=fs.lstatSync(file);
  return [name,stat.isDirectory()?'directory':stat.isSymbolicLink()?'symlink:'+fs.readlinkSync(file):fs.readFileSync(file).toString('hex')];
 }));
}
test('fresh library preview is zero-write and explicit apply creates its config directory',t=>{
 const f=fixture(t,false),plan=planZcodeConfig(f);
 assert.equal(fs.existsSync(path.join(f.root,'.zcode')),false);
 assert.equal(applyZcodeConfigPlan(plan).changed,true);
 assert.equal(JSON.parse(fs.readFileSync(configFile(f))).hooks.events.PreToolUse.length,1);
 const receipt=fs.lstatSync(receiptFile(f));assert.equal(receipt.isFile(),true);assert.equal(receipt.isSymbolicLink(),false);assert.equal(receipt.nlink,1);
 // Windows maps writable files to 0666; POSIX mode bits do not establish its ACL.
 if(process.platform!=='win32')assert.equal(receipt.mode&0o777,0o600);
 const before=bytesIn(path.join(f.root,'.zcode'));
 assert.equal(applyZcodeConfigPlan(planZcodeConfig(f)).changed,false);
 assert.deepEqual(bytesIn(path.join(f.root,'.zcode')),before);
});
test('an absent config uninstall creates no directory, lock or receipt',t=>{
 const f=fixture(t,false),before=fs.readdirSync(f.root),plan=planZcodeUninstall(f);
 assert.equal(plan.changed,false);assert.equal(applyZcodeConfigPlan(plan).changed,false);
 assert.deepEqual(fs.readdirSync(f.root),before);
});
test('byte CAS rejects same-value edits, empty-file creation and equal-byte inode replacement',t=>{
 for (const kind of ['format','creation','replacement']) {
  const f=fixture(t),file=configFile(f);
  if(kind!=='creation')fs.writeFileSync(file,'{"theme":"dark"}\n');
  const plan=planZcodeConfig(f);
  if(kind==='format')fs.writeFileSync(file,'{\n "theme": "dark"\n}\n');
  if(kind==='creation')fs.writeFileSync(file,'{}');
  if(kind==='replacement') {const next=file+'.next';fs.writeFileSync(next,fs.readFileSync(file));fs.renameSync(next,file);}
  const before=bytesIn(path.dirname(file));
  assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
  assert.deepEqual(bytesIn(path.dirname(file)),before);
 }
});
test('parsed plans are deeply frozen and copied or altered plans cannot be applied',t=>{
 const f=fixture(t),plan=planZcodeConfig(f);
 assert.throws(()=>{plan.config.hooks.events.PreToolUse[0].hooks[0].command='/tmp/foreign';},TypeError);
 assert.throws(()=>applyZcodeConfigPlan({...plan}),/INVALID_PLAN/);
 assert.equal(fs.existsSync(configFile(f)),false);
});
test('an explicit existingConfig never bypasses disk validation or byte CAS',t=>{
 const f=fixture(t),file=configFile(f);fs.writeFileSync(file,'{');
 assert.throws(()=>planZcodeConfig({...f,existingConfig:{}}),/ZCODE_CONFIG_INVALID/);
 fs.writeFileSync(file,'{"original":true}\n');
 const plan=planZcodeConfig({...f,existingConfig:{previewOnly:true}}),before=bytesIn(path.dirname(file));
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
 assert.deepEqual(bytesIn(path.dirname(file)),before);
});
test('both planners fail closed on invalid hook shapes and non-UTF8 configs',t=>{
 for(const value of [{hooks:null},{hooks:[]},{hooks:{enabled:'true'}},{hooks:{events:[]}},{hooks:{events:{PreToolUse:{}}}},{hooks:{events:{Stop:[null]}}}]) {
  const f=fixture(t),file=configFile(f);fs.writeFileSync(file,JSON.stringify(value));const before=bytesIn(path.dirname(file));
  for(const planner of [planZcodeConfig,planZcodeUninstall])assert.throws(()=>planner(f),/ZCODE_(HOOKS|EVENTS)_INVALID/);
  assert.deepEqual(bytesIn(path.dirname(file)),before);
 }
 const f=fixture(t);fs.writeFileSync(configFile(f),Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));
 for(const planner of [planZcodeConfig,planZcodeUninstall])assert.throws(()=>planner(f),/ZCODE_CONFIG_INVALID/);
});
test('install and uninstall reject linked config files and linked directory ancestors',t=>{
 for(const kind of ['symlink-file','hardlink-file','directory-link','ancestor-link']) {
  const f=fixture(t),file=configFile(f);let options=f;
  if(kind==='symlink-file') {const target=path.join(f.root,'foreign.json');fs.writeFileSync(target,'{}');fs.symlinkSync(target,file);}
  if(kind==='hardlink-file') {fs.writeFileSync(file,'{}');fs.linkSync(file,path.join(f.root,'foreign.json'));}
  if(kind==='directory-link') {fs.rmdirSync(path.dirname(file));const target=path.join(f.root,'foreign');fs.mkdirSync(target);fs.symlinkSync(target,path.dirname(file),'junction');}
  if(kind==='ancestor-link') {const target=path.join(f.root,'nested');fs.mkdirSync(target);const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,'junction');options={...f,workspace:path.join(alias,'nested')};}
  for(const planner of [planZcodeConfig,planZcodeUninstall])assert.throws(()=>planner(options),/ZCODE_CONFIG(_DIR)?_UNSAFE|WORKSPACE_INVALID/);
 }
});
test('apply validates a replaced config directory before any lock creation',t=>{
 const f=fixture(t),plan=planZcodeConfig(f),zdir=path.join(f.root,'.zcode'),target=path.join(f.root,'foreign');
 fs.mkdirSync(target);fs.rmdirSync(zdir);fs.symlinkSync(target,zdir,'junction');
 const original=fs.mkdirSync,attempts=[];
 t.mock.method(fs,'mkdirSync',(file,...args)=>{attempts.push(String(file));return original(file,...args);});
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_DIR_UNSAFE/);
 assert.deepEqual(attempts,[]);assert.deepEqual(fs.readdirSync(target),[]);
});
test('active locks survive refusal and two precomputed plans cannot overwrite each other',t=>{
 const f=fixture(t),one=planZcodeConfig(f),two=planZcodeConfig(f),lock=path.join(f.root,'.zcode','.gstack861-zcode-config.lock');
 fs.mkdirSync(lock);assert.throws(()=>applyZcodeConfigPlan(one),/ZCODE_CONFIG_BUSY/);assert.equal(fs.statSync(lock).isDirectory(),true);
 fs.rmdirSync(lock);applyZcodeConfigPlan(one);const before=bytesIn(path.dirname(lock));
 assert.throws(()=>applyZcodeConfigPlan(two),/ZCODE_CONFIG_CHANGED|ZCODE_RECEIPT_CHANGED/);
 assert.deepEqual(bytesIn(path.dirname(lock)),before);
});
test('ownership restores clean hooks and preserves pre-existing enabled, containers and other events',t=>{
 const originals=[{}, {hooks:{enabled:true}}, {hooks:{}}, {hooks:{events:{PreToolUse:[]}}},
  {theme:'dark',hooks:{enabled:true,events:{Stop:[{matcher:'.*',hooks:[{type:'command',command:'keep'}]}]}}}];
 for(const original of originals) {
  const f=fixture(t);fs.writeFileSync(configFile(f),JSON.stringify(original));
  applyZcodeConfigPlan(planZcodeConfig(f));applyZcodeConfigPlan(planZcodeUninstall(f));
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(f))),original);
  assert.equal(fs.existsSync(receiptFile(f)),false);
  const before=fs.readFileSync(configFile(f));assert.equal(applyZcodeConfigPlan(planZcodeUninstall(f)).changed,false);
  assert.deepEqual(fs.readFileSync(configFile(f)),before);
 }
});
test('uninstall keeps metadata-bearing foreign copies and never claims legacy global settings',t=>{
 const f=fixture(t),owned=planZcodeConfig(f).config.hooks.events.PreToolUse[0],foreign={...owned,description:'operator-owned'};
 const original={theme:'dark',hooks:{enabled:true,events:{PreToolUse:[owned,foreign],PermissionRequest:[{hooks:[{type:'command',command:'foreign-input-transformer'}]}]}}};
 fs.writeFileSync(configFile(f),JSON.stringify(original));applyZcodeConfigPlan(planZcodeUninstall(f));
 assert.deepEqual(JSON.parse(fs.readFileSync(configFile(f))),{...original,hooks:{...original.hooks,events:{...original.hooks.events,PreToolUse:[foreign]}}});
 assert.equal(fs.existsSync(receiptFile(f)),false);
});
test('multiple owned hook identities retain the first receipt until the final uninstall',t=>{
 const f=fixture(t),other={...f,policyPath:path.join(f.root,'private','other.json')};
 applyZcodeConfigPlan(planZcodeConfig(f));applyZcodeConfigPlan(planZcodeConfig(other));
 assert.equal(JSON.parse(fs.readFileSync(receiptFile(f))).entries.length,2);
 applyZcodeConfigPlan(planZcodeUninstall(f));assert.equal(JSON.parse(fs.readFileSync(configFile(f))).hooks.events.PreToolUse.length,1);
 assert.equal(JSON.parse(fs.readFileSync(receiptFile(f))).entries.length,1);
 applyZcodeConfigPlan(planZcodeUninstall(other));assert.equal(JSON.parse(fs.readFileSync(configFile(f))).hooks,undefined);
});
test('unknown, corrupt, modified and linked receipts fail closed without overwrites',t=>{
 for(const kind of ['unknown','digest','symlink','hardlink','changed']) {
  const f=fixture(t);applyZcodeConfigPlan(planZcodeConfig(f));const file=receiptFile(f);
  let plan;if(kind==='changed')plan=planZcodeUninstall(f);
  if(kind==='unknown')fs.writeFileSync(file,'{"unrelated":true}');
  if(kind==='digest'){const value=JSON.parse(fs.readFileSync(file));value.enabledCreated=false;fs.writeFileSync(file,JSON.stringify(value));}
  if(kind==='symlink'){const target=file+'.foreign';fs.renameSync(file,target);fs.symlinkSync(target,file);}
  if(kind==='hardlink')fs.linkSync(file,file+'.foreign');
  if(kind==='changed')fs.appendFileSync(file,'\n');
  const before=bytesIn(path.dirname(file));
  if(plan)assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_RECEIPT_CHANGED/);
  else for(const planner of [planZcodeConfig,planZcodeUninstall])assert.throws(()=>planner(f),/ZCODE_RECEIPT_(UNSAFE|INVALID)/);
  assert.deepEqual(bytesIn(path.dirname(file)),before);
 }
});
test('partial temporary writes roll back without altering the original config or leaving temporary files',t=>{
 const f=fixture(t,false),plan=planZcodeConfig(f),original=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file,...args)=>{if(typeof file==='number'){fs.writeSync(file,'partial');throw new Error('INJECTED_PARTIAL_WRITE');}return original(file,...args);});
 assert.throws(()=>applyZcodeConfigPlan(plan),/INJECTED_PARTIAL_WRITE/);
 assert.equal(fs.existsSync(path.join(f.root,'.zcode')),false);
});
test('failed config publication restores the exact existing ownership receipt bytes',t=>{
 const f=fixture(t);applyZcodeConfigPlan(planZcodeConfig(f));
 const plan=planZcodeUninstall(f),before=bytesIn(path.dirname(configFile(f))),original=fs.renameSync;
 let failed=false;
 t.mock.method(fs,'renameSync',(from,to)=>{if(to===configFile(f)&&!failed){failed=true;throw new Error('INJECTED_RENAME_FAILURE');}return original(from,to);});
 assert.throws(()=>applyZcodeConfigPlan(plan),/INJECTED_RENAME_FAILURE/);
 assert.deepEqual(bytesIn(path.dirname(configFile(f))),before);
});
test('external config edits during receipt publication are retained and the new receipt is rolled back',t=>{
 const f=fixture(t),file=configFile(f);fs.writeFileSync(file,'{ "theme": "dark" }\n');
 const plan=planZcodeConfig(f),edited='{\n "theme": "external"\n}\n',original=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{const result=original(from,to);if(to===receiptFile(f))fs.writeFileSync(file,edited);return result;});
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
 assert.equal(fs.readFileSync(file,'utf8'),edited);assert.equal(fs.existsSync(receiptFile(f)),false);
 assert.deepEqual(fs.readdirSync(path.dirname(file)),['config.json']);
});
test('rollback refuses to overwrite an externally replaced receipt',t=>{
 const f=fixture(t),plan=planZcodeConfig(f),original=fs.renameSync,external='{ "operator": "retain" }\n';
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(to===configFile(f)){fs.writeFileSync(receiptFile(f),external);throw new Error('INJECTED_RENAME_FAILURE');}
  return original(from,to);
 });
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_ROLLBACK_CONFLICT/);
 assert.equal(fs.readFileSync(receiptFile(f),'utf8'),external);assert.equal(fs.existsSync(configFile(f)),false);
 assert.deepEqual(fs.readdirSync(path.dirname(configFile(f))),['.gstack861-zcode-config.json']);
});
test('a receipt edit during the final config rename fails and preserves the external receipt',t=>{
 const f=fixture(t),plan=planZcodeConfig(f),original=fs.renameSync,external='{ "operator": "retain" }\n';
 t.mock.method(fs,'renameSync',(from,to)=>{const result=original(from,to);if(to===configFile(f))fs.writeFileSync(receiptFile(f),external);return result;});
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_ROLLBACK_CONFLICT/);
 assert.equal(fs.readFileSync(receiptFile(f),'utf8'),external);assert.equal(fs.existsSync(configFile(f)),false);
 assert.deepEqual(fs.readdirSync(path.dirname(configFile(f))),['.gstack861-zcode-config.json']);
});
test('a successful rename with a transient readback failure still rolls back config and receipt',t=>{
 const f=fixture(t),plan=planZcodeConfig(f),original=fs.openSync;let injected=0;
 t.mock.method(fs,'openSync',(file,flags,...args)=>{
  if(file===configFile(f)&&typeof flags==='number'&&fs.existsSync(file)&&injected===0){injected++;const error=new Error('INJECTED_READBACK_EIO');error.code='EIO';throw error;}
  return original(file,flags,...args);
 });
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_UNSAFE/);
 assert.equal(injected,1);assert.deepEqual(fs.readdirSync(path.dirname(configFile(f))),[]);
});
test('a failed readback never authorizes rollback over a concurrent external config',t=>{
 const f=fixture(t),plan=planZcodeConfig(f),original=fs.openSync,external='{ "external": "retain" }\n';let injected=0;
 t.mock.method(fs,'openSync',(file,flags,...args)=>{
  if(file===configFile(f)&&typeof flags==='number'&&fs.existsSync(file)&&injected===0){injected++;fs.writeFileSync(file,external);const error=new Error('INJECTED_READBACK_EIO');error.code='EIO';throw error;}
  return original(file,flags,...args);
 });
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_ROLLBACK_CONFLICT/);
 assert.equal(injected,1);assert.equal(fs.readFileSync(configFile(f),'utf8'),external);
 assert.equal(fs.existsSync(path.join(f.root,'.zcode','.gstack861-zcode-config.lock')),false);
 assert.equal(fs.readdirSync(path.dirname(configFile(f))).some(name=>name.endsWith('.tmp')),false);
});
test('two processes with the same precomputed snapshot publish exactly one config',async t=>{
 const f=fixture(t),moduleUrl=new URL('../src/zcode-profile.mjs',import.meta.url).href;
 const program=`import {planZcodeConfig,applyZcodeConfigPlan} from ${JSON.stringify(moduleUrl)};
 const plan=planZcodeConfig(JSON.parse(process.argv[1]));console.log('READY');
 process.stdin.once('data',()=>{try{console.log(JSON.stringify(applyZcodeConfigPlan(plan)));}
 catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=1;}});`;
 const launch=()=>{
  const child=spawn(process.execPath,['--input-type=module','--eval',program,JSON.stringify(f)],{stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(10000)});
  let output='',errors='',readyResolve,readyReject,readySeen=false;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stdout.on('data',bytes=>{output+=bytes;if(!readySeen&&output.includes('READY\n')){readySeen=true;readyResolve();}});
  child.stderr.on('data',bytes=>{errors+=bytes;});
  child.on('error',readyReject);
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{if(!readySeen)readyReject(new Error(errors||'CHILD_NOT_READY'));resolve({code,signal,output,errors});}));
  t.after(()=>{if(child.exitCode===null)child.kill();});return {child,ready,done};
 };
 const workers=[launch(),launch()];await Promise.all(workers.map(worker=>worker.ready));
 for(const worker of workers)worker.child.stdin.end('APPLY\n');
 const outcomes=await Promise.all(workers.map(worker=>worker.done));
 assert.deepEqual(outcomes.map(value=>value.code).sort(),[0,1]);
 for(const value of outcomes)assert.equal(value.signal,null,value.errors);
 const refused=outcomes.find(value=>value.code===1);assert.match(refused.output,/ZCODE_(CONFIG_(CHANGED|BUSY)|RECEIPT_CHANGED)/);
 assert.equal(JSON.parse(fs.readFileSync(configFile(f))).hooks.events.PreToolUse.length,1);
 assert.equal(JSON.parse(fs.readFileSync(receiptFile(f))).entries.length,1);
 assert.deepEqual(fs.readdirSync(path.dirname(configFile(f))).sort(),['.gstack861-zcode-config.json','config.json']);
});

// Deterministic metadata-source injection, not a native Windows execution.
// Node 22's Windows path API can return a 64-bit volume serial while the handle
// API supplies its low 32 bits. All file operations still use actual temp files.
function injectWindowsVolumeMetadata(t) {
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),lstat=fs.lstatSync,fstat=fs.fstatSync;
 const state={high:0x1234567800000000n,pathHigh:new Map(),descriptor:stat=>stat};
 const copy=(stat,changes)=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,changes);
 Object.defineProperty(process,'platform',{value:'win32'});
 t.after(()=>Object.defineProperty(process,'platform',platform));
 t.mock.method(fs,'lstatSync',(file,...args)=>{
  const stat=lstat(file,...args);if(!stat||typeof stat.dev!=='bigint')return stat;
  return copy(stat,{dev:(state.pathHigh.get(String(file))??state.high)|(stat.dev&0xffffffffn)});
 });
 t.mock.method(fs,'fstatSync',(fd,...args)=>{
  const stat=fstat(fd,...args);if(typeof stat.dev!=='bigint')return stat;
  return state.descriptor(copy(stat,{dev:stat.dev&0xffffffffn}));
 });
 return state;
}
test('injected Windows volume-serial sources preserve the complete config lifecycle',t=>{
 const f=fixture(t),file=configFile(f);fs.writeFileSync(file,'{}\n');
 const fd=fs.openSync(file,'r');
 try {
  const fields=stat=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].map(key=>[key,String(stat[key])]));
  t.diagnostic(JSON.stringify({actualPlatform:process.platform,node:process.version,path:fields(fs.lstatSync(file,{bigint:true})),descriptor:fields(fs.fstatSync(fd,{bigint:true}))}));
 } finally {fs.closeSync(fd);}
 injectWindowsVolumeMetadata(t);
 const plan=planZcodeConfig(f);assert.equal(applyZcodeConfigPlan(plan).changed,true);
 const installed=bytesIn(path.dirname(file));
 assert.equal(applyZcodeConfigPlan(planZcodeConfig(f)).changed,false);assert.deepEqual(bytesIn(path.dirname(file)),installed);
 assert.equal(applyZcodeConfigPlan(planZcodeUninstall(f)).changed,true);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{});
 assert.deepEqual(fs.readdirSync(path.dirname(file)),['config.json']);
});
test('injected Windows volume serials still clean a partially written staged file',t=>{
 const f=fixture(t,false);injectWindowsVolumeMetadata(t);const plan=planZcodeConfig(f),write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file,...args)=>{if(typeof file==='number'){fs.writeSync(file,'partial');throw new Error('INJECTED_PARTIAL_WRITE');}return write(file,...args);});
 assert.throws(()=>applyZcodeConfigPlan(plan),/INJECTED_PARTIAL_WRITE/);
 assert.equal(fs.existsSync(path.join(f.root,'.zcode')),false);
});
test('injected Windows path and handle binding rejects other identity and version differences',t=>{
 const f=fixture(t),file=configFile(f);fs.writeFileSync(file,'{}\n');const state=injectWindowsVolumeMetadata(t);
 const before=bytesIn(path.dirname(file));
 for(const key of ['dev','ino','size','mtimeNs','ctimeNs','mode']) {
  state.descriptor=stat=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{[key]:stat[key]+1n});
  assert.throws(()=>planZcodeConfig(f),/ZCODE_CONFIG_(CHANGED|UNSAFE)/,key);
  assert.deepEqual(bytesIn(path.dirname(file)),before,key);
 }
 state.descriptor=stat=>stat;Object.defineProperty(process,'platform',{value:'linux'});
 assert.throws(()=>planZcodeConfig(f),/ZCODE_CONFIG_CHANGED/,'the device-width exception is Windows-only');
});
test('injected Windows snapshots retain the high volume bits in path CAS',t=>{
 const f=fixture(t),file=configFile(f);fs.writeFileSync(file,'{}\n');const state=injectWindowsVolumeMetadata(t);
 const plan=planZcodeConfig(f),before=bytesIn(path.dirname(file));
 state.pathHigh.set(file,0x7654321000000000n);
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
 assert.deepEqual(bytesIn(path.dirname(file)),before);
});
test('stage metadata binding closes its descriptor and preserves a foreign replacement',t=>{
 const f=fixture(t,false),plan=planZcodeConfig(f),lstat=fs.lstatSync,open=fs.openSync,close=fs.closeSync;
 const external='{ "foreign": "retain" }\n';let replaced,stageFd,closed=false;
 t.mock.method(fs,'openSync',(file,flags,...args)=>{const fd=open(file,flags,...args);if(flags==='wx'&&stageFd===undefined)stageFd=fd;return fd;});
 t.mock.method(fs,'closeSync',fd=>{if(fd===stageFd)closed=true;return close(fd);});
 t.mock.method(fs,'lstatSync',(file,...args)=>{
  if(String(file).endsWith('.tmp')&&!replaced){const other=file+'.external';fs.writeFileSync(other,external);fs.renameSync(other,file);replaced=String(file);}
  return lstat(file,...args);
 });
 assert.throws(()=>applyZcodeConfigPlan(plan),/ZCODE_CONFIG_CHANGED/);
 assert.ok(replaced);assert.equal(closed,true);assert.equal(fs.readFileSync(replaced,'utf8'),external);
 assert.deepEqual(fs.readdirSync(path.join(f.root,'.zcode')),[path.basename(replaced)]);
});
