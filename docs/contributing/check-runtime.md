# Check runtime

The runtime changes preserve test cases, fixture sizes, assertions, production
retry behaviour and storage isolation. The implementation starts from merged
`main` at `14b455e48e5f`.

## Historical evidence

Before this change, the [GitHub `check` job][source-run] took 30 minutes 35
seconds. `pnpm check` itself took 30 minutes 15 seconds; tests accounted for
approximately 86% of that time:

| Work                     | Duration                                  |
| ------------------------ | ----------------------------------------- |
| General end-to-end tests | 12m17s                                    |
| Remote-store tests       | 1m29s                                     |
| Workspace tests          | 10m25s, including 10m14s for server tests |
| Action and script tests  | 1m49s                                     |
| Lint and formatting      | 2m45s                                     |
| Types                    | 1m02s                                     |
| Other checks             | 28s                                       |

[source-run]:
  https://github.com/underwhelmingperformance/cupboard/actions/runs/37310137698/job/111763243542

Both hosted general end-to-end invocations skipped 28 tests because the runner
had no daemon. Five cases also treated the host's Node executable as a Nix store
path, which required Node to be installed under `/nix/store`.

Before the clock change, the four local native build cases took 324.84s. The two
failed-build cases each waited through 15, 30, 45 and 60 seconds of production
backoff. Those waits contributed 300 seconds in total. An earlier local server
run passed 2,598 tests in 301.97s. The hosted and local timings used different
runners and different test coverage.

## Controlled time and isolation

Failed native build cases compile a test-only Worker beside the shipped main and
post bundles. The tests advance `ManualClock` through exactly 150,000ms per case
and retain five actual Nix attempts, receipts, dependency selection, GC
protection and cleanup. Successful cases continue to run the shipped Worker. The
focused failed cases took 1.133s and 0.908s after the change.

Attachment tests use scoped fake timers. Concurrency tests use start and release
acknowledgements. Inherited-output tests release descendant output through a
control socket after parent exit. Signing rotation fences automatic alarms,
invokes the production alarm handler explicitly, and checks backfill completion
within 32 passes. The C relay timeout test injects only timeout delivery and
asserts the unchanged 3,000ms production timeout.

After each production verification pass, the commit fixture reads the upload's
stored verdict from its tenant's Durable Object. Only pending or committing
uploads request another pass. The fixture still awaits the actual WebSocket
frame, retains the 100-pass limit, and reports a stalled verdict through its
existing phase deadline.

Readiness checks still wait for real files and sockets, and fail if their
deadlines expire. The cross-DO quota race retains `scheduler.wait(0)` to give
workerd an event-loop turn: removing that turn starved the second Worker despite
awaited R2 operations. R2 pause and release markers determine the race order.

Immutable bundles are shared within a test run. Every fixture keeps fresh
runtime state. D1 reset uses one batch with the same statements, order and
transition seeding as before. Migration replay, fixed test dates, KV cleanup,
alarm cleanup and stalled-pass auditing remain in the setup path.

## Linux coverage and gate structure

The CI runner starts pinned Nix 2.34.7 as the non-root runner, verifies trusted
access, and stops its daemon on success, failure or cancellation. It refuses an
existing standard daemon. Cleanup removes only the socket with the recorded
device and inode. The general test command receives `NIX_REMOTE=daemon`; private
daemonless fixtures supply their own environment.

Tests that previously used Node as a store path now create a unique Nix store
path and a dependency. Tests remove temporary source files and never collect the
host store. The GC suite needs its own daemon but no host daemon or compiler. A
strict Linux CI reporter rejects collection-time and dynamic skips without
requiring a fixed test count.

CI splits static and type checks, workspace unit tests, server tests, action
tests, script tests, general end-to-end tests, remote-store tests and the
existing four-platform conformance matrix. The required `check` context
aggregates their results. Failed, cancelled or skipped dependencies prevent
success. Binary, flake, publication-pipeline and published-action jobs remain
separate.

The aggregator uses `always()` because GitHub accepts skipped required checks.
It only checks the dependency results with local `jq`, and has a one-minute
timeout. Build and test jobs do not use `always()`. See GitHub's [required-check
guidance][required-checks] and [cancellation behaviour][cancellation].

[required-checks]:
  https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks
[cancellation]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation

Locally, a typed scheduler accounts for every `check:*` entry and rejects an
unmapped new check. It prepares build-info atomically before scheduling, starts
long suites first, runs at most two top-level tasks, and passes explicit worker
budgets. Standalone checks remain usable. Cancellation terminates process
groups, including descendants whose parent exits first.

## Validation and measurements

The complete local `pnpm check` passed all 21 tasks in about nine minutes. It
reported 10,926 passing tests and four tests skipped because they require
another platform: two Linux-only GC cases and two conformance cases. The long
server and general end-to-end suites ran together:

| Suite              | Passed | Skipped | Task duration |
| ------------------ | ------ | ------- | ------------- |
| Server             | 2,617  | 0       | 286.40s       |
| General end-to-end | 161    | 2       | 367.25s       |
| Workspace unit     | 5,908  | 0       | 69.64s        |
| Actions            | 1,534  | 0       | 49.15s        |
| Scripts            | 581    | 0       | 33.57s        |
| Remote store       | 14     | 0       | 49.42s        |
| Conformance        | 111    | 2       | 27.19s        |

Task durations overlap and do not sum to command runtime. The server count
includes the new reset, worker-budget and verification-acknowledgement cases.

The first isolated Linux run executed 155 cases with zero skips in 533.42s. This
includes the previously skipped daemon cases and uses Node outside `/nix/store`.
The environment uses Node 24.21.0 and Nix 2.34.7 on local ARM Linux; it is not
equivalent to a hosted GitHub runner.

The final Linux run executed all 163 general end-to-end cases with zero skips in
522.34s. Two additional daemon tests verified trusted access and socket cleanup.

Both GC cases also passed with the standard host daemon socket absent and the
compiler excluded from `PATH`. The complete Linux run exercised the explicitly
daemonless build cases.

The [first CI run of this implementation][implementation-run], at `f2feea8`,
passed all 17 jobs. The source checks completed in 13m02s, measured from the
first source job's start to the aggregator's completion. The slowest dependency
was x86_64 Darwin conformance, including setup, at 12m50s. Server tests passed
all 2,617 cases in 581.17s, and the general Linux end-to-end suite passed all
163 cases with zero skips in 455.80s. The complete jobs took 10m07s and 8m04s,
respectively, including setup and cleanup.

[implementation-run]:
  https://github.com/underwhelmingperformance/cupboard/actions/runs/37334662974

We compared one, two and four workers by running the same slow test files three
times at each worker count: attestations, tokens, uploads and narinfo deletion.
A new default requires at least 5% improvement in the complete suite with no new
failures, skips or timeouts. Otherwise the default remains four.

All nine samples of the final implementation passed the same 396 tests with zero
failures and skips:

| Workers | Sample 1 | Sample 2 | Sample 3 | Median  |
| ------- | -------- | -------- | -------- | ------- |
| 1       | 165.72s  | 169.29s  | 177.60s  | 169.29s |
| 2       | 104.07s  | 100.86s  | 100.86s  | 100.86s |
| 4       | 78.60s   | 76.66s   | 74.88s   | 76.66s  |

Four workers were fastest in every sample, so the default remains four. The
measurements ran without competing test processes.

## Follow-ups

Fresh Miniflare startup, D1 and Durable Object migration replay, and preparing
Node, the C compiler and the build hook still contribute to runtime. Schema
snapshots and persistent container-image caching are outside this change.

The existing GC fixture cleanup assumes that daemon construction succeeded. A
setup failure can cause another cleanup error or leave its temporary workspace.
That lifecycle repair is separate from runtime and coverage restoration.

A later native artifact cache must contain only immutable Node, compiler and
hook artifacts. Its key must include the image digest, nixpkgs revision,
architecture and hook source. Test stores and containers must remain fresh.
