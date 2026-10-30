import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageCommandAliases } from '../src/aliases.mjs';
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
 const g=fixture(t); fs.writeFileSync(path.join(g.dir,'SKILL.md'),'invalid');
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
