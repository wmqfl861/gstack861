// ZCode host overlay for gstack861 (CI render only).
//
// Registered by scripts/render-upstream.mjs into a scratch `git archive` copy
// of the pinned upstream: this file is copied to <copy>/hosts/zcode.ts (its
// `./define-host` import resolves there) and hosts/index.ts splices it into
// the ALL_HOST_CONFIGS registry literal — HOST_CONFIG_MAP/Host/ALL_HOST_NAMES
// all derive from that literal at module load, so this file must be an import
// + registry entry, never a runtime push.
//
// Evidence-backed fields only (upstream.lock.json: zcode commit 3c5b227,
// source-inspected): ZCode exposes a native AskUserQuestion tool, hence
// questions: 'native'. planMode and delegation are not certified and stay
// false; no browser tooling is claimed. toolRewrites are deliberately absent:
// no verified ZCode tool-name vocabulary exists yet — TODO add rewrites only
// with pipeline-level evidence, never invented mappings. Tier stays
// 'experimental' and paths stay the defineHost defaults (`.{name}`), so
// renders land at .zcode/skills/gstack-<skill>/ and are labeled
// 'rendered-experimental', never full/conformance claims.

import { defineHost } from './define-host';

const zcode = defineHost({
  name: 'zcode',
  displayName: 'ZCode',
  capabilities: { toolExecution: true, questions: 'native', planMode: false, delegation: false, browser: false, safetyHooks: 'advisory' },
});

export default zcode;
