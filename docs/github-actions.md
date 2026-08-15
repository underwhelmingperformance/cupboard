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

## Version selection

The standalone setup and push actions accept `cupboard-version`. The default is
`latest`.

- `latest` resolves to the newest published release of any kind, prereleases
  included, because `include-prereleases` defaults to `true`. With
  `include-prereleases: false` it resolves through GitHub's [latest release
  endpoint][github-latest-release], which selects the latest non-prerelease,
  non-draft release.
- `1.2.3` first resolves the literal `1.2.3` tag. If it has no published
  release, the actions try the legacy `v1.2.3` spelling.
- `v1.2.3` is used as-is and resolved by tag.

The current actions require release `v0.0.19` or newer, the first release whose
archive includes the `cupboard-hook-relay` runtime helper. Older semver releases
are rejected before their assets are downloaded. Arbitrary non-semver tags
remain supported and are validated from their downloaded archive contents.

The reusable workflows make `cupboard-version` optional. Call them through an
immutable published release tag such as `v1.2.3`, and they select the release at
that tag. They verify that the release points to the workflow's commit before
installing it.

A workflow pinned by commit SHA can also omit `cupboard-version`. It selects a
release published for that commit, or builds cupboard from the immutable
workflow checkout if no release exists. When several releases point to the same
commit, the resolver selects the lexicographically first tag.

Pass an exact tag or `latest` only when deliberately selecting a released CLI
independently of the workflow code. Once a release is selected, checksum,
attestation, tag and source-commit verification are fail-closed; a broken
release never falls back to source.

For routine release updates, pin the caller to an immutable release tag and
configure its tenant trust rule once with `refs/tags/v*`. Updating the tag in
the caller then upgrades the workflow code and CLI together without another
tenant change. A tenant can instead trust one full commit SHA at a time when an
administrator must approve every workflow revision. Release API calls use the
workflow token, which also avoids unnecessary rate-limit failures for public
repositories.

The reusable workflows require GitHub Cloud. They fail before checkout on GitHub
Enterprise Server because GHES does not expose the `job.workflow_*` identity
fields needed to fetch and verify the called workflow's exact source. This
restriction is at the reusable-workflow boundary; the lower-level resolver still
accepts explicit API endpoints and workflow identity inputs.

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
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml
```

Choose an immutable cupboard release from the [releases page][] and replace
`vX.Y.Z` with its tag before continuing.

[releases page]: https://github.com/underwhelmingperformance/cupboard/releases

### 2. Configure the tenant

One idempotent command writes everything the runs depend on: a 24-hour retention
grace period for every cache, the `pull-requests` reuse view over the per-PR
caches, and trust rules for this repository's PR and `main` runs:

```bash
cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "$workflow@refs/tags/v*"
```

The `--workflow-ref` pattern allows this workflow at any `v*` release tag. The
caller still selects one immutable release, and the workflow verifies that its
release and source commit agree before installation. The pattern makes
cupboard's release publishers part of the tenant's trust boundary, but it needs
to be configured only once.

Re-running converges state that already matches. A different grace policy or
reuse view is reported as drift and never replaced. The tag-pattern trust rules
already cover later matching releases. What each piece of this configuration is,
and the commands to write it by hand, are under
[Manual configuration](#manual-configuration).

One consequence deserves calling out before running it: the grace policy changes
how the covered caches are collected, permanently. The first publication
accepted under it marks its cache grace-managed, `policy remove-grace` does not
unmark it, and a grace-managed cache whose last deadline lapses may be emptied
by collection, which a cache without the marker never is.

### 3. Declare the targets

Expose a `cupboardOutputs` attribute from the flake. Each entry identifies an
installable and includes its derivation path, Nix system, permitted GitHub
runner label, and the suffix for the workflow's retention-root prefix:

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
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    with:
      # The tenant URL is an ordinary value in this file; edit it here.
      url: https://cupboard.example.workers.dev/t/acme
      targets: .#cupboardOutputs
      preset: pull-request-and-branch
      reuse-view: pull-requests
```

The preset derives the cache, root prefix, and TTL from the triggering event. A
`pull_request` run uses a `pr-<number>` cache with a 14-day TTL. The PR trust
rule grants access to that cache and its retention root. A run whose ref matches
the configured `branch` uses the default cache, permanent retention under
`github:<repository>/<branch>`, and the reuse view.

`branch` defaults to `main` and must match the value passed to
`cupboard github setup --branch`. The configure job rejects another ref before
planning or building. The preset therefore applies `reuse-view` only to trusted
branch runs: `main` can adopt PR builds, while each PR reads only from its own
destination. A repository with another cache or root layout can pass `cache`,
`root-prefix`, and `ttl` explicitly. These inputs are mutually exclusive with
the preset. Pinning the workflow to one release tag upgrades its action code and
CLI together and prevents an unreviewed cupboard change from altering CI.
[Move to a new cupboard release](#move-to-a-new-cupboard-release) describes the
update.

### 5. Verify the setup

Check the invariants the first run depends on before opening a pull request:

```bash
cupboard github check "$tenant" --repo "$repo" \
  --root-prefix "github:$repo/main" \
  --workflow-ref "$workflow@refs/tags/$cupboard_version"
```

The check requires the exact release tag used by the caller. It uses GitHub to
verify that the tag belongs to an immutable published release and contains the
workflow. It then constructs the expected claims from the repository, branch,
and workflow reference and evaluates the stored trust rules against them. This
detects a misspelt workflow path or release before the first run. It also checks
that the tag-pattern rule accepts the reference and that every matched rule
grants access to the requested caches and roots.

The check fails if only an interactive administrator rule matches, even when
that rule's wildcard grant would allow the operations. It does not inspect the
caller workflow, so the supplied reference must still match the caller's `uses`
line. The check also verifies grace-policy coverage and duration, the reuse
view's effective priority over the destination, and whether the root prefix is
within the grant. If an input is missing for a check, such as `--root-prefix`,
the command reports the unchecked invariant and returns a non-success status.

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
trusted_workflow="$workflow@refs/tags/v*"
```

The `trusted_workflow` value produces an anchored pattern for the
`job_workflow_ref` claim in every CI push's OIDC token. It refers to cupboard's
repository, where the reusable workflow file lives, and admits only `v*` release
tags. See [docs/trust-rules.md](./trust-rules.md) for how the claim works.

On the tenant, give every cache a retention grace period, define a view over the
PR caches, and trust this repository's PR and `main` runs when they use
cupboard's reusable workflow:

```bash
cupboard policy add-grace "$tenant" --cache-prefix '' --grace 24h

cupboard reuse-view set "$tenant" pull-requests \
  --prefix pr- --priority 50

cupboard oidc-trust add-github-pr "$tenant" \
  --repo "$repo" \
  --job-workflow-ref "$trusted_workflow"

cupboard oidc-trust add-github-branch "$tenant" \
  --repo "$repo" --branch main \
  --job-workflow-ref "$trusted_workflow"
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
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: owner/repo/actions/setup@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
      trusted-public-key: cupboard-1:...
```

The action outputs `cupboard-path`, the canonical `cupboard` coordinate, and the
resolved release tag as `cupboard-version`. When it generates Nix configuration,
it also outputs `nix-config-file`. `cupboard-version` is empty for a source
build; `cupboard` identifies the acquisition in both source and release modes.

Reusable workflows pass a canonical release-or-source JSON coordinate through
the `cupboard` input. Direct action callers normally leave that internal
coordinate unset and select a released binary with `cupboard-version` instead.

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
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - run: nix build .#package
  - uses: owner/repo/actions/push@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: |
        ./result
```

The action outputs `cupboard-path` and the inspected `cupboard-version`. Pass
the path to another cupboard action to reuse the already-installed executable.
It also reports `uploaded-paths`, `reused-blobs`, `skipped-paths`, and
`uploaded-bytes` from the completed push.

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
- uses: owner/repo/actions/push@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
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
current-run receipt recording which final outputs Nix actually built. After
publication, the attest action verifies those paths and NAR hashes against the
destination's committed narinfos, then signs a single SLSA build-provenance
attestation over them.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - id: setup
    uses: owner/repo/actions/setup@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
  - id: build
    uses: owner/repo/actions/build-paths@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      installables: .#package
  - id: push
    uses: owner/repo/actions/push@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: ${{ steps.build.outputs.paths }}
      cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
  - id: attest
    uses: owner/repo/actions/attest@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      receipt-file: ${{ steps.build.outputs.receipt-file }}
      url: https://cupboard.example.workers.dev/t/<slug>
  - uses: owner/repo/actions/attest-attach@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    if: ${{ steps.attest.outputs.bundle-path != '' }}
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
      receipt-file: ${{ steps.build.outputs.receipt-file }}
      checksums-file: ${{ steps.attest.outputs.checksums-file }}
      bundle: ${{ steps.attest.outputs.bundle-path }}
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

Set `require-provenance` when publication must not succeed without provenance
for every final output. If a final output came from a cache or was already
present, the action rebuilds that final derivation on the selected build store
before adding it to the receipt; its dependencies may still be substituted. This
is useful when a failed signing or attachment step will be retried after the
path was pushed.

The action outputs `bundle-path`, the signed bundle covering every qualifying
path, alongside `checksums-file` and `subject-count`. `id-token: write` lets the
action obtain its Sigstore signing certificate, and `attestations: write`
records the attestation on the repository.

Publication comes before signing because the attest action verifies every
receipt subject against the destination's committed narinfo. The attach action
then files the signed bundle against each matching path in that same receipt.

## Build, publish, and attest

The actions compose into one job: install cupboard and export read
configuration, build and publish the outputs, verify and sign the committed
subjects, then attach the bundle.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - id: setup
    uses: owner/repo/actions/setup@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
  - id: build
    uses: owner/repo/actions/build-paths@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      installables: .#package
  - id: push
    uses: owner/repo/actions/push@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: ${{ steps.build.outputs.paths }}
      cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
  - id: attest
    uses: owner/repo/actions/attest@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    with:
      receipt-file: ${{ steps.build.outputs.receipt-file }}
      url: https://cupboard.example.workers.dev/t/<slug>
  - uses: owner/repo/actions/attest-attach@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    if: ${{ steps.attest.outputs.bundle-path != '' }}
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
      receipt-file: ${{ steps.build.outputs.receipt-file }}
      checksums-file: ${{ steps.attest.outputs.checksums-file }}
      bundle: ${{ steps.attest.outputs.bundle-path }}
```

`setup` adds the cache as a substituter, `build-paths` records what this run
built, `push` commits the paths, `attest` verifies and signs those paths' NAR
hashes, and `attest-attach` files the bundle against them. Pushing needs a trust
rule on the tenant that accepts this repository's GitHub Actions token, added
with `cupboard oidc-trust`; see [docs/trust-rules.md](./trust-rules.md).

## The reusable workflow

`cupboard-publish.yml` wraps that whole job into one reusable workflow. It
installs Nix, configures the cache as a substituter, builds a flake output,
pushes the result, verifies and signs its committed narinfos, then attaches the
provenance. To use it, add a job that references the workflow and says where the
build should go:

```yaml
jobs:
  publish:
    if: github.event_name == 'pull_request'
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@vX.Y.Z
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
under `github:acme/app/pr-7/x86_64-linux`. A root retains a single build; a
later push replaces its paths. Appending the system keeps platforms out of each
other's way, so a Linux build and a macOS build of the same pull request each
stay retained under their own root.

The remaining inputs: `installable` picks what to build (the default is `.`, the
flake at the repository root), `attest` turns provenance signing off for tenants
that do not accept it, `runs-on` picks the runner, and `trusted-public-key`
configures the substituter. `cupboard-version` is an optional explicit release
override; normally the workflow derives cupboard from its own pin. When `attest`
is enabled, the workflow requires provenance for every final output. A target
the cache already serves is left unbuilt only when the cache also holds an
attestation for its output path. Every other final derivation is rebuilt locally
before the workflow signs it, while its dependencies may still substitute. A
rerun after a failed signing or attachment step therefore builds the output
again and attaches the provenance that is missing, instead of finishing with an
empty receipt.

Pin this workflow to an immutable published release tag. With no explicit
`cupboard-version`, the workflow selects that release and verifies its source
commit and provenance before installation. A `refs/tags/v*` tenant rule can
trust this workflow across routine release updates.

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
target does not fail the whole matrix when its build fails. Targets grouped by
one explicit `cohort` label must agree on `bestEffort`; planning refuses a mixed
group and names both conflicting targets. `os` selects the runner label the
target's jobs run on; the manifest is the operator's flake, so runner choice is
operator configuration ([docs/runner-provenance.md](./runner-provenance.md)
covers self-hosted estates). `remote` marks a group that realises its
derivations on the configured remote builders: those jobs build with
`--max-jobs 0` and apply the `builders` specification, the `builder_ssh_key` and
`builder_ssh_config` secrets, and the `builder-known-hosts` input.

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
      nix-config: .#nix.substituterConfig
      builders: ssh://builds.example.com x86_64-linux,aarch64-linux - 100 1
      builder-known-hosts: |
        builds.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
      input-known-hosts: |
        git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
    secrets:
      builder_ssh_key: ${{ secrets.BUILDER_SSH_KEY }}
      input_ssh_key: ${{ secrets.FLAKE_INPUT_SSH_KEY }}
```

Any builder that Nix can reach directly over SSH works. `builder_ssh_config`
provides per-host connection settings as ssh_config `Host` blocks. It is a
secret because an allowlisted `SetEnv` directive may contain a token. The
allowlist covers endpoints, transport tuning, algorithms, liveness settings, and
`SetEnv`. It rejects commands, proxies, forwarding, identity sources,
multiplexing, verbose logging, `Include`, and `Match`. Supply the private key
only through `builder_ssh_key`. For example, nixbuild.net passes authentication
tokens in the SSH connection environment:

```yaml
secrets:
  builder_ssh_config: |
    Host eu.nixbuild.net
      User authtoken
      PreferredAuthentications none
      SetEnv NIXBUILDNET_TOKEN=${{ secrets.NIXBUILD_TOKEN }}
```

Keep the builders specification on one line and separate multiple builders with
semicolons. Put `-` in the third, SSH-key column, and do not set a non-empty
`ssh-key` parameter in a builder store URI. Pass the managed private key through
`builder_ssh_key`. This prevents a builder entry from adding another identity or
selecting the private-flake key by its runner path.

Host-key verification is mandatory for every enabled builder. Put each builder's
public host key in `builder-known-hosts`; use OpenSSH's `[host]:port` form when
a builder uses a nonstandard port. The host-key lines are not secret.

Private flake inputs use an independent SSH identity and host-key file. Whenever
`input_ssh_key` is supplied, `input-known-hosts` must pin every Git host that
can serve those inputs. The generated Git SSH command ignores user and global
known-hosts sources, accepts only those pins and offers only the input key;
input credentials and pins never enter the builder or direct-store
configuration.

For a tenant whose reads are private, also pass `read_user` and `read_password`
as workflow secrets. `actions/setup`'s netrc file only covers Nix's own
substituter reads, so the plan job's own cache probes need the same credentials
passed through separately: `actions/plan` accepts them as
`read-user`/`read-password` and sends them as an HTTP `Authorization: Basic`
header on every narinfo probe.

The plan first retains targets whose output paths are already available from
cupboard. It then applies an advisory destination pre-filter. When that filter
covers every target in a cohort, the workflow omits the cohort job. Every
remaining cohort receives one matrix job. A cohort contains one target by
default. Assign the same `cohort` label to several targets to build them in one
job with one `nix build` invocation.

Each cohort job repeats the availability partition and capacity check against
its selected store. This result is authoritative even if the advisory pre-filter
is stale. The partition separates targets into four groups:

- already in the destination and needing only retention;
- present elsewhere in the tenant and publishable by reference through the reuse
  view;
- available from an upstream substituter and deliberately left there;
- requiring a build.

Only the final group reaches `nix build --keep-going`. The job keeps its
out-links until publication finishes so the store cannot collect the built
closure. It publishes built targets, retained targets, and any additional built
outputs. It publishes reuse-view paths by reference and sets each target's
retention root. Upstream paths are not copied into cupboard; the cohort records
them in its counts and left-upstream files.

When cohorts share a dependency, each cohort still requests it. Nix substitutes
the dependency after an earlier cohort publishes it to the destination or
retains it under the per-run root. Every cohort contributes to this shared root,
whose TTL is set by `run-root-ttl` and defaults to `24h`. This keeps shared
outputs available throughout the run, even before their target roots are set.
Cohort jobs write a build receipt, verify its subjects against the committed
destination, sign those accepted subjects, and attach the resulting provenance
bundle after publication. A substituted or already-valid path may be published
and retained, but it is not claimed as work performed by this invocation.

`reuse-view` opts the run into reading shared intermediates through a named
tenant reuse view when the destination is missing them; see
[docs/reuse-views.md](./reuse-views.md). Empty, the default, keeps planning and
substitution destination-only.

`cupboard-version` optionally overrides the CLI derived from the workflow pin.
`maximise-space` (default `false`) reclaims runner disk space before building by
deleting preinstalled software from the runner image; opt in only on ephemeral
GitHub-hosted runners, since the reclamation is destructive and permanent on a
self-hosted machine.

The workflow accepts `push: false` for a build-only validation run. In that mode
it does not inspect the cache or derivation graph, and every cohort builds its
targets directly without publishing them.

### Building against a remote store

A `store` input containing an `ssh-ng://` URI sends the whole cohort to that
store. The plan queries the remote store when it partitions path availability.
For each missing target, the cohort evaluates and materialises the root
derivation locally, verifies that it still matches the planned derivation, and
copies its derivation closure to the selected store. It then builds through
Nix's worker protocol and adds temporary roots for the keyed result outputs.
Before setting the declared retention roots, the workflow streams the outputs'
metadata and NAR bytes into cupboard. The realised closure never enters the
runner's local store, so local disk use is bounded by evaluation and the
derivation closure.

Every selected remote output path must be known during planning. Floating
content-addressed outputs are rejected by the plan and must be built and
published from the local store. Nix 2.34 exposes result discovery and temporary
root creation as separate daemon operations, so a newly discovered output could
otherwise be collected between those operations. Fixed-output and
input-addressed outputs, including multi-output selections, remain supported
when all selected store paths evaluate up front.

Upload timing differs from a local build: the remote store reports its exact
build results when the build completes, so upload starts after result discovery
rather than overlapping the build.

Because the paths never touch the runner's filesystem, the plan skips the local
store-capacity preflight and records `capacity: {"skipped": "remote-store"}` in
its plan file: ssh cannot measure the remote filesystem, and a remote store is
itself the deployment answer to a runner whose disk cannot hold the build.

Direct-store mode and classic `builders` delegation are separate choices and
cannot be enabled together. A selected store keeps its daemon's default build
concurrency; `remote = true` in a manifest only selects `--max-jobs 0` for
classic builders when no `store` input is present.

The workflow exposes store transport credentials independently of builder
scheduling. Pin the host in `store-known-hosts`, put connection options under a
matching `Host` block in the `store_ssh_config` secret, and supply the private
key as `store_ssh_key`:

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
      root-prefix: github:acme/app/main
      store: ssh-ng://nix@store.example.com
      store-known-hosts:
        store.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
    secrets:
      store_ssh_key: ${{ secrets.NIX_STORE_SSH_KEY }}
```

The host-key line is not secret. When the URI selects a nonstandard port, use
OpenSSH's `[host]:port` form. On port 22, the `store` URI may instead use Nix's
`base64-ssh-public-host-key` parameter. A nonstandard port always requires
`store-known-hosts` because native Nix operations do not scope the URI parameter
to `[host]:port`. When the URI supplies the host key, the generated SSH policy
also fixes the port at 22. A later `store-ssh-config` block therefore cannot
redirect the connection outside the key's scope.

The workflow requires one of these host-key pinning mechanisms and never uses
trust on first use. Do not set a non-empty `ssh-key` parameter in the store URI.
Pass the managed private key through `store_ssh_key` so the URI cannot select
another job identity by its runner path. As with builder configuration,
`store_ssh_config` accepts only allowlisted endpoint, transport tuning,
algorithm, liveness, and `SetEnv` settings under `Host` blocks. It rejects
commands, proxies, forwarding, identity sources, multiplexing, `Include`, and
`Match`.

Host-key pinning and client authentication are independent. Without a
`store_ssh_key`, the generated transport fails closed by disabling the runner's
SSH agent and default identity files. An explicitly provisioned self-hosted
runner may instead set `store-ambient-identity: true` to authenticate with its
agent or default files. That opt-in is mutually exclusive with `store_ssh_key`;
do not enable it on a shared runner or one that holds unrelated SSH identities.

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
here; each realised component is an ordinary attested cohort target otherwise.

## Common tasks

Routine changes to a working setup, and where each one's state lives.

### Move to a new cupboard release

When the tenant trusts the workflow at `refs/tags/v*`, check the new immutable
release before updating the caller:

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

Update the caller's `uses:` reference to `$new_cupboard_version`. The existing
tag-pattern trust rule accepts the new workflow token, so the release update
requires no tenant write or administrator credential.

A tenant that deliberately trusts one exact tag or commit instead must run
`github setup` for each release before updating its caller. Keep the previous
rule until runs using that reference have finished, then run setup again to
remove the superseded rule.

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
caches hold semantically different results for the same path, the view returns a
miss and the run builds locally; [docs/reuse-views.md](./reuse-views.md)
explains that conflict rule.
