# Watch release preparation and verification

The preparation entry point runs zero-Provider transport checks before building and automatically distributes a successful frozen runtime before returning ready:

~~~powershell
npm run release:watch:prepare -- --workers-config artifacts/testing/watch-worker-bootstrap/workers.json
~~~

All workers must already have the same clean source HEAD. Source mismatch is an explicit pre-build failure, never permission to reset or overwrite remote changes. Rust builds keep jobs=2 and the existing caches, AEC3 checks, fresh per-release signing and clean-HEAD checks. This entry point does not authorize or start paid cells.

## Avoid rebuilding a completed batch

If a build completed but a later stage failed, first diagnose the failure. Then explicitly reference its unchanged authority using a new preparation execution:

~~~powershell
npm run release:watch:prepare -- --workers-config artifacts/testing/watch-worker-bootstrap/workers.json --runtime-authority artifacts/testing/watch-mode-strict-runtime/RELEASE_ID/strict-runtime-authority.json
~~~

The authority is reverified; this is not permission to reuse artifacts from another HEAD. Never reuse a failed execution ID. For distribution alone:

~~~powershell
npm run release:watch:distribute -- --workers-config artifacts/testing/watch-worker-bootstrap/workers.json --runtime-authority artifacts/testing/watch-mode-strict-runtime/RELEASE_ID/strict-runtime-authority.json
~~~

Distribution compares every runtime path/size/SHA-256, packs only changed files into one archive per worker, and processes workers concurrently. Unchanged files are recorded as reused and are not uploaded again as runtime payload; control-script transfers and local disk copies still occur. Verified runtime outputs are installed to each worker workspace so the coordinator can consume them without uploading identical binaries again. Tracked source paths cannot be overwritten. All-worker final verification remains mandatory. No private signing key or credential is distributed. Partial failures retain evidence and cannot produce a successful aggregate.

## Verification and reuse

Run Frozen Funnel with the returned authority. Three-worker mapping moves Watch tooling to the bridge worker after its bridge tests; all 14 steps still execute exactly once, serial within each worker. One/two-worker fallbacks retain their prior mapping. Paid cell placement is unchanged.

The quality gate automatically looks for reusable receipts. Only signed schema-v2 receipts matching the exact clean HEAD, runtime authority, command and every required log/worker binding qualify. Rejected, malformed, stale or missing receipts cause normal command execution, not a skipped test. Commands are matched exactly; the strict PowerShell audit is not silently substituted for the non-strict command.

~~~powershell
npm run test:funnel:frozen -- --workers-config artifacts/testing/watch-worker-bootstrap/workers.json --runtime-authority artifacts/testing/watch-mode-strict-runtime/RELEASE_ID/strict-runtime-authority.json
npm run quality:gate:release -- --allow-pending-manual
~~~

The manual option is the user's explicit non-blocking choice for this execution. It preserves pending/degraded status and never overrides automated failures, signatures, hashes, Provider budgets or terminal evidence. Do not interpret it as completed human or installer verification.

## Timing and failure review

Preparation records preflight/build/distribution timings. Distribution records inspect/transfer/verification time, transferred bytes and reused files. Gate steps distinguish current receipt-verification duration from the historical test execution duration; the failure path also writes its summary.

Record engineering work separately in each incident review: observed failure stage and original artifact; classification (product/tool/environment/evidence/unknown); minimal reproduction; measured diagnosis/patch/review/test intervals; invalidated HEAD/runtime/receipts; rebuild needed or not and why. Use unknown when attribution is unproven. Do not include human waiting time in machine execution time, or count historical reused execution as time spent in this invocation.

No paid retry is included in these commands. The failed formal run, missing budget/terminal evidence and malformed historical JSON require separate attribution; optimization tests are not proof that formal Watch release passed.
