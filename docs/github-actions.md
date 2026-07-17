# GitHub Actions

cupboard publishes self-contained binaries on GitHub Releases and provides
composite actions for installing the binary and pushing build outputs from CI.
This guide covers setting a repository up and the tasks that follow: the
quickstart, each action, the reusable workflows, and routine changes to a
working setup.

The deeper material lives in its own documents and is linked where it matters:

- [docs/trust-rules.md](./trust-rules.md): how CI authenticates, what a trust
  rule matches, and rules beyond the presets.
- [docs/runner-provenance.md](./runner-provenance.md): why runner configuration
  is repository variables and what the label syntax guarantees.
- [docs/reuse-views.md](./reuse-views.md): reuse-view read semantics and how the
  workflow adopts earlier builds.
- [docs/releases.md](./releases.md): how the binaries themselves are built and
  attested.

## Version Selection

Both actions accept `cupboard-version`. The default is `latest`.

- `latest` resolves through GitHub's latest release endpoint.
- `1.2.3` is normalised to `v1.2.3` and resolved by tag.
- `v1.2.3` is used as-is and resolved by tag.

GitHub documents the [latest release endpoint][github-latest-release] as the
latest non-prerelease, non-draft release. Release API calls use `github-token`,
which defaults to the workflow `github.token`. Public unauthenticated downloads
work, but the token avoids unnecessary rate-limit failures.

[github-latest-release]:
  https://docs.github.com/en/rest/releases/releases#get-the-latest-release

## Cache-aware flake publishing quickstart

This is the shortest complete setup for publishing pull-request builds to
short-lived `pr-<number>` caches, then reusing those builds when `main` is
published. It also keeps shared intermediates through a tenant retention grace
period instead of creating a temporary root for every workflow run.

The example assumes that cupboard is deployed, the tenant exists, its reads are
public, and `cupboard login` has stored its owner credential. See the [README
quickstart][readme-quickstart] for deployment and tenant creation. The later
sections cover private reads, remote builders and each setting in more detail.

[readme-quickstart]: ../README.md#quick-start

### 1. Choose the tenant, repository and release

Set these shell variables once so the remaining commands can be copied without
repeating them.

```bash
tenant=https://cupboard.example.workers.dev/t/acme
repo=acme/app
cupboard_version=vX.Y.Z
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/heads/main
```

Replace `vX.Y.Z` with a real cupboard release tag from the [releases page][]
before continuing. Pinning a tag is especially important while the available
releases are prereleases: `latest` only selects a non-prerelease release.

The `workflow` value is matched, character for character, against the
`job_workflow_ref` claim in the OIDC token of every CI push, so its exact shape
matters: it names cupboard's repository, where the reusable workflow file lives,
not your own, and it spells the ref in full as `refs/heads/main` even though
your caller workflow will reference the same file as `@main`. Changing either
part produces a trust rule that can never match, and every push is then refused.
See [docs/trust-rules.md](./trust-rules.md) for how the claim works.

[releases page]: https://github.com/underwhelmingperformance/cupboard/releases

### 2. Configure the tenant

Give every cache a 24-hour retention grace period, define a view over the PR
caches, and trust this repository's PR and `main` runs when they use cupboard's
reusable workflow:

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

Adding a grace policy changes how the covered caches are collected, and the
change is permanent: the first publication accepted under the policy marks its
cache grace-managed, `policy remove-grace` does not unmark it, and a
grace-managed cache whose last deadline lapses may be emptied by collection,
which a cache without the marker never is. Apply the policy with the coverage
you intend to keep.

The view's priority of 50 sits above the destination cache's priority, which
defaults to 40 on the server; Nix tries substituters lowest-priority-first, so
this keeps the destination preferred. 50 is also the CLI's default, spelled out
here because the relationship, view strictly above destination, is required:
setup refuses a view that would tie or precede the destination.

These trust commands resolve and pin the repository's immutable GitHub ids. The
PR rule confines each pull request to its own cache and root; the branch rule
confines `main` to the tenant's default cache and its own root prefix.

### 3. Set the repository configuration

The target manifest is repository code, so a pull request can change its runner
labels. Store the tenant URL and release pin alongside the permitted labels and
the plan job's runner as protected GitHub repository variables:

```bash
gh variable set CUPBOARD_URL \
  --repo "$repo" --body "$tenant"

gh variable set CUPBOARD_VERSION \
  --repo "$repo" --body "$cupboard_version"

gh variable set CUPBOARD_PLAN_RUNNER \
  --repo "$repo" --body '"ubuntu-latest"'

gh variable set CUPBOARD_RUNNERS \
  --repo "$repo" --body 'ubuntu-latest,macos-latest'
```

`CUPBOARD_PLAN_RUNNER` contains JSON, including the quotes around a plain label.
`CUPBOARD_RUNNERS` must include every `os` label used by the target manifest;
nothing is permitted by default. Why runner configuration lives in variables,
and the `label@group` syntax for self-hosted runners, is
[docs/runner-provenance.md](./runner-provenance.md).

### 4. Declare the targets

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

### 5. Call the reusable workflow

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

jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@main
    with:
      url: ${{ vars.CUPBOARD_URL }}
      targets: .#cupboardOutputs
      cache:
        ${{ github.event_name == 'pull_request' && format('pr-{0}',
        github.event.pull_request.number) || '' }}
      root-prefix:
        ${{ format('github:{0}/{1}', github.repository, github.event_name ==
        'pull_request' && format('pr-{0}', github.event.pull_request.number) ||
        github.ref_name) }}
      ttl: ${{ github.event_name == 'pull_request' && '14d' || '' }}
      intermediate-retention: grace
      reuse-view: ${{ github.event_name == 'push' && 'pull-requests' || '' }}
      cupboard-version: ${{ vars.CUPBOARD_VERSION }}
```

The `&&`/`||` pairs are GitHub Actions' substitute for a conditional expression:
`condition && a || b` evaluates to `a` on a pull request and `b` otherwise,
which only holds while every `a` is non-empty, as they all are here. Each
expression picks the pull-request value or the branch value for one input, and
the chosen cache name must stay consistent with what the PR trust rule routes:
the rule confines each pull request to its `pr-<number>` cache, so the `cache`
input computes exactly that name.

The workflow uses the reuse view only for `main`; use the view for every event
if PR-to-PR reuse is also wanted. The workflow reference and release tag are
kept explicit so changes to cupboard do not silently alter a repository's CI.

### 6. Verify the setup

List the tenant configuration before opening the first pull request:

```bash
cupboard policy list "$tenant"
cupboard reuse-view list "$tenant"
cupboard oidc-trust list "$tenant"
```

The output should contain the tenant-wide 24-hour grace policy, the
`pull-requests` view and one trust rule for PRs plus one for `main`. Open a pull
request and confirm that the workflow publishes to `pr-<number>`. After merging
it, the `main` run should plan already-published targets from the reuse view and
retain them beneath `github:<owner>/<repo>/main` in the default cache.

Note that the listing shows the configuration exists, not that it will match a
real run: a trust rule with a mis-spelled `job_workflow_ref` lists identically
to a working one, and the first sign of the difference is every push being
refused. If the first run's pushes are rejected, compare each rule's claims
against [docs/trust-rules.md](./trust-rules.md) character by character before
anything else.

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
    uses: owner/cupboard/.github/workflows/cupboard-publish.yml@main
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
job. `os` selects the runner, and every label the manifest uses must be named in
the `CUPBOARD_RUNNERS` repository variable, with the plan job's own runner in
`CUPBOARD_PLAN_RUNNER`; both are required, and the syntax and the reasoning are
[docs/runner-provenance.md](./runner-provenance.md). `remote` marks a group that
realises its derivations on the configured remote builders: those jobs build
with `--max-jobs 0` and apply the `builders` specification, the
`builder_ssh_key` and `builder_ssh_config` secrets, and the
`builder-known-hosts` input.

Call the workflow with the cache and root prefix for the current event:

```yaml
jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: owner/cupboard/.github/workflows/cupboard-flake-publish.yml@main
    with:
      url: https://cupboard.example.workers.dev/t/acme
      targets: .#cupboardOutputs
      cache: pr-${{ github.event.pull_request.number }}
      root-prefix: github:acme/app/pr-${{ github.event.pull_request.number }}
      ttl: 14d
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

Two grace-mode behaviours are easy to miss. The fail-closed check runs on seed
and fallback publications, and those jobs exist only when targets share outputs,
so a manifest without shared outputs runs green whether or not a grace policy
exists; the gap surfaces when a second target first shares an output. And a
grace period shorter than the span from plan to the last target job does not
fail anything: the collected intermediate is simply rebuilt, so the only symptom
is the reuse quietly not happening.

`reuse-view` opts the run into reading shared intermediates through a named
tenant reuse view when the destination is missing them; see
[docs/reuse-views.md](./reuse-views.md). Empty, the default, keeps planning and
substitution destination-only.

`cupboard-version` pins the CLI release the jobs install, and `maximise-space`
(default `true`) reclaims runner disk space before building; disable it on
self-hosted runners, where the reclamation would be destructive.

The workflow accepts `push: false` for a build-only validation run. In that mode
it does not inspect the cache or derivation graph, and builds every target
directly without attesting or publishing it.

## Common tasks

Routine changes to a working setup, and where each one's state lives.

### Move to a new cupboard release

The release pin lives in one place, the `CUPBOARD_VERSION` repository variable:

```bash
gh variable set CUPBOARD_VERSION --repo "$repo" --body vX.Y.Z
```

Every job of the next run installs the new release. Nothing on the tenant refers
to the release.

### Add a target or a platform

Add the entry to the flake's `cupboardOutputs` list. If it introduces a new `os`
label, add that label to `CUPBOARD_RUNNERS` first; a label the variable does not
name fails the plan job. No tenant change is needed: caches are created on first
push, and the existing root-prefix grant covers the new target's root.

### Add another repository to the same tenant

The tenant-wide grace policy and the `pull-requests` view already cover any
number of repositories. Run quickstart step 2's
`cupboard github setup … --apply-variables` for the new repository: it adds that
repository's trust rules and sets its variables, and reports the shared tenant
state as unchanged. The equivalent individual commands are in
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
