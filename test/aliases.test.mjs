import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageCommandAliases } from '../src/aliases.mjs';
import { textDigest } from '../src/json.mjs';
import { installSkills, uninstallSkills } from '../src/install.mjs';

function fixture(t, host='zcode') {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g861-alias-')));
 const staging=path.join(root,'staging'), output=path.join(root,'output'), dir=path.join(staging,'open-gstack-browser');
 fs.mkdirSync(path.join(dir,'sections'),{recursive:true});
 const body=Buffer.from('---\nname: open-gstack-browser\ndescription: browser\n---\n\n# /open-gstack-browser\nRead sections/guide.md\n');
 const section=Buffer.from('guide');
 fs.writeFileSync(path.join(dir,'SKILL.md'),body); fs.writeFileSync(path.join(dir,'sections/guide.md'),section);
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,generator:'gstack861',name:'open-gstack-browser',host,commit:'a'.repeat(40),sha256:textDigest(body),files:{'sections/guide.md':textDigest(section)}}));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return {root,staging,output,dir};
}
test('rewrites only frontmatter name and copies verified auxiliary files',t=>{
 const f=fixture(t),r=stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'});
 const body=fs.readFileSync(path.join(f.output,'connect-chrome/SKILL.md'),'utf8');
 assert.match(body,/^---\nname: connect-chrome\n/); assert.match(body,/# \/open-gstack-browser/);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/sections/guide.md'),'utf8'),'guide');
 const m=JSON.parse(fs.readFileSync(path.join(f.output,'connect-chrome/manifest.json')));
 assert.equal(m.aliasOf,'open-gstack-browser'); assert.equal(r.aliases.length,1);
});
test('supports DSH staging contract without claiming host installation',t=>{
 const f=fixture(t,'dsh'); assert.equal(stageCommandAliases({staging:f.staging,output:f.output,host:'dsh'}).host,'dsh');
});
test('refuses tampering, symlinks, malformed frontmatter and wrong host before output',t=>{
 const f=fixture(t); fs.appendFileSync(path.join(f.dir,'SKILL.md'),'tamper');
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),/TAMPERED/);
 assert.equal(fs.existsSync(f.output),false);
 const g=fixture(t); const invalid=Buffer.from('invalid'); fs.writeFileSync(path.join(g.dir,'SKILL.md'),invalid);
 const manifestFile=path.join(g.dir,'manifest.json'); const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')); manifest.sha256=textDigest(invalid); fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 assert.throws(()=>stageCommandAliases({staging:g.staging,output:g.output,host:'zcode'}),/FRONTMATTER/);
 assert.equal(fs.existsSync(g.output),false);
 const h=fixture(t); assert.throws(()=>stageCommandAliases({staging:h.staging,output:h.output,host:'bad'}),/INVALID_HOST/);
});
test('refuses output overlap and preserves non-empty operator output',t=>{
 const f=fixture(t); assert.throws(()=>stageCommandAliases({staging:f.staging,output:path.join(f.staging,'nested'),host:'zcode'}),/OVERLAP/);
 fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output,'user.txt'),'keep');
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),/NOT_EMPTY/);
 assert.equal(fs.readFileSync(path.join(f.output,'user.txt'),'utf8'),'keep');
});

function updateManifest(f, update) {
 const file=path.join(f.dir,'manifest.json'), manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 update(manifest); fs.writeFileSync(file,JSON.stringify(manifest));
}
function updateBody(f, bytes) {
 fs.writeFileSync(path.join(f.dir,'SKILL.md'),bytes);
 updateManifest(f,m=>{m.sha256=textDigest(bytes);});
}
function assertNoOutput(f, pattern) {
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),pattern);
 assert.equal(fs.existsSync(f.output),false);
}
test('changes only the name bytes while retaining CRLF and arbitrary body bytes',t=>{
 const f=fixture(t), tail=Buffer.from([0x61,0xff,0xc0,0x00,0x62]);
 const before=Buffer.concat([Buffer.from('---\r\nname: open-gstack-browser\r\ndescription: browser\r\n---\r\n'),tail]);
 updateBody(f,before);
 const originalManifest=fs.readFileSync(path.join(f.dir,'manifest.json'));
 stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'});
 const expected=Buffer.concat([Buffer.from('---\r\nname: connect-chrome\r\ndescription: browser\r\n---\r\n'),tail]);
 assert.deepEqual(fs.readFileSync(path.join(f.output,'connect-chrome/SKILL.md')),expected);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'SKILL.md')),before);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'manifest.json')),originalManifest);
});
test('refuses physical output overlap through an existing parent link',t=>{
 const f=fixture(t), link=path.join(f.root,'parent-link');
 fs.symlinkSync(f.staging,link,process.platform==='win32'?'junction':'dir');
 const before=fs.readdirSync(f.staging);
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:path.join(link,'new-output'),host:'zcode'}),/OVERLAPPING_PATHS/);
 assert.deepEqual(fs.readdirSync(f.staging),before);
});
test('refuses physical overlap when the input has a linked ancestor',t=>{
 const f=fixture(t), link=path.join(f.root,'parent-link');
 fs.symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>stageCommandAliases({staging:path.join(link,'staging'),output:path.join(f.staging,'new-output'),host:'zcode'}),/OVERLAPPING_PATHS/);
 assert.equal(fs.existsSync(path.join(f.staging,'new-output')),false);
});
test('rejects malformed manifest types before creating output',t=>{
 for (const update of [m=>{m.commit=['a'.repeat(40)];},m=>{m.files=null;},m=>{m.files=[];},m=>{m.files['sections/guide.md']=['a'.repeat(64)];},m=>{m.host='dsh';}]) {
  const f=fixture(t); updateManifest(f,update); assertNoOutput(f,/ALIAS_SOURCE_INVALID/);
 }
});
test('refuses reserved auxiliary names before touching an existing empty output',t=>{
 const f=fixture(t); updateManifest(f,m=>{m.files['SKILL.md']=m.sha256;});
 fs.mkdirSync(f.output); const before=fs.statSync(f.output);
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),/ALIAS_SOURCE_INVALID/);
 assert.equal(fs.statSync(f.output).ino,before.ino); assert.deepEqual(fs.readdirSync(f.output),[]);
});
test('refuses case and file-directory auxiliary collisions accepted by a case-sensitive source',t=>{
 if (process.platform==='win32') return t.skip('requires case-sensitive source fixtures; manifest-only collision preflight has a separate test');
 for (const keys of [['Guide.md','guide.md'],['Guide','guide/deep.md'],['Sections/a.md','sections/b.md']]) {
  const f=fixture(t);
  updateManifest(f,m=>{
   for (const key of keys) {
    fs.mkdirSync(path.dirname(path.join(f.dir,key)),{recursive:true}); fs.writeFileSync(path.join(f.dir,key),key);
    m.files[key]=textDigest(key);
   }
  });
  assertNoOutput(f,/ALIAS_SOURCE_INVALID/);
 }
});
test('preflights case collisions before reading files on any platform',t=>{
 for (const keys of [['Guide.md','guide.md'],['Guide','guide/deep.md'],['Sections/a.md','sections/b.md']]) {
  const f=fixture(t);
  updateManifest(f,m=>{m.files=Object.fromEntries(keys.map(key=>[key,'a'.repeat(64)]));});
  assertNoOutput(f,/ALIAS_SOURCE_INVALID/);
 }
});
test('rejects unsafe auxiliary keys without probing or writing their targets',t=>{
 for (const key of ['../outside','/absolute','a\\b','a//b','a/b/c/d/e','skill.md','MANIFEST.JSON','SKILL.md/child']) {
  const f=fixture(t); updateManifest(f,m=>{m.files[key]='a'.repeat(64);});
  assertNoOutput(f,/ALIAS_SOURCE_INVALID/);
 }
});
test('refuses linked auxiliary ancestors and hardlinked source files',t=>{
 const f=fixture(t), outside=path.join(f.root,'external'); fs.mkdirSync(outside);
 fs.writeFileSync(path.join(outside,'guide.md'),'guide'); fs.rmSync(path.join(f.dir,'sections'),{recursive:true});
 fs.symlinkSync(outside,path.join(f.dir,'sections'),process.platform==='win32'?'junction':'dir');
 assertNoOutput(f,/ALIAS_SOURCE_UNSAFE/);
 for (const name of ['SKILL.md','manifest.json','sections/guide.md']) {
  const g=fixture(t); fs.linkSync(path.join(g.dir,name),path.join(g.root,'hardlink'));
  assertNoOutput(g,/ALIAS_SOURCE_UNSAFE/);
 }
});
test('rejects duplicate frontmatter identity even with spaced or quoted YAML keys',t=>{
 for (const second of ['name: other','name : other','"name": other',"'name': other"]) {
  const f=fixture(t);updateBody(f,Buffer.from(`---\nname: open-gstack-browser\n${second}\n---\nbody\n`));
  assertNoOutput(f,/ALIAS_(FRONTMATTER_INVALID|CANONICAL_NAME_MISMATCH)/);
 }
});
test('refuses tagged, anchored and alias keys before creating ambiguous alias metadata',t=>{
 for (const header of ['!!str name: other','!<tag:yaml.org,2002:str> name: other','&anchor name: other','identity: &nameKey name\n*nameKey : other']) {
  const f=fixture(t),before=Buffer.from(`---\nname: open-gstack-browser\n${header}\n---\nbody\n`);
  updateBody(f,before);const manifest=fs.readFileSync(path.join(f.dir,'manifest.json'));
  assertNoOutput(f,/ALIAS_FRONTMATTER_INVALID/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'SKILL.md')),before);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'manifest.json')),manifest);
 }
});
test('rollback preserves a pre-existing output and removes only its own new alias directory',t=>{
 const f=fixture(t);fs.mkdirSync(f.output);const original=fs.statSync(f.output), write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file,...args)=>{
  if (file===path.join(f.output,'connect-chrome','manifest.json')) throw new Error('INJECTED_ALIAS_WRITE_FAILURE');
  return write(file,...args);
 });
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),/INJECTED_ALIAS_WRITE_FAILURE/);
 assert.equal(fs.statSync(f.output).ino,original.ino);assert.deepEqual(fs.readdirSync(f.output),[]);
 assert.equal(fs.readFileSync(path.join(f.dir,'sections/guide.md'),'utf8'),'guide');
});
test('rollback removes its newly created empty output after a write failure',t=>{
 const f=fixture(t),write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file,...args)=>{
  if(file===path.join(f.output,'connect-chrome','manifest.json'))throw new Error('INJECTED_ALIAS_WRITE_FAILURE');
  return write(file,...args);
 });
 assert.throws(()=>stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'}),/INJECTED_ALIAS_WRITE_FAILURE/);
 assert.equal(fs.existsSync(f.output),false);
});
test('valid alias installs idempotently, preserves user edits, and uninstalls through its registry',t=>{
 const f=fixture(t), target=path.join(f.root,'target');
 stageCommandAliases({staging:f.staging,output:f.output,host:'zcode'});
 assert.deepEqual(installSkills({staging:f.staging,target}).installed,['open-gstack-browser']);
 assert.deepEqual(installSkills({staging:f.output,target}).installed,['connect-chrome']);
 const installed=path.join(target,'connect-chrome'), original=fs.readFileSync(path.join(installed,'SKILL.md'));
 const inode=fs.statSync(path.join(installed,'SKILL.md')).ino;
 assert.deepEqual(installSkills({staging:f.output,target}).skipped,['connect-chrome']);
 assert.equal(fs.statSync(path.join(installed,'SKILL.md')).ino,inode);
 fs.appendFileSync(path.join(installed,'sections/guide.md'),' user edit');
 const registry=fs.readFileSync(path.join(target,'.gstack861-registry.json'));
 assert.throws(()=>uninstallSkills({target}),/USER_FILE_REFUSED/);
 assert.deepEqual(fs.readFileSync(path.join(target,'.gstack861-registry.json')),registry);
 assert.deepEqual(fs.readFileSync(path.join(installed,'SKILL.md')),original);
 fs.writeFileSync(path.join(installed,'sections/guide.md'),'guide');
 assert.deepEqual(uninstallSkills({target}).uninstalled.sort(),['connect-chrome','open-gstack-browser']);
 assert.deepEqual(uninstallSkills({target}).uninstalled,[]);
});
