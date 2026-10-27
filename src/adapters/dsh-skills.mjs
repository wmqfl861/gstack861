import fs from 'node:fs';
import path from 'node:path';
import { object, textDigest } from '../json.mjs';
import { loadRegistry } from '../install.mjs';

export const name = 'gstack861-skills';
export const inject = ['systemPrompt'];

const REGISTRY = '.gstack861-registry.json'; // on-disk contract of the install chain (host-loading.md)
const fail = code => { throw new Error(code); };
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The first `description:` line of a SKILL.md frontmatter block; '' when the block or the line is absent. */
function frontmatterDescription(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return '';
  const end = lines.indexOf('---', 1);
  if (end === -1) return '';
  for (const line of lines.slice(1, end)) {
    const match = /^description:[ \t]*(.*)$/.exec(line);
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Native Cordis plugin exposing install-chain rendered skills to a DSH session as
 * one system-prompt section: a fail-closed index the model expands itself by
 * reading each SKILL.md with its file tools (full texts would blow the prompt).
 * The registry is the trust anchor — every registered SKILL.md must still hash
 * to its recorded sha256 or the plugin refuses activation; the host downgrades
 * that to a warning, and a mis-indexed session is worse than none. Single
 * inject (systemPrompt.section is its additive API), interpolate:false so no
 * {{var}} in a skill description can break assembly, order 3050 between the
 * host's TOOL_COMPUTER_USE (3000) and MCP_SERVERS (3100) sections.
 */
export function apply(ctx, config) {
  if (typeof ctx?.systemPrompt?.section !== 'function') fail('DSH_SYSTEM_PROMPT_SECTION_REQUIRED');
  const skillsDir = config?.skillsDir;
  if (typeof skillsDir !== 'string') fail('SKILLS_DIR_REQUIRED');
  const dirStat = fs.lstatSync(skillsDir, { throwIfNoEntry: false });
  if (!path.isAbsolute(skillsDir) || !dirStat?.isDirectory()) fail('INVALID_SKILLS_DIR');
  const registryStat = fs.lstatSync(path.join(skillsDir, REGISTRY), { throwIfNoEntry: false });
  if (!registryStat) fail('REGISTRY_MISSING');
  if (!registryStat.isFile()) fail('REGISTRY_INVALID'); // shadowed, not absent
  const records = loadRegistry(skillsDir); // throws REGISTRY_INVALID on corrupt content
  const lines = [];
  for (const record of [...records].sort(byName)) {
    const dir = path.join(skillsDir, record.name);
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail('SKILL_INVALID');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { manifest = null; }
    if (!object(manifest) || manifest.name !== record.name) fail('SKILL_INVALID');
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.lstatSync(skillFile, { throwIfNoEntry: false })?.isFile()) fail('SKILL_INVALID');
    const bytes = fs.readFileSync(skillFile); // digest the raw Buffer, byte-exact like the install chain
    if (textDigest(bytes) !== record.sha256) fail('SKILL_TAMPERED');
    lines.push(`- ${record.name} | ${frontmatterDescription(bytes.toString('utf8'))} | ${skillFile}`);
  }
  const index = `${records.length} gstack861 skills installed, one per line: skill name | one-line description | `
    + `absolute path of its SKILL.md. Descriptions are summaries only; when a skill is relevant, `
    + `read the full SKILL.md at its path with your file tools before following it.\n${lines.join('\n')}\n`;
  return ctx.systemPrompt.section({ name: 'gstack861:skills', order: 3050, text: index, interpolate: false });
}
