# Testing

cupboard has several kinds of test. They range from fast unit tests that only
need Node, to end-to-end tests that run a real Nix client against a local copy
of the Workers, to a test of a whole publishing run through the GitHub Action.
This page explains what each kind covers, how to run it, and what it needs.

| Tests                        | Command                               | Run by `pnpm check` | Needs                                                            |
| ---------------------------- | ------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| Package unit tests           | `pnpm -r run test`                    | Yes                 | Node and pnpm                                                    |
| Workers tests                | `pnpm --filter @cupboard/server test` | Yes                 | Node and pnpm                                                    |
| Actions tests                | `pnpm test:actions`                   | Yes                 | Node and pnpm                                                    |
| Script tests                 | `pnpm test:scripts`                   | Yes                 | Node and pnpm                                                    |
| End-to-end tests             | `pnpm check:e2e`                      | Yes                 | Nix. Some tests also need Linux, the Nix daemon or a C compiler. |
| Remote store end-to-end test | `pnpm check:e2e-remote-store`         | Yes                 | Nix and Docker                                                   |
| Nix conformance tests        | `pnpm check:conformance`              | Yes                 | Nix, and network access to fetch the reference Nix               |
| Publishing pipeline test     | `pnpm e2e:pipeline`                   | No                  | Nix and a C compiler. Some parts also need Docker.               |
| Benchmarks                   | `pnpm bench:push`                     | No                  | Nix                                                              |

`pnpm check:test` runs the first four rows together.

## Time and synchronisation

These are the rules for new and changed tests, and they apply to every kind of
test on this page. Many existing tests and configurations predate these rules
and do not follow them yet. Don't copy a pattern that breaks a rule, even from
neighbouring code.

1. A test waits on the event that decides its outcome. It awaits the promise of
   the operation itself. When the test cannot reach that promise, expose it
   through the object or client under test: an RPC that returns the operation's
   promise, or a method that awaits the operation while the instance is live.
   When the outcome is an effect outside the test process, wait for an event
   from the process that produces it: its exit, a line of output, or a message
   on a pipe or socket. Don't wait for a file to appear. A wait on file-system
   events alone can hang, because `fs.watch` can lose events when other
   processes write heavily to the watched directory, and the test then waits
   until its time limit. The message of commit 6cb39b380 records a reproduction:
   writing 200 files at a time into the directory made five tests hang. When
   code in this repository, including a test fixture, gives no such event,
   change it so that it reports the effect through a callback, a promise or a
   line of output. When a program outside this repository gives no such event,
   as the `nix-daemon` server does, create the listening socket in the test and
   pass it to the server through systemd socket activation (`LISTEN_FDS` and
   `LISTEN_PID`, which Nix supports), so that the socket exists before the
   server starts.

   Don't check a condition on a timer, or in a loop that checks again without
   waiting for an event. That rules out polling intervals, attempt-limited
   retries, and `vi.waitFor` and `vi.waitUntil`. A loop that waits for an event
   before each check is waiting on events, so it is allowed.
   `ManualClock.waitForDelay` is such a loop. A check on a timer happens at
   moments that the test chooses, not when the outcome happens, so a loaded
   machine can make it run too late or give up too early.

2. Don't give an individual test, hook or wait a time limit. Don't pass a
   timeout argument to a test or hook, don't set a timeout option for one test,
   and don't pass `AbortSignal.timeout` to a wait in test code. A deadline in
   production code under test uses the injected clock (rule 3). In every Vitest
   configuration, set `testTimeout` and `hookTimeout` to the same value,
   1,800,000 ms (30 minutes), and don't tune them for one suite. Spread
   `hangLimits` from `tests/support/hang-limits.ts` into the configuration. Also
   spread it into each inline project that doesn't set `extends: true`, because
   such a project doesn't inherit the limits of its configuration. A
   configuration that uses `mergeConfig` on one that already spreads
   `hangLimits` needs nothing more. The value only detects a hung test or hook:
   Vitest fails it and continues with the next test. Every package that has
   tests must have a Vitest configuration that sets both limits, because without
   one Vitest applies its defaults of 5 seconds for a test and 10 seconds for a
   hook.

   Set the `timeout-minutes` of each CI job that runs tests to at least the
   job's slowest recent run plus 30 minutes. A job's slowest recent run is its
   slowest successful run among its last 40 runs. For a matrix job, use the
   slowest of any matrix entry. A job that GitHub cancels gives no report of
   what was running. With this margin, Vitest reports a single hung test or hook
   near the end of the run before GitHub cancels the job. The margin covers one
   hang. A hung test or hook followed by a teardown hook that waits on the same
   operation takes two limits, so cancel that operation in teardown and don't
   wait for it.

   The merge queue fails an entry when a required check has not reported within
   60 minutes of the queue starting the entry's checks. That time includes
   waiting for a runner, so don't raise a job's limit beyond what this rule
   requires.

   Never raise a time limit to make a slow test pass. Remove the time dependence
   instead. A time limit that fits one machine fails on a busier one, and the
   failure then shows the machine's load, not a defect in the code.

3. Inject the delays and deadlines of production code. Code that waits or sets a
   deadline takes the delay or the clock as a parameter. A test passes a delay
   of zero, or drives an injected clock such as `ManualClock` from
   `tests/support/manual-clock.ts`. Don't fake the global timers and then
   advance them, and never call `advanceTimersByTime` in a loop. Faked timers
   tie the test to the number and order of the timers that the code arms. When a
   refactor adds or reorders a timer, the test breaks or hangs, and an advance
   that happens before the code arms its timer has no effect. An injected clock
   lets the test see each delay that the code requests.

4. Don't assert on wall-clock time. This covers a wall-clock timestamp, an
   elapsed wall-clock time and a comparison of two wall-clock durations. A test
   can record the delays that the code requests from an injected clock such as
   `ManualClock`, and the clock's time after each one. The test can assert on
   these values, because they don't depend on the machine. Test complexity
   deterministically by counting steps, calls or rows. A Vitest benchmark
   (`*.bench.ts`), run on demand, is the only place for timing, because elapsed
   time varies with the load on the machine. See [Benchmarks](#benchmarks).

5. A flaky test is a real defect. When a test fails once, capture the failure
   and find the cause. Don't retry the test, widen a time limit or skip it. An
   intermittent failure is usually a race or an unstated dependency in the test,
   in a helper or in the code under test, and a retry hides it.

Two helpers show rules 1, 3 and 4 in practice. The worker in
`tests/support/build-paths-clock-worker.ts` runs the native build worker with a
`ManualClock`. It advances the clock through each retry delay as the worker
requests it, and writes the delay and the clock time to `retry-clock.jsonl`. The
real Nix builds in `tests/e2e/build-paths.test.ts` therefore don't wait through
the delays, and the test asserts the recorded entries.

The remote store suite waits on a line of process output. The fixture container
runs the script `cupboard-blocking-daemon`, which prints
`cupboard-blocking-daemon-started` and `cupboard-blocking-daemon-stopped`.
`waitForBlockingDaemonEvent` in `tests/support/remote-nix-store.ts` resolves
when the fixture reads one of these lines.

## Package unit tests

Every package uses Vitest. The tests live next to the code that they test, in
`*.test.ts` files.

To run one package's tests:

```sh
pnpm --filter @cupboard/cli test
```

To run a single file:

```sh
pnpm --filter @cupboard/cli exec vitest run src/cli.test.ts
```

The CLI's test suite blocks network access. If a test tries to connect to
anything other than the loopback interface, it fails, and the error gives the
destination. A test that needs a server should start a stub on `127.0.0.1` or
use a Unix socket.

## Workers tests

The server package, `packages/server`, has two sets of tests, defined as Vitest
projects in `packages/server/vitest.config.ts`:

- `node` runs `src/**/*.test.ts` in Node. These tests are for code that doesn't
  need the Workers runtime.
- `workers` runs `src/**/*.workers.test.ts` inside `workerd`, Cloudflare's
  Workers runtime, using `@cloudflare/vitest-pool-workers`.

The Worker under test in the `workers` project is `src/test-worker.ts`, with the
tenant Worker's configuration. Tests can reach the Durable Object with
`runInDurableObject`. To test the control Worker, a test calls its `fetch`
handler directly, using `controlFetch` from `src/test-support.ts`. The
control-plane secrets aren't bound in this project, so the Durable Object
doesn't have them, which matches production.

The test environment binds test R2 credentials, a test push ID signing key, both
KV namespaces and the maintenance queue. It sets the subrequest limit to the
Workers Free plan's value. It also lowers the limit on commit sockets for each
tenant to 10, so that a test can reach it. `src/d1-test-setup.ts` applies the D1
migrations before any test runs.

`pnpm --filter @cupboard/server test` writes the build information file and then
runs both projects. To run one project or one file, write the build information
file once, then run Vitest directly:

```sh
pnpm --filter @cupboard/server build-info
pnpm --filter @cupboard/server exec vitest run --project workers <path>
```

### Writing Workers test fixtures

These tests run against real Durable Objects and hibernatable WebSockets. A test
is responsible for every object, alarm and socket that its fixtures create, and
it must clean them up itself. When Vitest ends a hung test, it doesn't say which
asynchronous step stalled, and it doesn't close any sockets that a helper still
has open.

Follow these rules:

- Create committed store paths one at a time. If a maintenance test needs many
  committed paths, it creates them in separate commit sessions, one after
  another. It closes each session before opening the next, and stops alarms from
  being scheduled automatically while it does this. Only tests about concurrent
  pushes should push concurrently.
- Always close commit sockets. `completeCommitSession` closes its socket in a
  `finally` block, so a parsing or verification error can't leave it open.
- Wait on events and don't give a test a time limit, as
  [Time and synchronisation](#time-and-synchronisation) describes. Don't raise a
  time limit to make a slow fixture pass. Find the slow step.

After each test, a shared `afterEach` hook stops alarms on every Durable Object
that armed an alarm during the test and on every object that the harness
selected. A stopped object does not arm alarms, and it skips its alarm handler,
until the shared `beforeEach` hook of the next test resumes alarms. The hook
also deletes the alarms that those objects armed. The hook then checks the
objects that the harness selected. If any of them still has a retry scheduled
for the future, the hook fails the test, and the message gives the maintenance
pass and how long was left.

A call that started in an earlier test, such as a `fetch` request, an RPC method
call or an alarm handler, cannot arm alarms in a later test. Its `setAlarm` call
resolves without arming an alarm and logs nothing. Work that an earlier test
started keeps that test's generation, even when a call in a later test waits for
the work. The retry alarm of a shared migration, for example, is refused in that
case.

`completeCommitSession` predates these rules and gives each phase a deadline of
20 seconds. When it throws `CommitFixturePhaseTimeoutError` or
`CommitFixturePassesExhaustedError`, start with the phase and the socket state
in the error.

`workerd` prints alarm and exception messages, but some tests cause failures on
purpose and print the same messages. These messages only help once you've
connected them to the failing test and Durable Object.

The Worker project defaults to four workers. `CUPBOARD_TEST_WORKERS` supplies an
explicit project budget, for example:

```sh
CUPBOARD_TEST_WORKERS=2 pnpm --filter @cupboard/server test
```

`pnpm check` divides the available CPUs between at most two top-level tasks and
passes a budget to each test process. Vitest hides console output from passing
server tests and prints it for failed tests. The runtime still formats Worker
logs, and Vitest still captures them.

## Actions tests

`pnpm test:actions` runs `actions/src/**/*.test.ts`. Many of these tests run the
action as a real subprocess and create files on disk.

## Script tests

`pnpm test:scripts` runs the tests for the repository scripts in `scripts/`.
These cover the binary build, the release script, the generated references, the
flake's dependency hash, the conformance oracle updater and the reusable
workflows, among others.

## End-to-end tests

`pnpm check:e2e` runs `tests/e2e/**/*.test.ts` and the tests for the shared test
harness in `tests/support`. It runs one file at a time. The remote store and
publishing pipeline tests have their own configurations, so this command doesn't
run them.

Each test file starts a `CupboardTestServer`, from
`tests/support/cupboard-server.ts`. The test server bundles the Worker with Vite
and runs it under Miniflare, behind a local HTTP server, so that a real `nix`
client can connect to it. A stub OIDC issuer signs the tokens that the tests
exchange.

In production, the CLI uploads NARs to Cloudflare's S3-compatible R2 endpoint.
Miniflare doesn't provide that endpoint, so the test server writes the NAR files
straight into the R2 bucket binding. Everything else, including negotiation,
commits, verification and retention, runs as it does in production.

The test harnesses read and write D1 and R2, write the tenant cache in KV, and
call the manual-alarm methods of the tenant Durable Objects through a separate
Worker in the same Miniflare instance, `tests/support/bindings-worker.ts`. They
call that Worker with `Miniflare#dispatchFetch`. They don't use Miniflare's
binding proxies, such as `getD1Database`. The synchronous operations of those
proxies keep a connection to workerd open between calls, and after a stall
workerd can close that connection without reading the next request
([cloudflare/workers-sdk#16445][workers-sdk-16445]).

This protection depends on the Miniflare version. In Miniflare 4.20260730.0,
`dispatchFetch` sets undici's `reset` option on every request to workerd, so
each request uses a new connection. Miniflare 5.20261006 and later reuse these
connections ([cloudflare/workers-sdk#16243][workers-sdk-16243]). The test
`starts when workerd stalls past its idle connection timeout` in
`tests/support/cupboard-server.test.ts` fails if a Miniflare upgrade makes this
change. A new connection is still exposed to workerd's 15-second header timeout:
if workerd accepts a connection and then cannot read its request for 15 seconds,
it answers 408, and the harness reports that response as an error.

[workers-sdk-16445]: https://github.com/cloudflare/workers-sdk/issues/16445
[workers-sdk-16243]: https://github.com/cloudflare/workers-sdk/issues/16243

The end-to-end tests cover substitution, signing key rotation, private reads,
named caches, reuse views, sign-up, the control plane, OIDC federation,
`build-push`, garbage collection and staged upgrades. They need a working Nix
installation. Tests that need a daemon, a C compiler (`cc`) or Linux skip
locally when those prerequisites are unavailable. Linux CI starts a trusted
daemon and fails on any skipped general end-to-end case. The GC fixture uses its
own diverted daemon, and private daemonless fixtures remain daemonless.

Use [`addKnownStorePath`][known-store-path] when a fixture needs a real Nix
store path and a dependency. Host executables can be installed outside
`/nix/store`. Tests must not collect the host store.

[known-store-path]: ../../tests/support/known-store-path.ts

Each end-to-end Vitest invocation builds the production and test Worker bundles,
plus the predecessor fixture, once from the working tree. Watch reruns rebuild
those artifacts. The fixtures continue to create fresh Miniflare instances,
issuers and storage; stopping a fixture does not remove shared artifacts. When
called outside these test suites, the support helpers build from the working
tree on each invocation.

### The staged upgrade test

`tests/e2e/cache-deployment-upgrade.test.ts` checks that a deployment upgrades
correctly through each stage of a migration. It starts from a deployment that
imitates an earlier release, defined in
`tests/fixtures/cache-deployment-predecessor`. That fixture contains small
control and tenant Workers with a fixed D1 migration and Durable Object
migration, and it creates tenants in each lifecycle state.

The test upgrades that deployment to the current Workers. It then checks that:

- every tenant migrates, including one that was never woken under the old
  release;
- an interrupted deploy resumes at the same stage;
- old retention policies are still in effect afterwards.

`pnpm check:types:predecessor-fixture` type-checks the fixture separately.

## Remote store end-to-end test

`pnpm check:e2e-remote-store` runs `tests/e2e/remote-nix-store.test.ts` on its
own. It uses Testcontainers to build `tests/fixtures/nix-ssh-store`, which is an
OpenSSH server on top of a `nixos/nix` image. The test uses that container as an
`ssh-ng` store, and checks remote builds, copies, cancellation, host key pinning
and publishing outputs that were built there.

This test needs Nix and a container engine. It fails, instead of skipping, if
either is missing.

## Nix conformance tests

`pnpm check:conformance` compares the TypeScript Nix client in `packages/nix`
with a real `nix` binary. It checks how both find configuration, choose a store,
accept narinfos and plan closures.

The reference `nix` binary is the flake's `conformanceNix` output, which the
suite builds with `nix build`. The suite doesn't use the `nix` on your `PATH`.
If it can't build the reference binary, it fails instead of skipping. Every Nix
call runs with its own empty configuration, so your Nix settings don't affect
the results.

`tests/conformance/oracle.json` records which Nix version to expect on each
supported system. `pnpm check:conformance-oracle` checks that file against the
generated settings tables, without running Nix. After you update the flake lock,
run `pnpm update:conformance-oracle` to regenerate both.

CI runs this suite on `x86_64-linux`, `aarch64-linux` and `aarch64-darwin`.
[The Nix conformance suite](./nix-conformance.md) describes it in more detail.

## Publishing pipeline test

`pnpm e2e:pipeline` runs a whole publishing run for a sample repository. It
evaluates and builds for real, runs the composite action, and pushes to a Worker
running in `workerd`, signing in with OIDC. Each case is a whole publication
job, so cases are slow. `pnpm check` doesn't run it, but CI runs it as a
separate job.

The whole test is skipped if Nix isn't installed. The remote store part needs a
container engine, and is skipped without one.

The packaged-executable part builds a release archive automatically with the
release build script, then publishes using that installation. It needs a C
compiler. The archive is built in the test's temporary workspace and removed
with the fixture. Filtered runs that exclude this part do not build an archive.
To test an existing archive, set `CUPBOARD_RELEASE_ARCHIVE` to its path.

## Benchmarks

Benchmarks are the only place for timing. Tests of any other kind must not
assert on wall-clock time. `pnpm check` doesn't run benchmarks.

`pnpm bench:push` runs the benchmarks in `tests/perf` against a Worker running
under Miniflare. They need Nix.

- `push.bench.ts` measures a real push of new store paths.
- `reuse.bench.ts` measures reuse view lookups while commits are in progress.

Some packages have their own benchmarks, in `*.bench.ts` files. The server's
`src/control/binary-fuse-filter/filter.bench.ts` belongs to the `node` project.
To run it, use
`pnpm --filter @cupboard/server exec vitest bench --run --project node`.

To run the benchmarks for the logger's credential scanner, use
`pnpm --filter @cupboard/logger bench`. For each input shape, they compare the
time to scan eight 8 KiB inputs with the time to scan one 64 KiB input. When the
scan is linear in the length of the text, the two times are about the same. The
logger's unit tests do not measure time. They prove each redaction pattern
linear with [recheck][recheck], and they count the characters that the scanner
reads.

[recheck]: https://makenowjust-labs.github.io/recheck/

## Test fixtures

| Path                                          | Contents                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/simple`                       | A small source tree, with its NAR and metadata. `pnpm fixtures:generate` rebuilds them with `nix-store`. |
| `tests/fixtures/cache-deployment-predecessor` | Workers that imitate an earlier release, for the staged upgrade test.                                    |
| `tests/fixtures/nix-ssh-store`                | The Dockerfile for the remote store tests.                                                               |
| `tests/fixtures/github-actions`               | A workflow from an older caller, for the reusable workflow tests.                                        |
