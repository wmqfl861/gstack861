import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stageCommandAliases } from '../src/aliases.mjs';
import { installSkills, uninstallSkills, loadRegistry } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

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

const manifestPath = f => path.join(f.dir, 'manifest.json');
function updateManifest(f, change) {
 const manifest = JSON.parse(fs.readFileSync(manifestPath(f), 'utf8'));
 change(manifest);
 fs.writeFileSync(manifestPath(f), JSON.stringify(manifest));
}
function snapshot(root) {
 const records = [];
 const walk = (file, rel) => {
  const s = fs.lstatSync(file, {throwIfNoEntry:false});
  if (!s) return;
  if (s.isSymbolicLink()) { records.push([rel, 'link', fs.readlinkSync(file)]); return; }
  if (s.isDirectory()) {
   records.push([rel, 'directory']);
   for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), rel ? `${rel}/${name}` : name);
  } else records.push([rel, 'file', fs.readFileSync(file).toString('hex')]);
 };
 walk(root, '');
 return records;
}
const stage = (f, extra={}) => stageCommandAliases({staging:f.staging,output:f.output,host:'zcode',...extra});
function unchangedRefusal(f, expected, extra={}) {
 const before = snapshot(f.root);
 assert.throws(() => stage(f, extra), expected);
 assert.deepEqual(snapshot(f.root), before);
}
function patchFs(t, key, replacement) {
 const original = fs[key];
 fs[key] = replacement(original);
 t.after(() => { fs[key] = original; });
}
function failManifestWrite(t, f, onFailure=()=>{}) {
 const error = Object.assign(new Error('ALIAS_TEST_WRITE_FAILURE'), {code:'EIO'});
 const manifest = path.join(f.output, 'connect-chrome', 'manifest.json');
 let manifestFd;
 patchFs(t, 'openSync', original => function(file, ...args) {
  const fd = original.call(this, file, ...args);
  if (String(file) === manifest && args[0] === 'wx') manifestFd = fd;
  return fd;
 });
 patchFs(t, 'writeFileSync', original => function(file, ...args) {
  if (String(file) === manifest || (typeof file === 'number' && file === manifestFd)) { onFailure(); throw error; }
  return original.call(this, file, ...args);
 });
 return error;
}

// Each malformed map must be rejected during preflight, including keys whose
// source could not be materialized on a case-insensitive filesystem.
for (const [label, files] of [
 ['null map', null], ['array map', []], ['string map', 'invalid'],
 ['reserved skill', {'SKILL.md':'a'.repeat(64)}],
 ['reserved lowercase skill', {'skill.md':'a'.repeat(64)}],
 ['reserved manifest', {'manifest.json':'a'.repeat(64)}],
 ['reserved mixed-case manifest', {'Manifest.JSON':'a'.repeat(64)}],
 ['case collision', {'sections/guide.md':'a'.repeat(64),'SECTIONS/GUIDE.md':'a'.repeat(64)}],
 ['file directory collision', {'sections':'a'.repeat(64),'sections/guide.md':'a'.repeat(64)}],
 ['case file directory collision', {'SECTIONS':'a'.repeat(64),'sections/guide.md':'a'.repeat(64)}],
 ['reserved file directory collision', {'skill.md/guide.md':'a'.repeat(64)}],
 ['numeric digest', {'sections/guide.md':1}],
 ['null digest', {'sections/guide.md':null}],
 ['malformed digest', {'sections/guide.md':'bad'}],
]) {
 test(`preflights auxiliary ${label} before creating output`, t => {
  const f = fixture(t);
  updateManifest(f, m => { m.files = files; });
  // SKILL.md is a real source, so reserved-name acceptance reaches the write
  // collision in the old implementation without relying on a missing file.
  if (label.includes('skill') && !label.includes('directory')) {
   updateManifest(f, m => { for (const key of Object.keys(m.files)) m.files[key] = m.sha256; });
  }
  unchangedRefusal(f, /^Error: ALIAS_SOURCE_INVALID$/);
 });
}
for (const type of new Set(['dir', process.platform === 'win32' ? 'junction' : 'dir'])) {
 for (const side of ['source','output']) {
  test(`refuses ${type} ancestor of alias ${side}`, t => {
   const f = fixture(t), view = path.join(f.root, 'view');
   const physical = side === 'source' ? f.root : path.join(f.root, 'physical');
   if (side === 'output') fs.mkdirSync(physical);
   fs.symlinkSync(physical, view, type);
   const extra = side === 'source' ? {staging:path.join(view,'staging')} : {output:path.join(view,'output')};
   unchangedRefusal(f, side === 'source' ? /INVALID_STAGING|ALIAS_SOURCE_UNSAFE/ : /STAGING_NOT_EMPTY/, extra);
  });
 }
}
test('refuses physical source/output overlap through an ancestor link', t => {
 const f = fixture(t), view = path.join(f.root, 'view');
 fs.symlinkSync(f.staging, view, process.platform === 'win32' ? 'junction' : 'dir');
 unchangedRefusal(f, /OVERLAPPING_PATHS|STAGING_NOT_EMPTY/, {output:path.join(view,'nested')});
});
if (process.platform === 'win32') {
 test('refuses physical overlap with a mixed Windows namespace path', t => {
  const f = fixture(t);
  unchangedRefusal(f, /OVERLAPPING_PATHS/, {output:path.toNamespacedPath(path.join(f.staging,'nested'))});
 });
 test('refuses physical overlap with a Windows short path', t => {
  const f = fixture(t);
  const short = execFileSync('cmd.exe', ['/d','/s','/c','for %I in ("'+f.staging+'") do @echo %~sI'],
   {encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true}).trim();
  assert.ok(path.isAbsolute(short), 'cmd returns an absolute short-path spelling');
  unchangedRefusal(f, /OVERLAPPING_PATHS/, {output:path.join(short,'nested')});
 });
}
test('rejects a replaced plain source ancestor even when bytes match', t => {
 const f = fixture(t), replacement = path.join(f.root,'replacement'), saved = path.join(f.root,'original');
 fs.cpSync(f.dir, replacement, {recursive:true});
 let swapped = false;
 patchFs(t, 'readFileSync', original => function(file, ...args) {
  const result = original.call(this, file, ...args);
  const sourceRead = typeof file === 'number' || String(file) === manifestPath(f);
  if (!swapped && sourceRead) {
   swapped = true; fs.renameSync(f.dir,saved); fs.renameSync(replacement,f.dir);
  }
  return result;
 });
 assert.throws(() => stage(f), /ALIAS_SOURCE_UNSAFE/);
 assert.equal(swapped, true);
 assert.equal(fs.existsSync(f.output), false);
});
test('rejects an output parent replaced after source validation', t => {
 const f = fixture(t), parent = path.join(f.root,'parent'), saved = path.join(f.root,'original-parent');
 fs.mkdirSync(parent);
 f.output = path.join(parent,'output');
 let swapped = false;
 patchFs(t, 'readFileSync', original => function(file, ...args) {
  const result = original.call(this, file, ...args);
  if (!swapped && (typeof file === 'number' || String(file) === manifestPath(f))) {
   swapped = true; fs.renameSync(parent,saved); fs.mkdirSync(parent);
  }
  return result;
 });
 assert.throws(() => stage(f), /STAGING_NOT_EMPTY/);
 assert.equal(swapped, true);
 assert.deepEqual(fs.readdirSync(parent), []);
});
test('preserves CRLF bytes outside the exact frontmatter name token', t => {
 const f = fixture(t);
 const input = Buffer.from('---\r\nname: open-gstack-browser\r\ndescription: browser\r\n---\r\n\r\n# /open-gstack-browser\r\n');
 const expected = Buffer.from('---\r\nname: connect-chrome\r\ndescription: browser\r\n---\r\n\r\n# /open-gstack-browser\r\n');
 fs.writeFileSync(path.join(f.dir,'SKILL.md'),input);
 updateManifest(f, m => { m.sha256 = textDigest(input); });
 stage(f);
 assert.deepEqual(fs.readFileSync(path.join(f.output,'connect-chrome/SKILL.md')), expected);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'SKILL.md')), input);
});
for (const preexisting of [false,true]) {
 test(`cleans only created alias files after EIO (${preexisting ? 'existing' : 'new'} output)`, t => {
  const f = fixture(t);
  if (preexisting) fs.mkdirSync(f.output);
  const before = snapshot(f.staging), error = failManifestWrite(t,f);
  assert.throws(() => stage(f), value => value === error);
  assert.equal(fs.existsSync(f.output), preexisting);
  if (preexisting) assert.deepEqual(fs.readdirSync(f.output), []);
  assert.deepEqual(snapshot(f.staging), before);
 });
}
test('preserves a concurrent sibling in caller output after EIO', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const error = failManifestWrite(t,f,()=>fs.writeFileSync(path.join(f.output,'operator.txt'),'keep'));
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(path.join(f.output,'operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(f.output), ['operator.txt']);
});
test('preserves a concurrent child inside the created alias after EIO', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const error = failManifestWrite(t,f,()=>fs.writeFileSync(path.join(f.output,'connect-chrome/operator.txt'),'keep'));
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(path.join(f.output,'connect-chrome')), ['operator.txt']);
});
test('preserves a concurrent child in a newly created output after EIO', t => {
 const f = fixture(t);
 const error = failManifestWrite(t,f,()=>fs.writeFileSync(path.join(f.output,'operator.txt'),'keep'));
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(path.join(f.output,'operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(f.output), ['operator.txt']);
});
test('preserves a destination that another writer created before mkdir', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const dest = path.join(f.output,'connect-chrome'); let collided = false;
 patchFs(t,'mkdirSync', original => function(file,...args) {
  if (!collided && String(file) === dest) {
   collided = true; original.call(this,dest);
   fs.writeFileSync(path.join(dest,'operator.txt'),'keep');
  }
  return original.call(this,file,...args);
 });
 assert.throws(() => stage(f), /EEXIST/);
 assert.equal(collided,true);
 assert.equal(fs.readFileSync(path.join(dest,'operator.txt'),'utf8'),'keep');
});
test('preserves a user file that replaces a generated file before cleanup', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const error = failManifestWrite(t,f,()=>{
  const generated = path.join(f.output,'connect-chrome/SKILL.md');
  fs.renameSync(generated,path.join(f.root,'saved-generated'));
  fs.writeFileSync(generated,'operator replacement');
 });
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/SKILL.md'),'utf8'),'operator replacement');
});
test('refuses an alias directory replacement between generated writes', t => {
 const f = fixture(t), dest = path.join(f.output,'connect-chrome'), saved = path.join(f.root,'saved-alias');
 const descriptors = new Map(); let replaced = false;
 patchFs(t,'openSync', original => function(file,...args) {
  const fd = original.call(this,file,...args);
  descriptors.set(fd,String(file));
  return fd;
 });
 patchFs(t,'closeSync', original => function(fd,...args) {
  const filename = descriptors.get(fd), result = original.call(this,fd,...args);
  descriptors.delete(fd);
  if (!replaced && filename === path.join(dest,'SKILL.md')) {
   replaced = true;
   fs.renameSync(dest,saved);
   fs.mkdirSync(dest);
   fs.writeFileSync(path.join(dest,'operator.txt'),'keep');
  }
  return result;
 });
 assert.throws(() => stage(f), /STAGING_NOT_EMPTY/);
 assert.equal(replaced,true);
 assert.equal(fs.readFileSync(path.join(dest,'operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(dest),['operator.txt']);
});
test('refuses a created auxiliary directory replacement before the next file', t => {
 const f = fixture(t), section = path.join(f.output,'connect-chrome/sections'), saved = path.join(f.root,'saved-sections');
 fs.writeFileSync(path.join(f.dir,'sections/second.md'),'second');
 updateManifest(f,m=>{m.files['sections/second.md']=textDigest('second');});
 const descriptors = new Map(); let replaced = false;
 patchFs(t,'openSync', original => function(file,...args) {
  const fd = original.call(this,file,...args); descriptors.set(fd,String(file)); return fd;
 });
 patchFs(t,'closeSync', original => function(fd,...args) {
  const filename = descriptors.get(fd), result = original.call(this,fd,...args);
  descriptors.delete(fd);
  if (!replaced && filename === path.join(section,'guide.md')) {
   replaced = true; fs.renameSync(section,saved); fs.mkdirSync(section);
   fs.writeFileSync(path.join(section,'operator.txt'),'keep');
  }
  return result;
 });
 assert.throws(() => stage(f), /STAGING_NOT_EMPTY/);
 assert.equal(replaced,true);
 assert.equal(fs.readFileSync(path.join(section,'operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(section),['operator.txt']);
});
test('refuses an output directory replaced immediately after a generated file closes', t => {
 const f = fixture(t), saved = path.join(f.root,'saved-output');
 const descriptors = new Map(); let replaced = false;
 patchFs(t,'openSync', original => function(file,...args) {
  const fd = original.call(this,file,...args); descriptors.set(fd,String(file)); return fd;
 });
 patchFs(t,'closeSync', original => function(fd,...args) {
  const filename = descriptors.get(fd), result = original.call(this,fd,...args);
  descriptors.delete(fd);
  if (!replaced && filename === path.join(f.output,'connect-chrome/SKILL.md')) {
   replaced = true; fs.renameSync(f.output,saved); fs.mkdirSync(f.output);
   fs.mkdirSync(path.join(f.output,'connect-chrome'));
   fs.writeFileSync(path.join(f.output,'connect-chrome/operator.txt'),'keep');
  }
  return result;
 });
 assert.throws(() => stage(f), /STAGING_NOT_EMPTY/);
 assert.equal(replaced,true);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/operator.txt'),'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(path.join(f.output,'connect-chrome')),['operator.txt']);
});
test('preserves user bytes written into a newly opened file when the write fails', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const manifest = path.join(f.output,'connect-chrome/manifest.json');
 const error = failManifestWrite(t,f,()=>{
  const fd = fs.openSync(manifest,'r+');
  try { fs.writeSync(fd,Buffer.from('operator data')); } finally { fs.closeSync(fd); }
 });
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(manifest,'utf8'),'operator data');
});
test('cleans an exclusively created partial write after EIO', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const manifest = path.join(f.output,'connect-chrome/manifest.json'); let manifestFd;
 patchFs(t,'openSync', original => function(file,...args) {
  const fd = original.call(this,file,...args);
  if (String(file)===manifest && args[0]==='wx') manifestFd=fd;
  return fd;
 });
 const error = Object.assign(new Error('ALIAS_TEST_PARTIAL_WRITE_FAILURE'),{code:'EIO'});
 patchFs(t,'writeFileSync', original => function(file,bytes,...args) {
  if (file===manifestFd) { fs.writeSync(file,bytes.subarray(0,8)); throw error; }
  return original.call(this,file,bytes,...args);
 });
 assert.throws(() => stage(f), value => value === error);
 assert.deepEqual(fs.readdirSync(f.output),[]);
});
for (const key of ['SKILL.md','manifest.json','sections/guide.md']) {
 test(`refuses a hardlinked alias source ${key} without output writes`, t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.dir,key),path.join(f.root,'shared-source'));
  unchangedRefusal(f,/ALIAS_SOURCE_UNSAFE/);
 });
}
test('validates and creates a multi-directory missing output suffix', t => {
 const f = fixture(t); f.output = path.join(f.root,'new-parent/new-child/output');
 stage(f);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/sections/guide.md'),'utf8'),'guide');
});
test('removes only empty newly created suffix directories after a write failure', t => {
 const f = fixture(t); f.output = path.join(f.root,'new-parent/new-child/output');
 const error = failManifestWrite(t,f);
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.existsSync(path.join(f.root,'new-parent')),false);
});
test('preserves a same-inode user edit to a generated file during cleanup', t => {
 const f = fixture(t); fs.mkdirSync(f.output);
 const error = failManifestWrite(t,f,()=>fs.writeFileSync(path.join(f.output,'connect-chrome/sections/guide.md'),'operator edit'));
 assert.throws(() => stage(f), value => value === error);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/sections/guide.md'),'utf8'),'operator edit');
});
test('refuses changed generated bytes before reporting successful staging', t => {
 const f = fixture(t), generated = path.join(f.output,'connect-chrome/SKILL.md');
 const descriptors = new Map(); let edited = false;
 patchFs(t,'openSync', original => function(file,...args) {
  const fd = original.call(this,file,...args); descriptors.set(fd,String(file)); return fd;
 });
 patchFs(t,'closeSync', original => function(fd,...args) {
  const filename = descriptors.get(fd), result = original.call(this,fd,...args);
  descriptors.delete(fd);
  if (!edited && filename === generated) { edited = true; fs.writeFileSync(generated,'operator edit'); }
  return result;
 });
 assert.throws(() => stage(f), /STAGING_NOT_EMPTY/);
 assert.equal(edited,true);
 assert.equal(fs.readFileSync(generated,'utf8'),'operator edit');
});
test('copies distinct auxiliary files sharing a case-aliased parent directory', t => {
 const f = fixture(t);
 fs.mkdirSync(path.join(f.dir,'SECTIONS'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'SECTIONS/second.md'),'second');
 updateManifest(f,m=>{m.files['SECTIONS/second.md']=textDigest('second');});
 stage(f);
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/sections/guide.md'),'utf8'),'guide');
 assert.equal(fs.readFileSync(path.join(f.output,'connect-chrome/SECTIONS/second.md'),'utf8'),'second');
});
test('preserves non-UTF8 body bytes and frontmatter whitespace during renaming', t => {
 const f = fixture(t);
 const body = Buffer.from([0xff,0x80,0x00,0x0a]);
 const input = Buffer.concat([Buffer.from('---\nname:  open-gstack-browser \t\ndescription: café\n---\n'),body]);
 const expected = Buffer.concat([Buffer.from('---\nname:  connect-chrome \t\ndescription: café\n---\n'),body]);
 fs.writeFileSync(path.join(f.dir,'SKILL.md'),input);
 updateManifest(f,m=>{m.sha256=textDigest(input);});
 stage(f);
 assert.deepEqual(fs.readFileSync(path.join(f.output,'connect-chrome/SKILL.md')),expected);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'SKILL.md')),input);
});
for (const host of ['zcode','dsh']) {
 test(`installs canonical and alias independently with shared registry (${host})`, t => {
  const f = fixture(t,host), before = snapshot(f.staging), target = path.join(f.root,'skills');
  stage(f,{host});
  assert.deepEqual(snapshot(f.staging),before);
  const alias = path.join(f.output,'connect-chrome'), aliasBytes = fs.readFileSync(path.join(alias,'SKILL.md'));
  const manifest = JSON.parse(fs.readFileSync(path.join(alias,'manifest.json'),'utf8'));
  const expected = Buffer.from('---\nname: connect-chrome\ndescription: browser\n---\n\n# /open-gstack-browser\nRead sections/guide.md\n');
  assert.deepEqual(aliasBytes,expected);
  assert.equal(manifest.sha256,textDigest(expected));
  assert.equal(manifest.blob,createHash('sha1').update(Buffer.from(`blob ${expected.length}\0`)).update(expected).digest('hex'));
  assert.equal(manifest.status,'generated-not-host-verified');
  assert.deepEqual(fs.readFileSync(path.join(alias,'sections/guide.md')),Buffer.from('guide'));
  assert.deepEqual(installSkills({staging:f.staging,target}).installed,['open-gstack-browser']);
  assert.deepEqual(installSkills({staging:f.output,target}).installed,['connect-chrome']);
  assert.deepEqual(loadRegistry(target).map(x=>x.name),['connect-chrome','open-gstack-browser']);
  assert.notEqual(fs.statSync(path.join(target,'connect-chrome/SKILL.md')).ino,fs.statSync(path.join(target,'open-gstack-browser/SKILL.md')).ino);
  assert.deepEqual(installSkills({staging:f.staging,target}).skipped,['open-gstack-browser']);
  assert.deepEqual(installSkills({staging:f.output,target}).skipped,['connect-chrome']);
  assert.deepEqual(uninstallSkills({target}).uninstalled,['connect-chrome','open-gstack-browser']);
  assert.deepEqual(loadRegistry(target),[]);
 });
}
