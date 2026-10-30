import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPolicy } from './policy.mjs';
import { name as skillsPlugin } from './adapters/dsh-skills.mjs';

const fail = code => { throw new Error(code); };
const validName = value => /^[a-z][a-z0-9-]{0,62}$/.test(value);

// lstat on a leaf follows parent links. Refuse links/junctions at every existing
// directory component before reading inputs or creating the isolated profile.
function plainDirectory(directory, code) {
  for (let current=directory; ; current=path.dirname(current)) {
    const stat=fs.lstatSync(current,{throwIfNoEntry:false});
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(code);
    if (current===path.dirname(current)) return;
  }
}

/** Generate an isolated DSH profile scaffold; does not install packages or launch DSH. */
export function stageDshProfile({ output, profileName='gstack861', policyPath, adapterPath, skillsDir }) {
  if (![output,policyPath,adapterPath,skillsDir].every(x => typeof x==='string' && path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!validName(profileName)) fail('INVALID_PROFILE_NAME');
  output=path.resolve(output); policyPath=path.resolve(policyPath); adapterPath=path.resolve(adapterPath); skillsDir=path.resolve(skillsDir);
  plainDirectory(path.dirname(output),'OUTPUT_PARENT_INVALID');
  if (fs.lstatSync(output,{throwIfNoEntry:false})) fail('OUTPUT_EXISTS');
  const skillsAdapterUrl=new URL('./adapters/dsh-skills.mjs',import.meta.url);
  for (const [file,code] of [[policyPath,'POLICY_FILE_REQUIRED'],[adapterPath,'ADAPTER_FILE_REQUIRED'],
    [fileURLToPath(skillsAdapterUrl),'SKILLS_ADAPTER_FILE_REQUIRED']]) {
    plainDirectory(path.dirname(file),code);
    const st=fs.lstatSync(file,{throwIfNoEntry:false});
    if (!st?.isFile() || st.isSymbolicLink() || st.nlink!==1) fail(code);
  }
  // Use the same compilation, permissions and canonical workspace checks as the
  // actual guard. A syntactically valid JSON policy need not be activatable.
  try { loadPolicy(policyPath); } catch (error) {
    if (error.message==='POLICY_MUST_BE_OUTSIDE_WORKSPACE') throw error;
    fail('POLICY_FILE_INVALID');
  }
  plainDirectory(skillsDir,'SKILLS_DIR_INVALID');

  const plugin='gstack861-guard';
  const adapterUrl=pathToFileURL(adapterPath).href;
  const files = [
    ['package.json', JSON.stringify({name:'gstack861-profile-'+profileName,private:true,version:'0.1.0',dependencies:{[plugin]:'file:./plugins/gstack861-guard',[skillsPlugin]:'file:./plugins/gstack861-skills'},dsh:{profile:{bundles:[]}}},null,2)+'\n'],
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
    ['plugins/gstack861-skills/package.json',JSON.stringify({name:skillsPlugin,version:'0.1.0',type:'module',main:'index.mjs'},null,2)+'\n'],
    ['plugins/gstack861-skills/index.mjs',`export { name, inject, apply } from ${JSON.stringify(skillsAdapterUrl.href)};\n`],
    ['README.md',`# DSH profile: ${profileName}\n\nGenerated scaffold only; not an activated host installation.\n\n1. Review cordis.patch.yml. The required system-prompt → tools → guard dependency chain is included; the skills plugin also requires systemPrompt.\n2. Keep the referenced adapter source trees and their shared policy/install dependencies available. Both local plugin shims import those source modules; this scaffold does not bundle them or execute the supplied guard adapter. Missing imports prevent activation.\n3. Run DSH's own profile dependency installation from this directory.\n4. Launch a disposable profile and inspect activation warnings; exit code 0 alone does not prove activation.\n5. Run the live guard acceptance checklist.\n\nPolicy: ${policyPath}\nSkills: ${skillsDir}\nAdapter: ${adapterPath}\nSkills adapter: ${fileURLToPath(skillsAdapterUrl)}\n\nNo secrets copied; no network, package install, model call or user-home mutation.\n`]
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
