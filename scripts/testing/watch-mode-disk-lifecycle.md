# Watch disk lifecycle

## Automatic barriers and lightweight history

Release preparation checks measured C/E free bytes at startup and immediately
before distribution. Production checks at startup and immediately before paid
preflight. Both run a collect-all four-host check in `finally`, including failed
runs. An unavailable measurement or a volume below **3 GiB** fails the barrier;
estimated future savings never authorize a build, transfer or Provider call.
The startup barrier measures remote volumes through a fixed Node built-in
`fs.statfsSync` command, without importing a worker checkout. This is necessary
before source synchronization: an old lifecycle CLI must neither block a valid
measurement nor regain historical deletion authority. The coordinator validates
both returned volumes and the measured byte threshold independently.

Both terminal paths also archive a bounded, explicitly **non-release** diagnostic
summary on each configured worker. Per-worker history lives at
`<guestExecutionRoot>/artifacts/retained-reports/<workerId>`; independent audit
receipts live at `<workspaceRoot>/artifacts/testing/watch-history-audit`.
The summary records success/failure even when a prior stage failed. Remote
archives verify the implementation closure before import and receive JSON over
stdin, not executable command text. One host failing does not prevent attempts
on the other hosts. Archiving failure is not a successful lifecycle result.

`watch-mode-history-reports.mjs` rotates its own sealed `report.json` /
`manifest.json` entries, keeping the newest **30 per worker** by terminal time,
not mutable directory mtime. It does not claim arbitrary existing folders.
Pinned, partial, changed or unknown entries are retained and reported separately;
unknown state is not a successful cleanup. The report's outcome and the archive
operation's verdict are different fields. These summaries cannot replace signed
PCM, final-cue, renderer ACK, strict evidence or release-gate receipts.

## Existing large histories: explicit maintenance only

`watch-mode-typed-history.mjs` is the conservative maintenance tool for existing
mixed execution/runtime/isolation roots. The old untyped generic FIFO deletion
is intentionally forbidden. Its dry run produces an immutable plan; apply also
requires explicit quiescence and complete external-reference scope, and writes
separate intent/outcome receipts outside every target and authority root.

Execution deletion requires terminal/cleanup identity plus a byte-identical
collected copy that survives deletion. Cache retirement requires a complete
sealed file inventory, exact file hashes, no retained dependencies, current and
investigation pins, and retention of the newest 30 sealed cache generations per
worker. Both apply paths revalidate before removal. A history directory name,
old timestamp, absent process in an earlier snapshot or a passed report alone
is not deletion authority.

The reference scanner distinguishes registered per-cell observations using the
existing evidence artifact contract and the digest-bound owning execution plan.
The run collection, launch requests and unknown layouts remain strict inputs.
Corrupt historical observations remain unchanged; ignoring them as runtime
selection inputs does **not** forgive their corruption in strict validation.

Consequently, the automatic 30-entry summary policy is **not a claim that every
legacy mixed root already contains at most 30 directories**, nor that all large
PCM has been discarded. Protected/unproven legacy entries can exceed the limit.
Existing signed investigation evidence must not be trimmed merely to meet a
directory count. Legacy repair/retirement remains separately auditable work.

## Validation

- `npm run test:watch-mode-coordinator-tooling` includes disk, typed-history,
  lightweight report FIFO and quiescence regressions.
- `npm run test:watch-mode-report`, `npm run test:powershell-tooling`, and
  `npm run test:contracts` validate the affected orchestration contracts.
- No lifecycle unit test authorizes a Provider call or a release publication.
