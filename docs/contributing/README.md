# Contributing

This page gets you from a fresh clone to a working checkout. It shows how to run
the CLI and the Workers from source, and which checks your change has to pass
before it can merge.

Before your first change, read [AGENTS.md](../../AGENTS.md). It sets out the
coding conventions, and the checks enforce many of them. Once you're set up,
[Architecture](./architecture.md) explains how the pieces of cupboard fit
together.

## What you need

You need these to install dependencies and run the unit tests:

- Node.js 24. The file `.node-version` pins 24.21.0, and `package.json` requires
  at least version 24. `.npmrc` sets `engine-strict=true`, so pnpm won't install
  anything on an older Node. There's no build step for the CLI. Node runs its
  TypeScript directly, using `--experimental-transform-types`.
- pnpm 12.5.1. The `packageManager` field in `package.json` pins this version.
  If you run `corepack enable`, Corepack installs the pinned version the first
  time you use pnpm.
- pre-commit, to install the Git hooks. The hook that checks commit messages,
  `wrapscallion-system`, also needs Deno on your `PATH`.

You also need these for some of the slower checks:

- Nix. The conformance suite and the end-to-end suites need it, and so do the
  `update:conformance-oracle` and `update:flake-deps` scripts. CI installs Nix
  2.34.7.
- Docker, or another container engine that Testcontainers can drive. Only the
  remote-store end-to-end suite needs it.

## Setting up

Install the dependencies and the Git hooks:

```sh
pnpm install
pre-commit install
```

`pre-commit install` sets up two hooks: one that runs before each commit, and
one that checks the commit message.

The workspace sets `minimumReleaseAge` to 1,440 minutes. This means pnpm won't
install a version of a dependency that was published less than a day ago.

To add a dependency, use `pnpm add`, or `pnpm add -D` for a development
dependency. Scope it to the package that needs it with
`--filter @cupboard/<name>`. For example:

```sh
pnpm add -D --filter @cupboard/cli some-package
```

## Finding your way around

The repository is a pnpm workspace. Most of the code is in `packages/`:

| Path                 | What's in it                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `packages/cli`       | The `cupboard` CLI: pushing, managing tenants and keys, deploying, printing Nix config.  |
| `packages/server`    | The control Worker, the tenant Worker, and the tenant Worker's `CupboardServer` object.  |
| `packages/protocol`  | The oRPC contract for the admin API (in `src/contract`) and the schemas that it shares.  |
| `packages/nix-store` | NAR and narinfo parsing, store paths, hashes and branded scalars. Pure; runs in Workers. |
| `packages/nix`       | The live Nix client, which reads the local store or talks to the daemon. Node only.      |
| `packages/shared`    | Attestation verification, the shared Octokit client, retries and typed errors.           |
| `packages/logger`    | Logging configuration on LogTape, with JSON-lines and GitHub Actions sinks.              |
| `packages/reporter`  | Progress output for the terminal and as JSON.                                            |
| `packages/cli-ui`    | Interactive terminal output and prompts, built with Clack on top of the reporter.        |

The rest of the repository contains the GitHub Actions, the test suites and the
tooling:

| Path                | What's in it                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `actions/`          | The composite GitHub Actions, with the TypeScript that they share in `actions/src`.                    |
| `tests/e2e`         | End-to-end suites that run against a Worker under Miniflare.                                           |
| `tests/conformance` | Tests that check the TypeScript Nix client against a pinned `nix` binary.                              |
| `tests/perf`        | Benchmarks for pushing and for reuse.                                                                  |
| `tests/fixtures`    | Test data, including the fixture that imitates an earlier release.                                     |
| `tests/support`     | Code that the suites share: the test server, Nix helpers and a stub OIDC issuer.                       |
| `scripts/`          | Repository tooling: the binary build, releases, generated references, dependency and migration checks. |
| `docs/`             | Documentation for users, operators and contributors.                                                   |

The public actions are `setup`, `build-paths`, `push`, `attest` and
`attest-attach`. The actions `plan`, `prepare`, `build-cohort` and
`resolve-cupboard` are internal steps of the reusable workflows. Callers don't
use them directly.

## Running the CLI from source

`pnpm cli` runs the CLI straight from its source, `packages/cli/src/main.ts`.
You don't need to build anything first:

```sh
pnpm cli --help
pnpm cli push https://cupboard.example.workers.dev/t/acme ./result
```

To build the single-file executable that a release ships, run
`pnpm build:binary`. [Releasing](./releases.md#the-binaries) describes what it
produces.

## Running the Workers locally

You can run the whole server on your own machine:

1. Copy the example secrets file:

   ```sh
   cp packages/server/.dev.vars.example packages/server/.dev.vars
   ```

   `.dev.vars` is ignored by Git. The example file explains each setting. Set
   `CUPBOARD_LOCAL_DEV` to `1` or `true` to let a local OIDC issuer work over
   plain HTTP, and to let the first operator claim the deployment without a
   claim secret or pinned identity.

2. Apply the D1 migrations to your local database. `pnpm dev` doesn't do this
   for you:

   ```sh
   pnpm --filter @cupboard/server exec wrangler d1 migrations apply CUPBOARD_DB --local
   ```

3. Start the server:

   ```sh
   pnpm dev
   ```

`pnpm dev` first regenerates the TypeScript types for the Worker bindings. It
then runs `wrangler dev` with both Worker configurations. The control Worker,
the tenant Worker and its Durable Object all run together, using Wrangler's
local stand-ins for D1, R2, KV and the queue.

### What doesn't work locally

You can't push to a local server. When the CLI pushes, it uploads NARs to
Cloudflare's S3-compatible endpoint for R2, using a temporary R2 credential.
Miniflare doesn't provide that endpoint.

The end-to-end tests get round this. Their harness,
`tests/support/cupboard-server.ts`, writes the bytes straight into the local
bucket instead. If you want to try a real push, deploy a development build.

## Deploying a development build

To deploy your working tree to your own Cloudflare account, run this from the
checkout:

```sh
pnpm cli deploy
```

`deploy` is another name for `cupboard init`. It creates any resources that
don't exist yet, finding them by name. It then applies the migrations and
uploads both Workers. The [operator guide](../operator/deploying.md) describes
its options.

When you run `deploy` from source, it always bundles your working tree. A
released `cupboard` binary behaves differently. It deploys the Worker bundles
built into it, even when you run it inside a checkout. Pass `--from-tree` to
make it bundle the working tree instead.

There's also a `pnpm deploy` script, but it isn't a way to set up a deployment.
It applies the D1 migrations and then runs `wrangler deploy` for both Workers.
The Wrangler configuration files contain placeholder resource IDs, and
`cupboard deploy` never edits them.

## Checking your change

`pnpm check` runs every script whose name starts with `check:`, one after
another. CI runs it on every pull request. You need Nix and Docker to run all of
it.

| Script                            | What it does                                                                                                    | What it needs                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `check:deps`                      | Runs `syncpack lint` over the workspace's `package.json` files.                                                 |                                                                      |
| `check:format`                    | Runs `prettier --check .`.                                                                                      |                                                                      |
| `check:lint`                      | Runs `eslint .`.                                                                                                |                                                                      |
| `check:knip`                      | Runs Knip, to find unused and unlisted dependencies.                                                            |                                                                      |
| `check:types`                     | Runs each package's `check:types`. The server's script also checks that the Wrangler binding types are current. |                                                                      |
| `check:types:root`                | Runs `tsc` over `actions/`, `scripts/` and the shared test code.                                                |                                                                      |
| `check:types:tests`               | Runs `tsc` for `tests/e2e`.                                                                                     |                                                                      |
| `check:types:conformance`         | Runs `tsc` for `tests/conformance`.                                                                             |                                                                      |
| `check:types:perf`                | Runs `tsc` for `tests/perf`.                                                                                    |                                                                      |
| `check:types:predecessor-fixture` | Runs `tsc` for the fixture that imitates an earlier release.                                                    |                                                                      |
| `check:test`                      | Runs every package's unit tests, including the Workers tests, then `test:actions` and `test:scripts`.           |                                                                      |
| `check:migrations`                | Replays every D1 migration in order in SQLite, to catch one that can't apply after the others.                  |                                                                      |
| `check:flake-deps`                | Checks that `pnpm-deps-hash.json` was recorded from the current `pnpm-lock.yaml`.                               |                                                                      |
| `check:conformance-oracle`        | Checks that each recorded oracle Nix version matches its generated settings table.                              |                                                                      |
| `check:conformance`               | Runs the Nix conformance suite.                                                                                 | Nix, and network access to build or substitute `.#conformanceNix`.   |
| `check:e2e`                       | Runs the end-to-end suites.                                                                                     | Nix. Some cases also need Linux, the daemon socket and a C compiler. |
| `check:e2e-remote-store`          | Runs the remote Nix store suite, against an `ssh-ng` store in a container.                                      | Nix and Docker.                                                      |

If your machine doesn't have the Nix daemon socket, a C compiler or Linux, the
end-to-end cases that need them skip themselves. The conformance suite is
different. If it can't build its reference copy of Nix, it fails rather than
skipping.

Two more test tiers aren't part of `pnpm check`. `pnpm e2e:pipeline` runs a
consumer repository's whole publication job, and `pnpm bench:push` runs the
benchmarks. [Testing](./testing.md) describes every tier.

### Running only what you need

While you work, you can run just the checks that your change affects. For
example:

```sh
pnpm --filter @cupboard/cli test
pnpm --filter @cupboard/cli exec vitest run src/commands/push.test.ts
pnpm --filter @cupboard/server test
pnpm test:actions
pnpm test:scripts
pnpm check:lint
pnpm check:types
```

The pre-commit hooks also catch a lot. When you commit, they run `check:deps`,
`check:flake-deps`, `check:format`, `check:lint`, `check:knip` and
`check:types`, but only when files that they check have changed. If you change
the flake lock or the oracle data, they also run the conformance oracle test,
which needs Nix. They run some standard file-hygiene checks too, and lint the
workflows and actions with `actionlint` and `zizmor`.

Run the full `pnpm check` before you push. CI runs it as well, along with a few
things that `pnpm check` doesn't cover:

- the conformance suite on four systems;
- a build of the flake;
- a smoke test of the release binary;
- the publication pipeline tier.

### Fixing problems automatically

`pnpm fix` fixes what it can for you. It runs `syncpack format`,
`prettier --write .` and `eslint . --fix`.

## Keeping generated files up to date

Some files in the repository are generated from others. When you change the
source of one of these files, run its command to regenerate it. A test or check
fails while the generated file is out of date.

| Command                                     | What it regenerates                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm update:cli-reference`                 | `docs/reference/cli.md`, from each command's help.                                     |
| `pnpm update:actions-reference`             | `docs/reference/actions.md`, from the YAML of the actions and reusable workflows.      |
| `pnpm update:conformance-oracle`            | `tests/conformance/oracle.json` and the Nix settings table for each system. Needs Nix. |
| `pnpm update:flake-deps`                    | `pnpm-deps-hash.json`, after the lockfile changes. Needs Nix.                          |
| `pnpm fixtures:generate`                    | `tests/fixtures/simple`. Needs `nix-store`.                                            |
| `pnpm --filter @cupboard/server cf:typegen` | `worker-configuration*.d.ts`, after a change to the Wrangler configuration.            |

### Database schemas and migrations

cupboard has two databases, and each has its own schema and migrations. The
shared D1 database's schema is in `packages/server/src/db/d1-schema.ts`, and its
migrations are in `packages/server/drizzle-d1`, configured by
`drizzle.config.d1.ts`. Each tenant's Durable Object has its own SQLite
database. Its schema is in `packages/server/src/db/schema.ts`, and its
migrations are in `packages/server/drizzle`, configured by `drizzle.config.ts`.
[Architecture](./architecture.md) explains what each database contains.

## Writing commit messages

Commit messages follow [Conventional Commits], and the body must be wrapped at
72 columns. [wrapscallion] checks both. It runs as the `commit-msg` hook on your
machine, and in CI on every pull request and merge-queue run. The repository has
no `.wrapscallion.toml`, so wrapscallion uses its defaults. If the hook rejects
your message, it prints a correctly wrapped version that you can use instead.

The history uses these types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`
and `chore`. Add a scope for the area that you changed, such as `cli`, `server`,
`cache`, `ci`, `e2e` or `deps`. Mark a breaking change with `!`, as in
`feat(cli)!:`.

In the body, explain the problem first and then the change, in prose. For
example:

```text
fix(cli): recover built provenance from hook outputs

When Nix omits build-start activity from its JSON log, publication
cannot attribute a built subject even if the post-build hook reports the
output. Provenance-required publication therefore fails.

For a single attempt, accept a hook output whose deriver matches an
ultimate store path as evidence of a local build.
```

## Opening a pull request

Before you open a pull request, run `pnpm check` and regenerate any generated
files that your change affects. CI runs on pull requests and again in the merge
queue. Renovate keeps the dependencies up to date.

[Conventional Commits]: https://www.conventionalcommits.org/
[wrapscallion]: https://github.com/underwhelmingperformance/wrapscallion
