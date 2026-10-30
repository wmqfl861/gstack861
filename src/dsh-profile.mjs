import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inside, loadPolicy } from './policy.mjs';
import { inspectPlainPath, assertPlainPathUnchanged, readPlainFile } from './fs-utils.mjs';

const fail = code => { throw new Error(code); };
const validName = value => /^[a-z][a-z0-9-]{0,62}$/.test(value);
const checked = (code, action) => { try { return action(); } catch { fail(code); } };
const inspect = (value, kind, code, allowMissing=false) => checked(code, () => inspectPlainPath(value,{kind,allowMissing}));

// Accept only the expected new suffix after checking the saved existing ancestors.
function createdPath(before, kind, code) {
  return checked(code, () => {
    const ancestors={...before,missing:[]};
    assertPlainPathUnchanged(ancestors);
    const after=inspectPlainPath(before.path,{kind,allowMissing:false});
    assertPlainPathUnchanged(ancestors);
    return after;
  });
}

/** Generate an isolated DSH profile scaffold; does not install packages or launch DSH. */
export function stageDshProfile({ output, profileName='gstack861', policyPath, adapterPath,
  skillsAdapterPath=fileURLToPath(new URL('./adapters/dsh-skills.mjs',import.meta.url)), skillsDir }) {
  if (![output,policyPath,adapterPath,skillsAdapterPath,skillsDir].every(x => typeof x==='string' && path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!validName(profileName)) fail('INVALID_PROFILE_NAME');
  const parent=inspect(path.dirname(output),'directory','OUTPUT_PARENT_INVALID');
  if (checked('OUTPUT_PARENT_INVALID',()=>fs.lstatSync(output,{throwIfNoEntry:false}))) fail('OUTPUT_EXISTS');
  const destination=inspect(output,'directory','OUTPUT_PARENT_INVALID',true);
  checked('OUTPUT_PARENT_INVALID',()=>assertPlainPathUnchanged(parent));
  const policyFile=inspect(policyPath,'file','POLICY_FILE_REQUIRED');
  const guardFile=inspect(adapterPath,'file','ADAPTER_FILE_REQUIRED');
  const skillsFile=inspect(skillsAdapterPath,'file','ADAPTER_FILE_REQUIRED');
  const skillsRoot=inspect(skillsDir,'directory','SKILLS_DIR_INVALID');
  output=destination.path; policyPath=policyFile.path; adapterPath=guardFile.path;
  skillsAdapterPath=skillsFile.path; skillsDir=skillsRoot.path;
  const policyBytes=checked('POLICY_FILE_INVALID',()=>readPlainFile(policyFile));
  const rawPolicy=checked('POLICY_FILE_INVALID',()=>JSON.parse(policyBytes.toString('utf8')));
  const workspace=inspect(rawPolicy?.workspace,'directory','POLICY_FILE_INVALID');
  let policy;
  try {
    assertPlainPathUnchanged(policyFile);
    policy=loadPolicy(policyPath);
    assertPlainPathUnchanged(policyFile);
    assertPlainPathUnchanged(workspace);
    if (!readPlainFile(policyFile).equals(policyBytes)) fail('POLICY_FILE_INVALID');
  } catch (error) {
    fail(error.message==='POLICY_MUST_BE_OUTSIDE_WORKSPACE'?error.message:'POLICY_FILE_INVALID');
  }
  if ([workspace,policyFile,guardFile,skillsFile,skillsRoot].some(source =>
    inside(source.realPath,destination.realPath) || inside(destination.realPath,source.realPath))) fail('OUTPUT_OVERLAP');
  if (policy.workspace!==workspace.realPath) fail('POLICY_FILE_INVALID');
  const inputs=[[policyFile,'POLICY_FILE_REQUIRED'],[workspace,'POLICY_FILE_INVALID'],
    [guardFile,'ADAPTER_FILE_REQUIRED'],[skillsFile,'ADAPTER_FILE_REQUIRED'],[skillsRoot,'SKILLS_DIR_INVALID']];
  const owned=[],expectedContents=new Map();
  const verify=() => {
    for (const [snapshot,code] of inputs) checked(code,()=>assertPlainPathUnchanged(snapshot));
    checked('POLICY_FILE_INVALID',()=>{
      if (!readPlainFile(policyFile).equals(policyBytes)) fail('POLICY_FILE_INVALID');
    });
    for (const snapshot of owned) checked(snapshot.entries.at(-1).kind==='file'?'OUTPUT_CHANGED':'OUTPUT_PARENT_INVALID',()=>{
      assertPlainPathUnchanged(snapshot);
      if (snapshot.entries.at(-1).kind==='file' && !readPlainFile(snapshot).equals(expectedContents.get(snapshot))) fail('OUTPUT_CHANGED');
    });
  };

  const plugin='gstack861-guard';
  const adapterUrl=pathToFileURL(adapterPath).href;
  const skillsAdapterUrl=pathToFileURL(skillsAdapterPath).href;
  const files = [
    ['package.json', JSON.stringify({name:'gstack861-profile-'+profileName,private:true,version:'0.1.0',dependencies:{[plugin]:'file:./plugins/gstack861-guard','gstack861-skills':'file:./plugins/gstack861-skills'},dsh:{profile:{bundles:[]}}},null,2)+'\n'],
    ['cordis.yml','[]\n'],
    ['cordis.patch.yml', [
      '- insert:',
      '    - id: system-prompt',
      "      name: '@deepseek-ai/dsh-system-prompt'",
      '      config:',
      "        personaPrefix: ''",
      '    - id: tools',
      "      name: '@deepseek-ai/dsh-tools'",
      '    - id: gstack861-guard',
      "      name: 'gstack861-guard'",
      '      config:',
      '        policyPath: '+JSON.stringify(policyPath),
      '    - id: gstack861-skills',
      "      name: 'gstack861-skills'",
      '      config:',
      '        skillsDir: '+JSON.stringify(skillsDir),
      ''
    ].join('\n')],
    ['plugins/gstack861-guard/package.json',JSON.stringify({name:plugin,version:'0.1.0',type:'module',main:'index.mjs'},null,2)+'\n'],
    ['plugins/gstack861-guard/index.mjs',`export { name, inject, apply } from ${JSON.stringify(adapterUrl)};\n`],
    ['plugins/gstack861-skills/package.json',JSON.stringify({name:'gstack861-skills',version:'0.1.0',type:'module',main:'index.mjs'},null,2)+'\n'],
    ['plugins/gstack861-skills/index.mjs',`export { name, inject, apply } from ${JSON.stringify(skillsAdapterUrl)};\n`],
    ['README.md',`# DSH profile: ${profileName}\n\nGenerated scaffold only; not an activated host installation.\n\n1. Review cordis.patch.yml. The required system-prompt → tools → guard dependency chain is included.\n2. Run DSH's own profile dependency installation from this directory.\n3. Launch a disposable profile and inspect activation warnings; exit code 0 alone does not prove activation.\n4. Run the live guard acceptance checklist.\n\nPolicy: ${policyPath}\nSkills: ${skillsDir}\nAdapter: ${adapterPath}\n\nNo secrets copied; no network, package install, model call or user-home mutation.\n`]
  ];
  try {
    verify();
    checked('OUTPUT_PARENT_INVALID',()=>assertPlainPathUnchanged(destination));
    fs.mkdirSync(output,{recursive:false,mode:0o700});
    owned.push(createdPath(destination,'directory','OUTPUT_PARENT_INVALID'));
    verify();
    const directories=new Set([output]);
    for (const [name,content] of files) {
      const target=path.join(output,...name.split('/'));
      const parts=name.split('/').slice(0,-1);
      let dir=output;
      for (const part of parts) {
        dir=path.join(dir,part);
        if (directories.has(dir)) continue;
        verify();
        const before=inspect(dir,'directory','OUTPUT_PARENT_INVALID',true);
        if (before.exists) fail('OUTPUT_EXISTS');
        fs.mkdirSync(dir,{recursive:false,mode:0o755});
        owned.push(createdPath(before,'directory','OUTPUT_PARENT_INVALID'));
        directories.add(dir);
        verify();
      }
      verify();
      const before=inspect(target,'file','OUTPUT_CHANGED',true);
      if (before.exists) fail('OUTPUT_EXISTS');
      const fd=fs.openSync(target,'wx',0o644);
      try {
        const snapshot=createdPath(before,'file','OUTPUT_CHANGED');
        const stat=fs.fstatSync(fd,{bigint:true}),entry=snapshot.entries.at(-1);
        if (!stat.isFile() || stat.nlink!==1n || String(stat.dev)!==entry.dev || String(stat.ino)!==entry.ino) fail('OUTPUT_CHANGED');
        owned.push(snapshot);
        expectedContents.set(snapshot,Buffer.alloc(0));
        verify();
        // Until the write returns, only the exclusively created empty state is owned.
        fs.writeFileSync(fd,content);
        expectedContents.set(snapshot,Buffer.from(content));
        verify();
      } finally { fs.closeSync(fd); }
    }
    verify();
  } catch (error) {
    // Cleanup requires recorded identity and exact proven contents. Nonrecursive
    // removal leaves changed files, partial writes and ambiguous paths untouched.
    for (const snapshot of owned.reverse()) {
      try {
        assertPlainPathUnchanged(snapshot);
        if (snapshot.entries.at(-1).kind==='file') {
          if (!readPlainFile(snapshot).equals(expectedContents.get(snapshot))) continue;
          fs.unlinkSync(snapshot.path);
        } else fs.rmdirSync(snapshot.path);
      } catch { /* Preserve foreign entries and the original failure. */ }
    }
    throw error;
  }
  return {schemaVersion:1,host:'dsh',profileName,output,files:files.map(x=>x[0]),status:'scaffolded-not-host-verified',
    requiresOperatorSteps:['review-profile','install-profile-dependencies','launch-disposable-profile','verify-plugin-activation','run-live-guard-acceptance']};
}
