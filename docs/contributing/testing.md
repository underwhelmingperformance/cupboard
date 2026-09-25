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
| Publishing pipeline test     | `pnpm e2e:pipeline`                   | No                  | Nix. Some parts also need Docker or a release archive.           |
| Benchmarks                   | `pnpm bench:push`                     | No                  | Nix                                                              |

`pnpm check:test` runs the first four rows together.

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
it must clean them up itself. When a test times out, Vitest doesn't say which
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
- Give every wait a deadline and a diagnostic message. The commit fixture waits
  up to 20 seconds for the first frame, and up to 20 seconds for the verdict.
  That leaves time within the 30-second test timeout for clean-up and the checks
  that run after each test. When a wait times out, the message gives the phase,
  the upload ID, the server name, the socket state, the queued frames and any
  pending readers.
- Use the default test timeout. Don't raise a test's timeout to make a slow
  fixture pass. Find the slow step instead.

After each test, a shared `afterEach` hook checks every Durable Object that the
test used. It clears their alarms. If any object still has a retry scheduled for
the future, the hook fails the test, and the message gives the maintenance pass
and how long was left.

When you investigate a timeout, start with the commit phase and socket state in
the error. `workerd` also prints alarm and exception messages, but some tests
cause failures on purpose and print the same messages. These messages only help
once you've connected them to the failing test and Durable Object.

## Actions tests

`pnpm test:actions` runs `actions/src/**/*.test.ts`. Many of these tests run the
action as a real subprocess and create files on disk, so each test has a
30-second timeout.

## Script tests

`pnpm test:scripts` runs the tests for the repository scripts in `scripts/`.
These cover the binary build, the release script, the generated references, the
flake's dependency hash, the conformance oracle updater and the reusable
workflows, among others.

## End-to-end tests

`pnpm check:e2e` runs `tests/e2e/**/*.test.ts` and the tests for the shared test
harness in `tests/support`. It runs one file at a time, and each test has a
two-minute timeout. The remote store and publishing pipeline tests have their
own configurations, so this command doesn't run them.

Each test file starts a `CupboardTestServer`, from
`tests/support/cupboard-server.ts`. The test server bundles the Worker with Vite
and runs it under Miniflare, behind a local HTTP server, so that a real `nix`
client can connect to it. A stub OIDC issuer signs the tokens that the tests
exchange.

In production, the CLI uploads NARs to Cloudflare's S3-compatible R2 endpoint.
Miniflare doesn't provide that endpoint, so the test server writes the NAR files
straight into the R2 bucket binding. Everything else, including negotiation,
commits, verification and retention, runs as it does in production.

The end-to-end tests cover substitution, signing key rotation, private reads,
named caches, reuse views, sign-up, the control plane, OIDC federation,
`build-push`, garbage collection and staged upgrades. They need a working Nix
installation. Tests that need the Nix daemon's socket, a C compiler (`cc`) or
Linux skip themselves if those aren't available.

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

CI runs this suite on `x86_64-linux`, `aarch64-linux`, `x86_64-darwin` and
`aarch64-darwin`. [The Nix conformance suite](./nix-conformance.md) describes it
in more detail.

## Publishing pipeline test

`pnpm e2e:pipeline` runs a whole publishing run for a sample repository. It
evaluates and builds for real, runs the composite action, and pushes to a Worker
running in `workerd`, signing in with OIDC. Each test can take up to 30 minutes.
`pnpm check` doesn't run it, but CI runs it as a separate job.

The whole test is skipped if Nix isn't installed. Two parts of it are optional:

- The remote store part needs a container engine, and is skipped without one.
- The release archive part publishes using a built release instead of the
  checked-out code. It only runs if `CUPBOARD_RELEASE_ARCHIVE` is set to the
  path of an archive. `pnpm build:binary` builds one.

## Benchmarks

`pnpm bench:push` runs the benchmarks in `tests/perf` against a Worker running
under Miniflare. They need Nix.

- `push.bench.ts` measures a real push of new store paths.
- `reuse.bench.ts` measures reuse view lookups while commits are in progress.

Some packages have their own benchmarks, in `*.bench.ts` files. To run the CLI's
benchmarks, use `pnpm --filter @cupboard/cli bench`.

## Test fixtures

| Path                                          | Contents                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/simple`                       | A small source tree, with its NAR and metadata. `pnpm fixtures:generate` rebuilds them with `nix-store`. |
| `tests/fixtures/cache-deployment-predecessor` | Workers that imitate an earlier release, for the staged upgrade test.                                    |
| `tests/fixtures/nix-ssh-store`                | The Dockerfile for the remote store tests.                                                               |
| `tests/fixtures/github-actions`               | A workflow from an older caller, for the reusable workflow tests.                                        |
