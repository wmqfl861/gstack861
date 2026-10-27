// DeepSeek Harness (dsh) host overlay for gstack861 (CI render only).
//
// Registered by scripts/render-upstream.mjs into a scratch `git archive` copy
// of the pinned upstream: copied to <copy>/hosts/dsh.ts (its `./define-host`
// import resolves there) and spliced into the ALL_HOST_CONFIGS registry
// literal — derived maps/types evaluate from that literal at module load.
//
// Evidence-backed fields only (upstream.lock.json: dsh commit 22ddee3,
// source-inspected): DSH executes tools, so toolExecution: true, but there is
// no structured-question evidence, hence questions: 'prose'. planMode and
// delegation are not certified and stay false; no browser tooling is claimed.
//
// toolRewrites are evidence-backed per entry (batch 12): the real DSH file
// tool named `write` with parameter `file_path` was observed in a live tool
// call (docs/verification-2026-10-27-dsh-pipeline.md, 2026-10-27), and the
// sibling lowercase tools `read` / `edit` (same `file_path` parameter) are
// pinned-commit source-inspected (docs/reviews/2026-10-27-claude-review.md
// §二.10, DSH 22ddee3 packages/fs/tool-fs/src/{read,write,edit}.ts). The six
// entries below are copied VERBATIM — keys and values, upstream order — from
// the Read/Write/Edit subset of EXEC_STYLE_TOOL_REWRITES (upstream
// hosts/define-host.ts @ 5755601): phrase-level replaceAll, never bare words,
// never a spread of the constant. The constant's remaining entries stay out
// deliberately: Agent/Grep/Glob have no DSH evidence, and Bash→exec is absent
// because no DSH pipeline observation maps the Bash prose to an exec tool and
// the render templates have zero Bash-phrase hits (an unverifiable diff).
//
// Tier stays 'experimental' and paths stay the defineHost defaults
// (`.{name}`), so renders land at .dsh/skills/gstack-<skill>/ and are labeled
// 'rendered-experimental', never full/conformance claims.

import { defineHost } from './define-host';

const dsh = defineHost({
  name: 'dsh',
  displayName: 'DeepSeek Harness',
  capabilities: { toolExecution: true, questions: 'prose', planMode: false, delegation: false, browser: false, safetyHooks: 'advisory' },
  // Read/Write/Edit subset of EXEC_STYLE_TOOL_REWRITES, byte-for-byte: 'use
  // the X tool' entries run before 'the X tool' so a phrase is always
  // rewritten at its longest match first (upstream replaceAll order).
  toolRewrites: {
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'the Read tool': 'the read tool',
    'the Write tool': 'the write tool',
    'the Edit tool': 'the edit tool',
  },
});

export default dsh;
