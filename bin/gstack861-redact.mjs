#!/usr/bin/env node
// gstack861-redact — scan-path CLI over src/redact-engine.mjs (batch 22, Lane C).
//
// Upstream lineage: gstack bin/gstack-redact @ upstream.lock.json commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9 (341 lines). That file is the
// semantics source of truth: argv parsing, flag semantics, stdin/file input
// with the 16 MiB ceiling, the JSON/human report shapes, auto-redact mode and
// the four-state exit codes below are ported from it.
//
// Divergence ledger (bun → node; everything else verbatim):
//  1. Shebang `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` →
//     `#!/usr/bin/env node`. Bun's --no-env-file/--config flags isolate the
//     runtime from ambient config files; node has no equivalent here. The
//     engine's by-value scan of credential-named environment variables sees
//     the inherited environment under both runtimes.
//  2. The install-prepush-hook / uninstall-prepush-hook subcommands are NOT
//     in this port: the 790-line pre-push guardrail is its own later batch
//     (batch 22 scope audit, docs/OFFLINE-COMPLETE.md §二), so their bodies
//     and the mkdirpSync/spawnSync/path imports they alone consumed are
//     dropped rather than carried dead. Usage says so. The unknown-subcommand
//     guard is unaffected: `install-prepush-hooks` (the plural typo upstream
//     fixed this class of bug for) still lands on the generic rejection in
//     main() and exits 1 — a guard that no-ops must never exit 0.
//  3. `../lib/redact-engine` → `../src/redact-engine.mjs`; TS type-only
//     imports (RepoVisibility, ScanOptions, Finding) dropped with the types.
//  4. Program name in this CLI's OWN strings: gstack-redact → gstack861-redact
//     (doc header, usage banner, stderr diagnostics, human-report header,
//     auto-redact skipped notice). Wording is otherwise byte-identical; the
//     engine emits no strings of its own on this path.
/**
 * gstack861-redact — scan text for secrets/PII/legal content via the shared engine.
 *
 * Skill-facing CLI over src/redact-engine.mjs. Reads from stdin (default) or
 * --from-file, scans, and prints findings as JSON (--json) or a human table.
 *
 * Exit codes (consumed by skill bash to gate dispatch/file/edit/commit):
 *   0  clean (no HIGH, no MEDIUM)
 *   1  usage error (empty --from-file, bad --max-bytes, unknown subcommand,
 *      TTY with nothing piped in) — never a findings verdict
 *   2  MEDIUM present (no HIGH) — skill runs the per-finding AskUserQuestion
 *   3  HIGH present            — skill blocks (an input over the CLI's 16 MiB
 *                                ceiling is rejected with 3 before the engine)
 *
 * WARN findings (tool-fence-degraded credentials) never change the exit code.
 *
 * Flags:
 *   --json                       Emit JSON {findings, counts, repoVisibility, oversize}
 *   --repo-visibility V          public | private | unknown (default unknown=public-strict wording)
 *   --from-file PATH             Read input from PATH instead of stdin
 *   --allowlist PATH             Newline-delimited exact spans to suppress
 *   --self-email EMAIL           Suppress this email (the invoking user's own)
 *   --repo-public-emails PATH    Newline-delimited repo-public emails to suppress
 *   --auto-redact IDS            Comma-separated finding ids to auto-redact;
 *                                prints the redacted body to stdout + diff to stderr.
 *   --max-bytes N                Override the fail-closed size cap (default 1 MiB).
 *
 * Security note: this is a GUARDRAIL, not airtight enforcement. A determined
 * user can always bypass it (direct gh/git). It catches accidents.
 */
import * as fs from "node:fs";
import { scan, applyRedactions, exitCodeFor } from "../src/redact-engine.mjs";

const MAX_STDIN_BYTES = 16 * 1024 * 1024; // hard ceiling before the engine cap

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

function readInput() {
  const file = arg("--from-file");
  // An explicitly-passed EMPTY path must error, not silently fall through to
  // stdin: skill blocks pass "$FILE" from a $(mktemp) that may have failed,
  // and the stdin fallback then scans nothing while looking green (#2679).
  if (file === "") {
    process.stderr.write(
      "gstack861-redact: --from-file requires a non-empty path (did mktemp fail?)\n",
    );
    process.exit(1);
  }
  if (file) {
    const st = fs.statSync(file);
    if (st.size > MAX_STDIN_BYTES) {
      // Don't even read it — fail closed at the CLI boundary.
      process.stderr.write(`gstack861-redact: input file too large (${st.size} bytes)\n`);
      process.exit(3);
    }
    return fs.readFileSync(file, "utf8");
  }
  // stdin
  const chunks = [];
  let total = 0;
  const fd = 0;
  const buf = Buffer.alloc(65536);
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_STDIN_BYTES) {
      process.stderr.write("gstack861-redact: stdin too large\n");
      process.exit(3);
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readLines(path) {
  if (!path || !fs.existsSync(path)) return undefined;
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildOpts() {
  const vis = arg("--repo-visibility") || "unknown";
  const maxBytes = arg("--max-bytes");
  // #1824: validate the RAW string, not the parse result. parseInt("123abc")
  // is 123 and parseInt("foo") is NaN — both silently corrupt the fail-closed
  // oversize guard. Require a clean positive integer or reject before scanning.
  let maxBytesOpt;
  if (maxBytes !== undefined) {
    if (!/^\d+$/.test(maxBytes) || Number(maxBytes) <= 0) {
      process.stderr.write(
        `gstack861-redact: --max-bytes must be a positive integer (got "${maxBytes}")\n`,
      );
      process.exit(1);
    }
    maxBytesOpt = Number(maxBytes);
  }
  return {
    repoVisibility: ["public", "private", "unknown"].includes(vis) ? vis : "unknown",
    allowlist: readLines(arg("--allowlist")),
    selfEmail: arg("--self-email"),
    repoPublicEmails: readLines(arg("--repo-public-emails")),
    ...(maxBytesOpt !== undefined ? { maxBytes: maxBytesOpt } : {}),
    // The scanned file's path lets patterns tell TS/JSX source syntax from a literal (#3048).
    ...(arg("--from-file") ? { sourcePath: arg("--from-file") } : {}),
  };
}

function humanTable(findings) {
  if (!findings.length) return "  (no findings)";
  const rows = findings.map(
    (f) =>
      `  ${f.severity.padEnd(6)} ${f.id.padEnd(24)} ${String(f.line).padStart(4)}:${String(
        f.col,
      ).padEnd(3)} ${f.preview}`,
  );
  return rows.join("\n");
}

/**
 * Usage. Exits 0 when asked for (--help), 1 when the invocation was wrong.
 *
 * Deliberately NOT 2 or 3: those mean MEDIUM and HIGH findings, and callers
 * gate dispatch on them (see the exit-code table at the top). A usage error
 * that exited 2 would be read as "medium findings — prompt the user".
 */
function printUsage(code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(
    "gstack861-redact — scan text for secrets/PII/legal content.\n" +
      "\n" +
      "Reads the text to scan from STDIN, or from --from-file PATH. It is a\n" +
      "filter: with nothing piped in it has nothing to scan.\n" +
      "\n" +
      "  git diff | gstack861-redact --repo-visibility private\n" +
      "  gstack861-redact --from-file notes.md --json\n" +
      "\n" +
      "Subcommands: none — install-prepush-hook / uninstall-prepush-hook are\n" +
      "deferred to the pre-push batch in this port; the scan path is the whole\n" +
      "CLI here.\n" +
      "\n" +
      "Flags: --json --repo-visibility V --from-file PATH --allowlist PATH\n" +
      "       --self-email EMAIL --repo-public-emails PATH --auto-redact IDS\n" +
      "       --max-bytes N\n" +
      "\n" +
      "Exit: 0 clean · 1 usage error · 2 MEDIUM present · 3 HIGH present\n",
  );
  process.exit(code);
}

function main() {
  const sub = process.argv[2];
  if (sub === "--help" || sub === "-h" || sub === "help") return printUsage(0);

  // An unrecognized POSITIONAL is a typo, not input. This used to fall through
  // to the stdin scan, which on empty stdin prints "(no findings)" and exits 0
  // — so `install-prepush-hooks` (plural) installed nothing and still looked
  // like success, leaving the credential guard absent while the operator
  // believed it was armed. A guard that no-ops must never exit 0. (In this
  // port there are no real subcommands to typo — ledger 2 — but the guard
  // stays: any bare word is still a mistake worth exit 1.)
  //
  // "scan" is exempt: the human output header reads "gstack861-redact scan —
  // repo …", so people reasonably type it. It stays an alias for the default.
  // Flags start with "-" and are parsed further down, so only bare words land
  // here.
  if (sub !== undefined && sub !== "scan" && !sub.startsWith("-")) {
    process.stderr.write(`gstack861-redact: unknown subcommand "${sub}"\n\n`);
    return printUsage(1);
  }

  const opts = buildOpts();

  // Nothing piped in and no --from-file: readInput() below blocks on
  // readSync(fd 0) until EOF, which on an interactive terminal never comes.
  // That prints nothing at all and is indistinguishable from a crash or a
  // slow scan. Show usage instead of hanging silently.
  if (!arg("--from-file") && process.stdin.isTTY) return printUsage(1);

  const input = readInput();

  // Auto-redact mode: print redacted body to stdout, diff to stderr, exit 0.
  const autoIds = arg("--auto-redact");
  if (autoIds) {
    const { body, diff, skipped } = applyRedactions(input, autoIds.split(","), opts);
    process.stdout.write(body);
    if (diff) process.stderr.write(diff + "\n");
    if (skipped.length) {
      process.stderr.write(
        `\ngstack861-redact: ${skipped.length} finding(s) could not be auto-redacted (structural) — edit manually:\n` +
          skipped.map((f) => `  ${f.id} @ ${f.line}:${f.col}`).join("\n") +
          "\n",
      );
    }
    // Same truncation class as the report path below: the redacted BODY can
    // be arbitrarily large; let stdout drain instead of process.exit(0).
    return;
  }

  const result = scan(input, opts);
  const code = exitCodeFor(result);

  if (flag("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const vis = result.repoVisibility.toUpperCase();
    process.stdout.write(`gstack861-redact scan — repo ${vis}\n`);
    if (result.oversize) {
      process.stdout.write("  BLOCKED — input too large to scan safely (fail-closed)\n");
    } else {
      process.stdout.write(humanTable(result.findings) + "\n");
      const { HIGH, MEDIUM, LOW, WARN } = result.counts;
      process.stdout.write(`  HIGH=${HIGH} MEDIUM=${MEDIUM} LOW=${LOW} WARN=${WARN}\n`);
    }
  }
  // process.exit() discards stdout still buffered in the pipe: a report past
  // ~145 KB read by a slow consumer (node's gate-secret-scan.mjs collector)
  // arrived truncated, JSON.parse failed, and the CI quality gate failed
  // CLOSED on a clean scan. Set the exit code and let the runtime drain
  // stdout instead — same contract, no truncation.
  process.exitCode = code;
}

main();
