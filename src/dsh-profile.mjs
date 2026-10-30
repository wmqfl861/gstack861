import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => { throw new Error(code); };
const validName = value => /^[a-z][a-z0-9-]{0,62}$/.test(value);
const inside = (a,b) => { const r=path.relative(a,b); return r==='' || (!r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r)); };

/** Generate an isolated DSH profile scaffold; does not install packages or launch DSH. */
export function stageDshProfile({ output, profileName='gstack861', policyPath, adapterPath, skillsDir }) {
  if (![output,policyPath,adapterPath,skillsDir].every(x => typeof x==='string' && path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!validName(profileName)) fail('INVALID_PROFILE_NAME');
  output=path.resolve(output); policyPath=path.resolve(policyPath); adapterPath=path.resolve(adapterPath); skillsDir=path.resolve(skillsDir);
  const parent=fs.lstatSync(path.dirname(output),{throwIfNoEntry:false});
  if (!parent?.isDirectory() || parent.isSymbolicLink()) fail('OUTPUT_PARENT_INVALID');
  if (fs.lstatSync(output,{throwIfNoEntry:false})) fail('OUTPUT_EXISTS');
  for (const [file,code] of [[policyPath,'POLICY_FILE_REQUIRED'],[adapterPath,'ADAPTER_FILE_REQUIRED']]) {
    const st=fs.lstatSync(file,{throwIfNoEntry:false});
    if (!st?.isFile() || st.isSymbolicLink() || st.nlink!==1) fail(code);
  }
  let policy;
  try { policy=JSON.parse(fs.readFileSync(policyPath,'utf8')); } catch { fail('POLICY_FILE_INVALID'); }
  if (!policy || policy.schemaVersion!==1 || !path.isAbsolute(policy.workspace)) fail('POLICY_FILE_INVALID');
  if (inside(policy.workspace,policyPath)) fail('POLICY_MUST_BE_OUTSIDE_WORKSPACE');
  const skills=fs.lstatSync(skillsDir,{throwIfNoEntry:false});
  if (!skills?.isDirectory() || skills.isSymbolicLink()) fail('SKILLS_DIR_INVALID');

  const plugin='gstack861-guard';
  const adapterUrl=pathToFileURL(adapterPath).href;
  const files = [
    ['package.json', JSON.stringify({name:'gstack861-profile-'+profileName,private:true,version:'0.1.0',dependencies:{[plugin]:'file:./plugins/gstack861-guard'},dsh:{profile:{bundles:[]}}},null,2)+'\n'],
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
    ['README.md',`# DSH profile: ${profileName}\n\nGenerated scaffold only; not an activated host installation.\n\n1. Review cordis.patch.yml. The required system-prompt → tools → guard dependency chain is included.\n2. Run DSH's own profile dependency installation from this directory.\n3. Launch a disposable profile and inspect activation warnings; exit code 0 alone does not prove activation.\n4. Run the live guard acceptance checklist.\n\nPolicy: ${policyPath}\nSkills: ${skillsDir}\nAdapter: ${adapterPath}\n\nNo secrets copied; no network, package install, model call or user-home mutation.\n`]
  ];
  fs.mkdirSync(output,{recursive:false,mode:0o700});
  try {
    for (const [name,content] of files) {
      const target=path.join(output,...name.split('/'));
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
      fs.writeFileSync(target,content,{flag:'wx',mode:0o644});
    }
  } catch (error) { fs.rmSync(output,{recursive:true,force:true}); throw error; }
  return {schemaVersion:1,host:'dsh',profileName,output,files:files.map(x=>x[0]),status:'scaffolded-not-host-verified',
    requiresOperatorSteps:['review-profile','install-profile-dependencies','launch-disposable-profile','verify-plugin-activation','run-live-guard-acceptance']};
}
