import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, canonical } from './json.mjs';

const fail = code => { throw new Error(code); };
const CONFIG_DIR = '.zcode';
const CONFIG_FILE = 'config.json';
const LOCK = '.gstack861-zcode-config.lock';
const marker = 'gstack861:';

function readExisting(file) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return {config:{},exists:false};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>1024*1024) fail('ZCODE_CONFIG_UNSAFE');
  let config;
  try { config=JSON.parse(fs.readFileSync(file,'utf8')); } catch { fail('ZCODE_CONFIG_INVALID'); }
  if (!object(config)) fail('ZCODE_CONFIG_INVALID');
  return {config,exists:true};
}
function hookIdentity(entry) {
  return canonical({matcher:entry.matcher,hooks:entry.hooks});
}
function ownedHook(nodePath,cliPath,policyPath) {
  return {matcher:'.*',hooks:[{type:'process',command:nodePath,args:[cliPath,'hook','zcode','--policy',policyPath],timeoutMs:10000}]};
}
function merge(config, addition) {
  const result=structuredClone(config);
  if (!object(result.hooks ?? {})) fail('ZCODE_HOOKS_INVALID');
  result.hooks ??={};
  if (result.hooks.enabled===false) fail('ZCODE_HOOKS_DISABLED');
  result.hooks.enabled=true;
  result.hooks.events ??={};
  if (!object(result.hooks.events)) fail('ZCODE_EVENTS_INVALID');
  for (const [event,entries] of Object.entries(addition.hooks.events)) {
    if (!Array.isArray(entries)) fail('ZCODE_ADDITION_INVALID');
    const current=result.hooks.events[event] ?? [];
    if (!Array.isArray(current)) fail('ZCODE_EVENTS_INVALID');
    const seen=new Set(current.map(hookIdentity));
    for (const entry of entries) {
      const id=hookIdentity(entry);
      if (!seen.has(id)) { current.push(entry); seen.add(id); }
    }
    result.hooks.events[event]=current;
  }
  return result;
}

/** Pure merge plan. Existing unrelated settings and hook entries are retained. */
export function planZcodeConfig({workspace,nodePath,cliPath,policyPath,existingConfig}) {
  if (![workspace,nodePath,cliPath,policyPath].every(x=>typeof x==='string'&&path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  const root=path.resolve(workspace);
  const rootStat=fs.lstatSync(root,{throwIfNoEntry:false});
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail('WORKSPACE_INVALID');
  const zdir=path.join(root,CONFIG_DIR), ds=fs.lstatSync(zdir,{throwIfNoEntry:false});
  if (ds && (!ds.isDirectory() || ds.isSymbolicLink())) fail('ZCODE_CONFIG_DIR_UNSAFE');
  const configPath=path.join(zdir,CONFIG_FILE);
  let config;
  if (existingConfig!==undefined) {
    if (!object(existingConfig)) fail('ZCODE_CONFIG_INVALID');
    config=existingConfig;
  } else config=readExisting(configPath).config;
  const addition={hooks:{enabled:true,events:{PreToolUse:[ownedHook(nodePath,cliPath,policyPath)]}}};
  const next=merge(config,addition);
  return Object.freeze({workspace:root,configPath,existed:existingConfig!==undefined || fs.existsSync(configPath),
    before:canonical(config),after:canonical(next),config:next,changed:canonical(config)!==canonical(next)});
}

/** Atomic, explicit apply. Never overwrites a symlink, hardlink, invalid config or active lock. */
export function applyZcodeConfigPlan(plan) {
  if (!plan || !path.isAbsolute(plan.configPath) || !path.isAbsolute(plan.workspace)) fail('INVALID_PLAN');
  const lock=path.join(path.dirname(plan.configPath),LOCK);
  try { fs.mkdirSync(lock,{mode:0o700}); } catch { fail('ZCODE_CONFIG_BUSY'); }
  try {
    const zdir=path.dirname(plan.configPath);
    const ds=fs.lstatSync(zdir,{throwIfNoEntry:false});
    if (ds && (!ds.isDirectory()||ds.isSymbolicLink())) fail('ZCODE_CONFIG_DIR_UNSAFE');
    if (!ds) fs.mkdirSync(zdir,{mode:0o755});
    const current=readExisting(plan.configPath);
    if (canonical(current.config)!==plan.before) fail('ZCODE_CONFIG_CHANGED');
    if (!plan.changed) return {changed:false,path:plan.configPath};
    const temp=path.join(zdir,CONFIG_FILE+'.'+randomUUID()+'.tmp');
    try {
      fs.writeFileSync(temp,JSON.stringify(plan.config,null,2)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(temp,plan.configPath);
    } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
    return {changed:true,path:plan.configPath};
  } finally { fs.rmdirSync(lock); }
}

/** Remove only the exact gstack861 hook bound to the supplied paths. */
export function planZcodeUninstall({workspace,nodePath,cliPath,policyPath}) {
  if (![workspace,nodePath,cliPath,policyPath].every(x=>typeof x==='string'&&path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  const root=path.resolve(workspace), zdir=path.join(root,CONFIG_DIR), file=path.join(zdir,CONFIG_FILE);
  const {config}=readExisting(file);
  const result=structuredClone(config);
  const expected=hookIdentity(ownedHook(nodePath,cliPath,policyPath));
  const events=result.hooks?.events;
  if (!object(events) || !Array.isArray(events.PreToolUse)) return Object.freeze({workspace:root,configPath:file,before:canonical(config),after:canonical(config),config,changed:false});
  const filtered=events.PreToolUse.filter(entry=>hookIdentity(entry)!==expected);
  result.hooks.events.PreToolUse=filtered;
  if (!filtered.length) delete result.hooks.events.PreToolUse;
  if (!Object.keys(result.hooks.events).length) delete result.hooks.events;
  if (result.hooks && !Object.keys(result.hooks).length) delete result.hooks;
  return Object.freeze({workspace:root,configPath:file,before:canonical(config),after:canonical(result),config:result,changed:canonical(config)!==canonical(result)});
}
