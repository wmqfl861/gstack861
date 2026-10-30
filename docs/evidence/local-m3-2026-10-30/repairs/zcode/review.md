# Independent ZCode Task4 result review — 2026-10-31

Spec verdict: substantially implemented; incomplete transaction failure handling. Quality verdict: REQUEST CHANGES for two Important findings.

R3 src/zcode-profile.mjs makePlan originally at :117 encodes merged config without output size bound; record at :33 rejects >1MiB. Input JSON.stringify({padding:'x'.repeat(1024*1024-100)})1048490 bytes installed successfully, output1049344 bytes + committed receipt; subsequent install/uninstall planners both ZCODE_CONFIG_UNSAFE. Validate serialized desired config against same input bound during planning before any mutation; boundary refusal/roundtrip regression.

R4 replaceRecord originally at :241 updates state only after readWritten. One EACCES from fd read after final committed receipt rename -> stale in-memory pending identity causes rollback refusal and RECOVERY_REQUIRED, but disk receipt committed and later planners accept (install no-op, uninstall changed). Retain successful mutation identity separately before fallible readback; exact rollback or accurate committed reporting/pending barrier required. Existing finalize tests fail before rename; add post-rename readback case.

Reviewed72/72 log and source/test/helper/log fingerprints match. Narrow ordinary config replacement/finalization and foreign lock replacement controls preserve operator bytes/pending intent. Foreign metadata and malformed-known config behavior checked. CLI integration binds target policy and permits uninstall after broken policy. No broad suite rerun, source/home/model/network/host changes. ZC-07 remains explicitly OPEN; does not excuse either finding.
