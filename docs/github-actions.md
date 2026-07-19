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
published. It also keeps shared intermediates through a tenant retention grace
period instead of creating a temporary root for every workflow run.

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

Re-running converges: state that already matches is left untouched, and state
that differs is reported as drift, never replaced. The one additive case is a
rule from an earlier immutable cupboard release whose remaining claims and
grants still match setup's shape; setup keeps that rule and adds the new release
beside it so callers can move without an authority gap. What each piece of this
configuration is, and the commands to write it by hand, are under
[Manual configuration](#manual-configuration).

One consequence deserves calling out before running it: the grace policy changes
how the covered caches are collected, permanently. The first publication
accepted under it marks its cache grace-managed, `policy remove-grace` does not
unmark it, and a grace-managed cache whose last deadline lapses may be emptied
by collection, which a cache without the marker never is.

### 3. Declare the targets

Expose a `cupboardOutputs` attribute from the flake. Each entry names an
installable, its Nix system, its permitted GitHub runner label and the suffix
used beneath the workflow's retention-root prefix:

```nix
cupboardOutputs = [
  {
    attr = ".#packages.x86_64-linux.default";
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
      intermediate-retention: grace
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

The check verifies through GitHub that `--workflow-ref` names a real workflow at
an immutable release tag or full commit, then evaluates the stored trust rules
against claims assembled from the supplied repository, branch and workflow
reference. This catches a misspelt workflow path or release before the first
run, and verifies that each matched rule's stored grants cover the caches and
roots the run requests. It does not inspect the caller workflow, so the supplied
reference must still match its `uses` line. The check also verifies the grace
policy's coverage and duration, the view's priority against the destination's as
actually served, and that the root prefix nests under the granted root. An
invariant it cannot verify with what it was given (no `--root-prefix`, say) is
reported by name and the exit is distinct from success.

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
the per-PR caches. The grace period must be long enough for the workflow's plan,
seed and target jobs to finish; 24 hours matches the reusable workflow's
root-based fallback.

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

`installables` is newline-delimited. The build action retries three times and
outputs the realised `paths`, a `paths-file`, and the `receipt-file` consumed by
the attest action. A path substituted from a cache or already present from an
earlier run is not recorded as built. Outputs returned by a remote builder are
rebuilt and compared with `nix build --rebuild` before they qualify. When no
path qualifies, nothing is signed and `bundle-path` is empty, which
`actions/push` accepts as no attestations.

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
evaluates to a list such as:

```nix
[
  {
    attr = ".#packages.x86_64-linux.server";
    system = "x86_64-linux";
    os = "ubuntu-latest";
    remote = true;
    rootSuffix = "x86_64-linux/server";
  }
  {
    attr = ".#darwinConfigurations.laptop.system";
    system = "aarch64-darwin";
    os = "macos-latest";
    remote = false;
    bestEffort = true;
    rootSuffix = "aarch64-darwin/darwin-laptop";
    outputs = ["out"];
  }
]
```

`outputs` defaults to `["out"]` and `bestEffort` to `false`. A best-effort
target does not fail the whole matrix when its build fails, and one that fails
to evaluate is planned as a direct build, so the failure surfaces in its own
job. `os` selects the runner label the target's jobs run on; the manifest is the
operator's flake, so runner choice is operator configuration
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
already servable. Those targets get no runner job. For the remaining targets,
Nix's derivation JSON identifies outputs referenced by more than one target. An
uncached shared output is built and pushed once before the target matrix fans
out. Paths already served by cupboard are not seeded.

Most output-addressed derivations expose their store path during evaluation.
When Nix deliberately leaves a shared output path unknown, the planner groups
the affected targets on one runner so Nix realises that derivation once. Their
normal target jobs then substitute the result from cupboard and establish the
individual retention roots. This fallback is based on the derivation graph; it
does not guess from changed source files or attribute names. Like seeding, the
grouped build is best-effort: when it fails, each affected target's own job
retries the work and reports its own result.

`intermediate-retention` chooses how the seed and fallback jobs keep the shared
outputs they publish. The default, `root`, is today's behaviour: each shared
output gets a temporary `_cupboard-seed/<run id>/<key>` root with a 24-hour TTL
that simply expires; nothing removes it earlier once the run's target jobs have
substituted the output. The opt-in `grace` instead publishes seed and fallback
intermediates with no retention root at all, relying on the destination cache's
own retention grace policy to keep them alive long enough for the target jobs to
substitute; the plan job also refreshes the grace deadline of any shared output
the destination already holds. This requires a matching policy on the
destination cache first (`cupboard policy add-grace`), and the run fails closed:
it stops the job if a published or already-cached intermediate has no positive
grace deadline, rather than risk the target jobs substituting from bytes that
could be collected before they run.

The plan job verifies up front that a grace policy covers the destination cache,
so a missing policy fails at plan time, before anything is published and whether
or not this run's manifest produces a shared intermediate. One degradation stays
silent: a grace period shorter than the span from plan to the last target job
does not fail anything, the collected intermediate is simply rebuilt, so the
only symptom of too short a grace is the reuse quietly not happening.

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
it does not inspect the cache or derivation graph, and builds every target
directly without attesting or publishing it.

## Common tasks

Routine changes to a working setup, and where each one's state lives.

### Move to a new cupboard release

Establish the new trust before changing the caller. Keep the old and new tags in
separate variables so each command names the intended release:

```bash
old_cupboard_version=vX.Y.Z
new_cupboard_version=vA.B.C
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml

cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
cupboard github check "$tenant" --repo "$repo" \
  --root-prefix "github:$repo/main" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version"
```

Setup recognises the old setup-managed rules by their otherwise identical claims
and grants, re-verifies their release reference through GitHub, and adds the new
immutable reference alongside them. Check then proves that a run carrying the
new reference can obtain every grant it needs while the old caller still works.

Update the caller workflow's `uses:` reference and `cupboard-version` input to
`$new_cupboard_version`. Once runs using the old reference have finished, retire
it explicitly:

```bash
cupboard github setup "$tenant" --repo "$repo" \
  --workflow-ref "$workflow@refs/tags/$new_cupboard_version" \
  --retire-workflow-ref "$workflow@refs/tags/$old_cupboard_version"
```

Retirement first confirms that both new rules are present. It removes only
enabled rules that exactly match setup's expected claims and grants for the old
reference; a drifted rule stops both retirements and must be inspected and
removed explicitly. Repeat any non-default `--branch` or `--grace` values on
both setup calls.

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
