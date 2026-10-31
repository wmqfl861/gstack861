import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageDshProfile } from '../src/dsh-profile.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';
import { loadPolicy } from '../src/policy.mjs';
import * as guardPlugin from '../src/adapters/dsh.mjs';
import * as skillsPlugin from '../src/adapters/dsh-skills.mjs';

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
 assert.ok(fs.readFileSync(path.join(f.output,'plugins/gstack861-guard/index.mjs'),'utf8').includes(pathToFileURL(f.adapter).href));
});
test('generated guard shim imports the real adapter from paths with spaces, #, %, and Unicode',async t=>{
 const f=fixture(t),special=path.join(f.root,'adapter space # 50% 中文');
 const sources=['adapters/dsh.mjs','policy.mjs','json.mjs'].map(relative=>({
   target:path.join(special,'src',relative),
   bytes:fs.readFileSync(new URL('../src/'+relative,import.meta.url)),
 }));
 for(const {target,bytes} of sources) {
   fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.writeFileSync(target,bytes,{flag:'wx'});
 }
 const adapter=path.join(special,'src','adapters','dsh.mjs'),output=path.join(special,'profile');
 const result=stageDshProfile({output,policyPath:f.policy,adapterPath:adapter,skillsDir:f.skills});
 assert.equal(result.status,'scaffolded-not-host-verified');
 const adapterUrl=pathToFileURL(adapter).href;
 assert.equal(fileURLToPath(adapterUrl),adapter);
 const realAdapter=await import(adapterUrl);
 const shim=await import(pathToFileURL(path.join(output,'plugins/gstack861-guard/index.mjs')).href);
 assert.equal(shim.name,guardPlugin.name);
 assert.deepEqual(shim.inject,guardPlugin.inject);
 assert.notEqual(realAdapter.apply,guardPlugin.apply,'the copied adapter has its own module identity');
 assert.equal(shim.apply,realAdapter.apply,'shim must import the adapter at the exact special-character path');
 for(const {target,bytes} of sources) {
   const actual=fs.readFileSync(target);
   assert.deepEqual(actual,bytes,'real adapter and transitive source bytes must remain intact');
   assert.equal(textDigest(actual),textDigest(bytes));
 }
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

test('both generated plugin dependencies load the real adapters and preserve their offline contracts', async t => {
 const f=fixture(t);
 const realAdapter=fileURLToPath(new URL('../src/adapters/dsh.mjs',import.meta.url));
 const staging=path.join(f.root,'staging'), name='gstack-review';
 const body='---\nname: gstack-review\ndescription: Review local changes.\n---\nRead the diff.\n';
 fs.mkdirSync(path.join(staging,name),{recursive:true});
 fs.writeFileSync(path.join(staging,name,'SKILL.md'),body);
 fs.writeFileSync(path.join(staging,name,'manifest.json'),JSON.stringify({schemaVersion:1,name,host:'dsh',
   generator:'gstack861',commit:'a'.repeat(40),sha256:textDigest(body)}));
 installSkills({staging,target:f.skills});
 const policy=JSON.parse(fs.readFileSync(f.policy));
 policy.writeRoots=[f.workspace];
 policy.bindings.dsh={read:{effect:'read',pathKey:'file_path'},write:{effect:'write',pathKey:'file_path'}};
 fs.writeFileSync(f.policy,JSON.stringify(policy));
 const result=stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:realAdapter,skillsDir:f.skills});
 const pkg=JSON.parse(fs.readFileSync(path.join(f.output,'package.json')));
 const expected={'gstack861-guard':guardPlugin,'gstack861-skills':skillsPlugin};
 const loaded={};
 for(const [name,spec] of Object.entries(pkg.dependencies)) {
   assert.match(spec,/^file:/);
   const dir=path.resolve(f.output,spec.slice(5)),manifest=path.join(dir,'package.json');
   assert.equal(fs.existsSync(manifest),true,`declared dependency ${name} must exist`);
   const pluginPackage=JSON.parse(fs.readFileSync(manifest));
   assert.equal(pluginPackage.name,name);
   loaded[name]=await import(pathToFileURL(path.join(dir,pluginPackage.main)).href);
   assert.equal(loaded[name].apply,expected[name].apply,'shim must load the project adapter');
   assert.deepEqual(loaded[name].inject,expected[name].inject);
   for(const file of ['package.json',pluginPackage.main]) assert.ok(result.files.includes(path.relative(f.output,path.join(dir,file)).split(path.sep).join('/')));
 }
 assert.deepEqual(Object.keys(loaded).sort(),Object.keys(expected).sort());
 // Service recorders exercise the actual adapters; they are not a DSH host.
 let guard;
 const dispose=()=>{},sections=[];
 assert.equal(loaded['gstack861-guard'].apply({tools:{guard(fn){guard=fn;return dispose;}}},{policyPath:f.policy}),dispose);
 assert.equal(guard({name:'write',arguments:{file_path:path.join(f.workspace,'allowed.txt')}}),undefined);
 assert.equal(guard({name:'write',arguments:{file_path:path.join(f.root,'outside.txt')}}),'gstack861:OUTSIDE_SCOPE');
 assert.equal(guard({name:'exec',arguments:{command:'ignored'}}),'gstack861:UNMAPPED_TOOL');
 assert.equal(fs.existsSync(path.join(f.workspace,'allowed.txt')),false,'admission never executes a file tool');
 assert.equal(loaded['gstack861-skills'].apply({systemPrompt:{section(v){sections.push(v);return dispose;}}},{skillsDir:f.skills}),dispose);
 assert.equal(sections.length,1);
 assert.equal(sections[0].interpolate,false);
 assert.ok(sections[0].text.includes(`- ${name} | Review local changes. | ${path.join(f.skills,name,'SKILL.md')}`));
 fs.appendFileSync(path.join(f.skills,name,'SKILL.md'),'tampered');
 assert.throws(()=>loaded['gstack861-skills'].apply({systemPrompt:{section(v){sections.push(v);}}},{skillsDir:f.skills}),/SKILL_TAMPERED/);
 assert.equal(sections.length,1,'failed activation must add no partial section');
 fs.writeFileSync(f.policy,'{');
 assert.equal(guard({name:'write',arguments:{file_path:path.join(f.workspace,'allowed.txt')}}),'gstack861:POLICY_UNAVAILABLE');
});

test('refuses policy compilation and permission failures before writing a profile',t=>{
 const cases=[
   raw=>({schemaVersion:1,workspace:raw.workspace}),
   raw=>({...raw,unknown:true}),
   (raw,f)=>({...raw,writeRoots:[f.root]}),
   raw=>({...raw,bindings:{dsh:{write:{effect:'execute',pathKey:'file_path'}}}}),
 ];
 for(const mutate of cases) {
   const f=fixture(t),raw=JSON.parse(fs.readFileSync(f.policy));
   fs.writeFileSync(f.policy,JSON.stringify(mutate(raw,f)));
   assert.throws(()=>loadPolicy(f.policy),'fixture must also be rejected by the shared policy loader');
   assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills}),/POLICY_FILE_INVALID/);
   assert.equal(fs.existsSync(f.output),false);
 }
 if(process.platform!=='win32') {
   const f=fixture(t);fs.chmodSync(f.policy,0o666);
   assert.throws(()=>loadPolicy(f.policy),/UNSAFE_POLICY_PERMISSIONS/);
   assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills}),/POLICY_FILE_INVALID/);
   assert.equal(fs.existsSync(f.output),false);
 }
});

test('uses the canonical workspace to reject a policy hidden by a workspace alias',t=>{
 const f=fixture(t),alias=path.join(f.root,'workspace-alias'),inside=path.join(f.workspace,'policy.json');
 fs.symlinkSync(f.workspace,alias,process.platform==='win32'?'junction':'dir');
 const raw=JSON.parse(fs.readFileSync(f.policy));
 fs.writeFileSync(inside,JSON.stringify({...raw,workspace:alias}),{mode:0o600});
 assert.throws(()=>stageDshProfile({output:f.output,policyPath:inside,adapterPath:f.adapter,skillsDir:f.skills}),/POLICY_MUST_BE_OUTSIDE_WORKSPACE/);
 assert.equal(fs.existsSync(f.output),false);
});

for(const field of ['output','policy','adapter','skills']) {
 test(`refuses an ancestor directory link for ${field} with no profile writes`,t=>{
   const f=fixture(t),real=path.join(f.root,'real'),alias=path.join(f.root,'ancestor-link');
   fs.mkdirSync(path.join(real,'nested'),{recursive:true});
   fs.symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');
   if(field==='output') f.output=path.join(alias,'nested','profile');
   if(field==='policy') {fs.copyFileSync(f.policy,path.join(real,'nested','policy.json'));f.policy=path.join(alias,'nested','policy.json');}
   if(field==='adapter') {fs.copyFileSync(f.adapter,path.join(real,'nested','dsh.mjs'));f.adapter=path.join(alias,'nested','dsh.mjs');}
   if(field==='skills') {fs.mkdirSync(path.join(real,'nested','skills'));f.skills=path.join(alias,'nested','skills');}
   const expected={output:/OUTPUT_PARENT_INVALID/,policy:/POLICY_FILE_REQUIRED/,adapter:/ADAPTER_FILE_REQUIRED/,skills:/SKILLS_DIR_INVALID/};
   assert.throws(()=>stageDshProfile({output:f.output,policyPath:f.policy,adapterPath:f.adapter,skillsDir:f.skills}),expected[field]);
   assert.equal(fs.existsSync(f.output),false);
 });
}
