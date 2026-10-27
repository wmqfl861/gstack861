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
// toolRewrites are deliberately absent: DSH shell tool names are unverified —
// TODO add rewrites only with pipeline-level evidence, never invented
// mappings. Tier stays 'experimental' and paths stay the defineHost defaults
// (`.{name}`), so renders land at .dsh/skills/gstack-<skill>/ and are labeled
// 'rendered-experimental', never full/conformance claims.

import { defineHost } from './define-host';

const dsh = defineHost({
  name: 'dsh',
  displayName: 'DeepSeek Harness',
  capabilities: { toolExecution: true, questions: 'prose', planMode: false, delegation: false, browser: false, safetyHooks: 'advisory' },
});

export default dsh;
