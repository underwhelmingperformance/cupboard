# GitHub Actions

cupboard publishes self-contained binaries on GitHub Releases and provides
composite actions for installing the binary and pushing build outputs from CI.
This guide covers setting a repository up and the tasks that follow: the
quickstart, each action, the reusable workflows, and routine changes to a
working setup.

The deeper material lives in its own documents and is linked where it matters:

- [docs/trust-rules.md](./trust-rules.md): how CI authenticates, what a trust
  rule matches, and rules beyond the presets.
- [docs/runner-provenance.md](./runner-provenance.md): why runner choice is
  operator configuration and what self-hosted estates should enforce.
- [docs/reuse-views.md](./reuse-views.md): reuse-view read semantics and how the
  workflow adopts earlier builds.
- [docs/releases.md](./releases.md): how the binaries themselves are built and
  attested.

## Version Selection

Both actions accept `cupboard-version`. The default is `latest`.

- `latest` resolves to the newest published release of any kind, prereleases
  included, because `include-prereleases` defaults to `true`. With
  `include-prereleases: false` it resolves through GitHub's [latest release
  endpoint][github-latest-release], which selects the latest non-prerelease,
  non-draft release.
- `1.2.3` is normalised to `v1.2.3` and resolved by tag.
- `v1.2.3` is used as-is and resolved by tag.

The flake publish workflow does not default: it requires the caller to pass the
release tag it is pinned with, so the workflow code and the CLI it drives always
come from one release. `cupboard-publish.yml` tracks `main` instead, its own
actions included, and installs `latest` by default. The actions negotiate the
installed CLI's result protocol, so the workflow keeps working while a change on
`main` is waiting for its matching binary release. Features that need richer
results, such as `require-grace`, still require a release that reports those
facts. Release API calls use `github-token`, which defaults to the workflow
`github.token`. Public unauthenticated downloads work, but the token avoids
unnecessary rate-limit failures.

[github-latest-release]:
  https://docs.github.com/en/rest/releases/releases#get-the-latest-release

## Cache-aware flake publishing quickstart

This is the shortest complete setup for publishing pull-request builds to
short-lived `pr-<number>` caches, then reusing those builds when `main` is
published.

The example assumes that cupboard is deployed, the tenant exists, its reads are
public, and `cupboard login` has stored its owner credential. Everything is
written either to the tenant or to files in the repository. The repository
lookup needs no GitHub credentials for a public repository; for a private one,
set a token in `GH_TOKEN` or `GITHUB_TOKEN` and setup and check will use it. See
[Getting started][readme-getting-started] in the README for deployment and
tenant creation. The later sections cover private reads, remote builders and
each setting in more detail.

[readme-getting-started]: ../README.md#getting-started

### 1. Choose the tenant, repository and release

Set these shell variables once so the remaining commands can be copied without
repeating them.

```bash
tenant=https://cupboard.example.workers.dev/t/acme
repo=acme/app
cupboard_version=vX.Y.Z
```

Replace `vX.Y.Z` with a real cupboard release tag from the [releases page][]
before continuing; every later step names this one tag.

[releases page]: https://github.com/underwhelmingperformance/cupboard/releases

### 2. Configure the tenant

One idempotent command writes everything the runs depend on: a 24-hour retention
grace period for every cache, the `pull-requests` reuse view over the per-PR
caches, and trust rules for this repository's PR and `main` runs:

```bash
cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/$cupboard_version"
```

The `--workflow-ref` pins the trust rules to the exact release tag the caller
workflow below uses. Setup verifies through GitHub that the tag belongs to an
immutable published release and that the workflow file exists there, so the
workflow code, the CLI it drives, and the claims the tenant trusts all name one
release.

To trust every release rather than one, pin a tag pattern instead:
`--workflow-ref "...cupboard-flake-publish.yml@refs/tags/v*"`. The stored rules
then accept the workflow at any tag the pattern admits, so moving the caller to
a new release needs no tenant change. This includes current and future matching
tags, so the repository's tag publishers become part of the tenant's trust
boundary. Setup validates the pattern and stores it without requiring a matching
tag to exist.

Re-running converges state that already matches. A different grace policy or
reuse view is reported as drift and never replaced. Trust-rule differences are
handled separately: a rule pinned to a different exact workflow reference can
safely remain even when its other claims or grants differ, while removing the
rules that can also match the new token must be confirmed. This lets setup add
the new release beside the old one without an authority gap. What each piece of
this configuration is, and the commands to write it by hand, are under
[Manual configuration](#manual-configuration).

One consequence deserves calling out before running it: the grace policy changes
how the covered caches are collected, permanently. The first publication
accepted under it marks its cache grace-managed, `policy remove-grace` does not
unmark it, and a grace-managed cache whose last deadline lapses may be emptied
by collection, which a cache without the marker never is.

### 3. Declare the targets

Expose a `cupboardOutputs` attribute from the flake. Each entry names an
installable and carries its derivation path, Nix system, permitted GitHub runner
label and the suffix used beneath the workflow's retention-root prefix:

```nix
cupboardOutputs = let
  package = packages.x86_64-linux.default;
in [
  {
    attr = ".#packages.x86_64-linux.default";
    rootDrvPath = package.drvPath;
    system = "x86_64-linux";
    os = "ubuntu-latest";
    remote = false;
    rootSuffix = "x86_64-linux/default";
  }
];
```

Add further entries for the other outputs and systems the repository publishes.

### 4. Call the reusable workflow

Add a caller such as `.github/workflows/cupboard.yml`. PR runs publish to their
own 14-day caches. A `main` run publishes to the default cache and reads through
the PR reuse view, so an unchanged result built by the PR can be adopted instead
of rebuilt:

```yaml
name: cupboard

on:
  pull_request:
  push:
    branches:
      - main

permissions: {}

# One publish per ref at a time: a rapid push supersedes the previous run
# instead of racing it. A reusable workflow inherits the caller's concurrency
# settings, so the group lives here.
concurrency:
  group: cupboard-publish-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    # One release pins both coordinates: the @tag selects the workflow and
    # action code, and cupboard-version below installs the matching CLI, so
    # the two can never skew.
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    with:
      # The tenant URL is an ordinary value in this file; edit it here.
      url: https://cupboard.example.workers.dev/t/acme
      targets: .#cupboardOutputs
      preset: pull-request-and-branch
      reuse-view: pull-requests
      cupboard-version: vX.Y.Z
```

The preset derives the cache, root prefix and TTL from the triggering event: a
`pull_request` run gets its own `pr-<number>` cache with a 14-day TTL, exactly
the name and root the PR trust rule routes. A run whose ref is the configured
`branch` gets the default cache, permanent retention under
`github:<repository>/<branch>`, and the reuse view. `branch` defaults to `main`
and must match the value passed to `cupboard github setup --branch`; another ref
is refused in the configure job before planning or building. Under the preset,
`reuse-view` therefore applies to trusted branch runs only, so `main` adopts PR
builds while each PR stays destination-only. A repository whose caches or roots
follow a different layout passes `cache`, `root-prefix` and `ttl` explicitly
instead; the preset and those inputs are mutually exclusive, so the two never
mix. The workflow reference and the `cupboard-version` input are pinned to one
release, so the action code and the CLI it invokes upgrade together and a
cupboard change never silently alters a repository's CI.
[Move to a new cupboard release](#move-to-a-new-cupboard-release) describes the
overlap needed to change that tag without interrupting publishing.

### 5. Verify the setup

Check the invariants the first run depends on before opening a pull request:

```bash
cupboard github check "$tenant" --repo "$repo" \
  --root-prefix "github:$repo/main" \
  --workflow-ref "underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/$cupboard_version"
```

The check requires the exact release tag or full commit currently used by the
caller. It verifies through GitHub that this names a real workflow at an
immutable release or commit, then evaluates the stored trust rules against
claims assembled from the supplied repository, branch and exact workflow
reference. This catches a misspelt workflow path or release before the first
run, proves that a stored tag pattern admits the concrete release, and verifies
that each matched rule's stored grants cover the caches and roots the run
requests. A workflow that instead matches an interactive administrator rule
fails the check, even when that rule's wildcard grant would allow the requested
operations. It does not inspect the caller workflow, so the supplied reference
must still match its `uses` line. The check also verifies the grace policy's
coverage and duration, the view's priority against the destination's as actually
served, and that the root prefix nests under the granted root. An invariant it
cannot verify with what it was given (no `--root-prefix`, say) is reported by
name and the exit is distinct from success.

Listing the configuration by hand remains available (`cupboard policy list`,
`cupboard reuse-view list`, `cupboard oidc-trust list`), but a listing shows
only that rows exist, not that they will match a real run.

Open a pull request and confirm that the workflow publishes to `pr-<number>`.
After merging it, the `main` run should plan already-published targets from the
reuse view and retain them beneath `github:<owner>/<repo>/main` in the default
cache. If a push is refused anyway, the refusal names the first failing claim
when the token really is from this repository; compare it against
[docs/trust-rules.md](./trust-rules.md).

### Manual configuration

Everything `cupboard github setup` writes can be written by hand; this section
is for doing that, or for understanding exactly what the command wrote. Set one
more variable first, the reusable workflow reference the trust rules pin:

```bash
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/$cupboard_version
```

The `workflow` value is matched, character for character, against the
`job_workflow_ref` claim in the OIDC token of every CI push, so its exact shape
matters: it names cupboard's repository, where the reusable workflow file lives,
not your own, and it spells the ref in full as `refs/tags/vX.Y.Z` even though
your caller workflow references the same file as `@vX.Y.Z`. Changing either
part, or pinning a different release from the caller's, produces a trust rule
that can never match, and every push is then refused. See
[docs/trust-rules.md](./trust-rules.md) for how the claim works.

On the tenant, give every cache a retention grace period, define a view over the
PR caches, and trust this repository's PR and `main` runs when they use
cupboard's reusable workflow:

```bash
cupboard policy add-grace "$tenant" --cache-prefix '' --grace 24h

cupboard reuse-view set "$tenant" pull-requests \
  --prefix pr- --priority 50

cupboard oidc-trust add-github-pr "$tenant" \
  --repo "$repo" \
  --job-workflow-ref "$workflow"

cupboard oidc-trust add-github-branch "$tenant" \
  --repo "$repo" --branch main \
  --job-workflow-ref "$workflow"
```

The empty grace prefix covers the default cache and every named cache, including
the per-PR caches. The grace period must be long enough for the workflow's plan
and cohort jobs to finish.

The view's priority of 50 sits above the destination cache's priority, which
defaults to 40 on the server; Nix tries substituters lowest-priority-first, so
this keeps the destination preferred. 50 is also the CLI's default, spelled out
here because the relationship, view strictly above destination, is required:
setup refuses a view that would tie or precede the destination.

The trust commands resolve and pin the repository's immutable GitHub ids. The PR
rule confines each pull request to its own cache and root; the branch rule
confines `main` to the tenant's default cache and its own root prefix.

On the repository side, the tenant URL, release pin and runner labels are
ordinary values in files the operator owns: the caller workflow and the flake
manifest. Where jobs run is the operator's choice, like any other workflow;
repositories with self-hosted runners should read
[docs/runner-provenance.md](./runner-provenance.md) before pointing cupboard
jobs at them.

## `actions/setup`

`actions/setup` installs the cupboard binary and can export Nix binary cache
configuration for later steps.

```yaml
permissions:
  attestations: read
  contents: read

steps:
  - uses: actions/checkout@v6
  - uses: owner/repo/actions/setup@v1
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
      trusted-public-key: cupboard-1:...
```

The action outputs `cupboard-path`, `cupboard-version`, and, when Nix config is
generated, `nix-config-file`.

Generated Nix config is written under `$RUNNER_TEMP` and exported through
`NIX_CONFIG`. The action does not mutate `/etc/nix/nix.conf`. If
`nix-config-file` is supplied, the generated config is also appended to that
file.

If `trusted-public-key` is omitted, setup fetches `/pubkey` from the cache URL
and trusts that cache signing key for this run. This is trust-on-first-use only
for the cache signing key. The cupboard binary trust path is the release
checksum plus `gh attestation verify`, scoped to the release repository and
source tag.

For private reads, provide `read-user` and `read-password`. The action writes a
private netrc file under `$RUNNER_TEMP`, sets mode `0600`, appends
`netrc-file = ...` to the generated Nix config, and never echoes the password.

`reuse-view` adds a named tenant reuse view as a second substituter, after the
destination cache. Setup verifies the two priorities keep the destination first;
see [docs/reuse-views.md](./reuse-views.md) for the ordering rules.

## `actions/push`

`actions/push` installs cupboard if needed, resolves the supplied paths with
`nix path-info`, and pushes them with GitHub OIDC authentication.

```yaml
permissions:
  attestations: read
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - run: nix build .#package
  - uses: owner/repo/actions/push@v1
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: |
        ./result
```

The action outputs `cupboard-path` and `cupboard-version`.

`paths` is newline-delimited. Use block scalar YAML for paths so spaces and
other shell-sensitive characters are not reinterpreted. The helper validates and
resolves each entry through Nix; it does not use GNU-only path resolution such
as `readlink -f`, so macOS is first-class.

The default OIDC audience is the `url` input. The default retention root is
`github:${{ github.repository }}/${{ github.ref_name }}`. `wait` defaults to
`true` and `wait-timeout` defaults to `10m`.

Attestation bundle paths are also newline-delimited. They attach a bundle that
already exists; `actions/attest` below produces one with the right subjects:

```yaml
- uses: owner/repo/actions/push@v1
  with:
    url: https://cupboard.example.workers.dev/t/<slug>
    paths: |
      ./result
    attestations: |
      ./dist/result.intoto.jsonl
```

## `actions/build-paths` and `actions/attest`

`actions/push` attaches a bundle but does not create one. cupboard files a
bundle against a store path only when the bundle's in-toto subject digest equals
that path's NAR hash. An attestation built over a file's own digest, which is
what `actions/attest-build-provenance` records by default, therefore does not
match. `actions/build-paths` builds the requested installables and writes a
current-run receipt recording which final outputs Nix actually built. The attest
action verifies those paths and NAR hashes against the live store, then signs a
single SLSA build-provenance attestation over them.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - id: build
    uses: owner/repo/actions/build-paths@v1
    with:
      installables: .#package
  - id: attest
    uses: owner/repo/actions/attest@v1
    with:
      receipt-file: ${{ steps.build.outputs.receipt-file }}
```

`installables` is newline-delimited. Generated lists can instead be written to a
newline-delimited file and passed as `installables-file`, which avoids runner
limits on the size of action inputs and environment variables. The build action
retries three times and outputs the realised `paths`, a `paths-file`, and the
`receipt-file` consumed by the attest action. A path substituted from a cache or
already present from an earlier run is not recorded as built. Outputs returned
by a remote builder are rebuilt and compared with `nix build --rebuild` before
they qualify. When no path qualifies, nothing is signed and `bundle-path` is
empty, which `actions/push` accepts as no attestations.

The action outputs `bundle-path`, the signed bundle covering every qualifying
path, alongside `checksums-file` and `subject-count`. `id-token: write` lets the
action obtain its Sigstore signing certificate, and `attestations: write`
records the attestation on the repository.

Because the bundle carries every attested path as a subject, a later
`cupboard push` files it against each matching path in the pushed closure.

## Build, attest, and push

The three actions compose into one job: install cupboard and export read
configuration, build the outputs, attest them, then push the outputs with the
bundle attached.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - uses: owner/repo/actions/setup@v1
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
  - id: build
    uses: owner/repo/actions/build-paths@v1
    with:
      installables: .#package
  - id: attest
    uses: owner/repo/actions/attest@v1
    with:
      receipt-file: ${{ steps.build.outputs.receipt-file }}
  - uses: owner/repo/actions/push@v1
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: ${{ steps.build.outputs.paths }}
      attestations: ${{ steps.attest.outputs.bundle-path }}
```

`setup` adds the cache as a substituter, `build-paths` records what this run
built, `attest` signs those paths' NAR hashes, and `push` uploads the paths and
files the bundle against them. Pushing needs a trust rule on the tenant that
accepts this repository's GitHub Actions token, added with
`cupboard oidc-trust`; see [docs/trust-rules.md](./trust-rules.md).

## The reusable workflow

`cupboard-publish.yml` wraps that whole job into one reusable workflow. It
installs Nix, configures the cache as a substituter, builds a flake output,
signs provenance for it, and pushes the result. To use it, add a job that
references the workflow and says where the build should go:

```yaml
jobs:
  publish:
    if: github.event_name == 'pull_request'
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main
    with:
      url: https://cupboard.example.workers.dev/t/acme
      cache: pr-${{ github.event.pull_request.number }}
      root: github:acme/app/pr-${{ github.event.pull_request.number }}
      ttl: 14d
```

`cache`, `root`, and `ttl` say where the paths land and how long they are kept.
In this example every pull request publishes to its own `pr-<number>` cache, and
the pushed paths expire two weeks after the last push. A cache is created the
first time something is pushed to it, so per-PR and per-release caches need no
setup step.

The workflow appends the builder's Nix system to `root`, so this example retains
under `github:acme/app/pr-7/x86_64-linux`. A root holds a single build: pushing
to it again replaces what it retains. Appending the system keeps platforms out
of each other's way, so a Linux build and a macOS build of the same pull request
each stay retained under their own root.

The remaining inputs: `installable` picks what to build (the default is `.`, the
flake at the repository root), `attest` turns provenance signing off for tenants
that do not accept it, `runs-on` picks the runner, and `trusted-public-key` and
`cupboard-version` pass through to `actions/setup`.

This workflow tracks `main`: callers reference it at `@main`, it fetches its own
action code from `main`, and a trust rule that pins its `job_workflow_ref` names
the file at `refs/heads/main`. The release-tag pinning in
[docs/trust-rules.md](./trust-rules.md) belongs to `cupboard-flake-publish.yml`.

### Publishing a target manifest

`cupboard-flake-publish.yml` publishes a set of flake outputs while avoiding
work the cache already holds. Its `targets` input names a flake output that
evaluates to a list. Construct each entry from the derivation as well as its
installable string, so one manifest evaluation produces the exact mapping the
planner needs:

```nix
let
  mkTarget = target @ {
    derivation,
    bestEffort ? false,
    ...
  }: let
    attemptedDrvPath = builtins.tryEval derivation.drvPath;
    resolvedDrvPath =
      if bestEffort
      then attemptedDrvPath
      else {
        success = true;
        value = derivation.drvPath;
      };
  in
    (builtins.removeAttrs target ["derivation"])
    // {
      inherit bestEffort;
    }
    // (
      if resolvedDrvPath.success
      then {rootDrvPath = resolvedDrvPath.value;}
      else {}
    );
in [
  (mkTarget {
    attr = ".#packages.x86_64-linux.server";
    derivation = packages.x86_64-linux.server;
    system = "x86_64-linux";
    os = "ubuntu-latest";
    remote = true;
    rootSuffix = "x86_64-linux/server";
  })
  (mkTarget {
    attr = ".#darwinConfigurations.laptop.system";
    derivation = darwinConfigurations.laptop.system;
    system = "aarch64-darwin";
    os = "macos-latest";
    remote = false;
    bestEffort = true;
    rootSuffix = "aarch64-darwin/darwin-laptop";
    outputs = ["out"];
  })
]
```

`rootDrvPath` must be a derivation path for strict targets. The helper evaluates
those directly, preserving Nix's error when one cannot be evaluated. It catches
a best-effort target's evaluation failure and omits the field; the planner then
sends that target to a direct build, where its own job reports the full error.
When `push` is false, the workflow removes every `rootDrvPath` without forcing
it, preserving build-only mode's lack of derivation inspection.

`outputs` defaults to `["out"]` and `bestEffort` to `false`. A best-effort
target does not fail the whole matrix when its build fails. `os` selects the
runner label the target's jobs run on; the manifest is the operator's flake, so
runner choice is operator configuration
([docs/runner-provenance.md](./runner-provenance.md) covers self-hosted
estates). `remote` marks a group that realises its derivations on the configured
remote builders: those jobs build with `--max-jobs 0` and apply the `builders`
specification, the `builder_ssh_key` and `builder_ssh_config` secrets, and the
`builder-known-hosts` input.

Call the workflow with the cache and root prefix for the current event:

```yaml
jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/acme
      targets: .#cupboardOutputs
      cache: pr-${{ github.event.pull_request.number }}
      root-prefix: github:acme/app/pr-${{ github.event.pull_request.number }}
      ttl: 14d
      cupboard-version: vX.Y.Z
      nix-config: .#nix.substituterConfig
      builders: ssh://builds.example.com x86_64-linux,aarch64-linux - 100 1
    secrets:
      builder_ssh_key: ${{ secrets.BUILDER_SSH_KEY }}
      input_ssh_key: ${{ secrets.FLAKE_INPUT_SSH_KEY }}
```

Any builder Nix can reach over SSH works. `builder_ssh_config` carries per-host
connection settings as ssh_config Host blocks, and it is a secret so
authentication material may appear in it. nixbuild.net's auth tokens, for
example, travel in the SSH connection environment:

```yaml
secrets:
  builder_ssh_config: |
    Host eu.nixbuild.net
      User authtoken
      PreferredAuthentications none
      SetEnv NIXBUILDNET_TOKEN=${{ secrets.NIXBUILD_TOKEN }}
```

For a tenant whose reads are private, also pass `read_user` and `read_password`
as workflow secrets. `actions/setup`'s netrc file only covers Nix's own
substituter reads, so the plan job's own cache probes need the same credentials
passed through separately: `actions/plan` accepts them as
`read-user`/`read-password` and sends them as an HTTP `Authorization: Basic`
header on every narinfo probe.

The plan first asks cupboard to retain each target whose output paths are
already servable, then prunes what it can through an advisory pre-filter against
the destination: a cohort whose targets are all already covered spawns no job at
all. Every surviving cohort gets its own job in the cohort matrix. A cohort is
one target by default; the manifest opts a group of targets into one cohort with
a shared `cohort` label, so a multi-target cohort shares one job and one
`nix build` invocation rather than fanning out further.

Each cohort job computes its own availability partition and capacity check
against its own store, independently of the plan's advisory pre-filter: which
targets are already served and only need attaching, which the tenant already
holds elsewhere and can be published by reference through the reuse view, which
an upstream substituter already serves and are deliberately left there, and
which must actually build. Only the last group reaches `nix build --keep-going`,
and the job keeps its out-links until the push completes, so nothing collects
the built closure out from under it in the meantime. The push that follows
publishes the targets (built or attached) and any further built outputs that are
not a target's own output, references the publish-by-reference paths from the
reuse view, and establishes each target's own retention root; the left-upstream
paths are not pushed at all; they stay served from the reuse view or the
upstream substituter, and the cohort's own counts and left-upstream files record
that choice. A target that shares a dependency with another cohort simply builds
it again; Nix substitutes it from the destination cache once a prior cohort's
push has made it available there, or from the per-run root described below
sooner than that.

Every cohort job's push also joins one retention root shared for the whole run,
with a TTL set by `run-root-ttl` (default `24h`), so a cohort's shared output
stays reachable for the rest of the run even before its own target root is
established: a later cohort can substitute it there instead of rebuilding it.
Cohort jobs do not yet attest their builds; `build-cohort` has no
build-provenance receipt to give `actions/attest` the way `build-paths` does, so
a cohort's push carries no attestation bundle until that lands.

`reuse-view` opts the run into reading shared intermediates through a named
tenant reuse view when the destination is missing them; see
[docs/reuse-views.md](./reuse-views.md). Empty, the default, keeps planning and
substitution destination-only.

`cupboard-version` pins the CLI release the jobs install, and `maximise-space`
(default `false`) reclaims runner disk space before building by deleting
preinstalled software from the runner image; opt in only on ephemeral
GitHub-hosted runners, since the reclamation is destructive and permanent on a
self-hosted machine.

The workflow accepts `push: false` for a build-only validation run. In that mode
it does not inspect the cache or derivation graph, and every cohort builds its
targets directly without publishing them.

### Building against a remote store

A `store` input naming an `ssh-ng://` store URI hands the whole cohort to that
store. The plan partitions availability with the remote store's own answers, the
build runs `nix build --store <uri> --eval-store auto` so the results land on
the remote store while evaluation stays on the runner, and the push reads path
metadata and streams NAR bytes from the same store. The built closure is never
copied into the runner's local store, so the runner's disk is bounded by
evaluation, not by the size of the closure being built.

Upload timing differs from a local build: the remote store reports its exact
build results when the build completes, so upload starts after result discovery
rather than overlapping the build.

Because the paths never touch the runner's filesystem, the plan skips the local
store-capacity preflight and records `capacity: {"skipped": "remote-store"}` in
its plan file: ssh cannot measure the remote filesystem, and a remote store is
itself the deployment answer to a runner whose disk cannot hold the build.

### Component publication for aggregate targets

A NixOS system or a home-manager profile is a `buildEnv` over its packages: one
target whose input closure can exceed a runner's disk even though every package
in it is ordinary. A manifest target opts out of building that aggregate at all
by declaring `components` instead:

```nix
{
  attr = ".#nixosConfigurations.server.config.system.build.toplevel";
  system = "x86_64-linux";
  os = "ubuntu-latest";
  remote = false;
  rootSuffix = "x86_64-linux/server";
  components = [
    { attr = ".#nixosConfigurations.server.config.system.build.toplevel.foo"; }
    { attr = ".#nixosConfigurations.server.config.system.build.toplevel.bar"; }
  ];
}
```

With `components` present, cupboard never evaluates, queries, or builds the
aggregate's own `attr`: each component is published as its own target instead,
so the runner's peak disk use falls from the whole environment's closure to the
largest component's own input closure. Every component publishes under the
aggregate's own `rootSuffix`, one retention root whose target list is every
component's path; a manifest declaring more components than a root accepts in
one write (1000) is refused before anything builds, since paging that write
would lose the all-or-nothing property retention depends on. Components inherit
the aggregate's system, os, remote, best-effort flag and cohort label, so by
default each is its own cohort and its own job, and a shared `cohort` label on
the aggregate groups them into one job exactly as it would for ordinary targets.

The machine that activates the environment (a NixOS host running
`nixos-rebuild switch`, a home-manager user running `home-manager switch`)
substitutes the components from the cache and assembles the aggregate locally.
cupboard never builds or attests the aggregate, because it was never realised
here; each component is an ordinary cohort target otherwise, subject to the same
attestation gap [described above](#publishing-a-target-manifest).

## Common tasks

Routine changes to a working setup, and where each one's state lives.

### Move to a new cupboard release

Rules pinned to a tag pattern (`@refs/tags/v*`) already cover the new release.
Run `github check` with the exact new tag before updating the caller's `uses:`
reference and `cupboard-version` input:

```bash
new_cupboard_version=vA.B.C
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml

cupboard github check "$tenant" --repo "$repo" \
  --root-prefix "github:$repo/main" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
```

Check models GitHub's default `sub` claim forms. Workflows using an environment
or an organisation or repository custom subject template are not currently
supported by this check.

For rules pinned to an exact release, establish the new trust before changing
the caller:

```bash
new_cupboard_version=vA.B.C
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml

cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
cupboard github check "$tenant" --repo "$repo" \
  --root-prefix "github:$repo/main" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
```

Setup recognises rules pinned to a different exact workflow reference as
superseded and safe to retain, even when an older release used different claims
or grants. It verifies that each retained release reference still resolves on
GitHub, installs the new rules, then offers the superseded rules for optional
removal. A superseded rule whose reference is not pinned to a release is
retained too, flagged in the report because it trusts future edits to the
workflow. Leave superseded rules unselected while runs using the old reference
can still be active. Check then proves that a run carrying the new reference can
obtain every grant it needs while the old caller still works.

Update the caller workflow's `uses:` reference and `cupboard-version` input to
`$new_cupboard_version`. Once runs using the old reference have finished, run
setup again and select the superseded rules for removal:

```bash
cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
```

Rules that can also match the new workflow token are conflicts, not superseded
rules. Setup asks for one confirmation covering every conflict before it changes
anything; declining leaves the tenant unchanged, and `--yes` confirms an
unattended run. A rule pinning claims setup cannot check (an `environment` pin,
say) might not match the new token, so it is never removed unattended: setup
retains it, reports it as possibly conflicting, and offers it for removal only
interactively. Repeat any non-default `--branch` or `--grace` values on both
setup calls.

### Add a target or a platform

Add the entry to the flake's `cupboardOutputs` list, naming the runner label its
jobs should use as `os`. No tenant change is needed: caches are created on first
push, and the existing root-prefix grant covers the new target's root.

### Add another repository to the same tenant

The tenant-wide grace policy and the `pull-requests` view already cover any
number of repositories. Run quickstart step 2's `cupboard github setup` for the
new repository: it adds that repository's trust rules and reports the shared
tenant state as unchanged. The equivalent individual commands are in
[Manual configuration](#manual-configuration).

### Tighten or audit a trust rule

`cupboard oidc-trust list "$tenant"` prints every rule with its claims and
grants. Rules are immutable: to change one, add the corrected rule and remove
the old one. What each claim pins, and how to restrict a rule further, is
[docs/trust-rules.md](./trust-rules.md).

### A `main` run rebuilt something a PR already built

Check, in order: the run passed `reuse-view` (the quickstart's caller sets it
for `push` events only); the PR's cache still exists and still matches the
view's `pr-` prefix; the PR actually published the path (its own run's target
jobs succeeded); and the grace or TTL window has not lapsed. If several PR
caches hold semantically different results for the same path, the view answers
with a miss on purpose and the run builds locally;
[docs/reuse-views.md](./reuse-views.md) explains that conflict rule.
