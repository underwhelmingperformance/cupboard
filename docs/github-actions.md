# GitHub Actions

cupboard publishes self-contained binaries on GitHub Releases and provides
composite actions for installing the binary and pushing build outputs from CI.
The release workflow probes the ESM Node SEA path first, but the pinned Node
24.16 preparation-blob path currently publishes CommonJS SEA binaries when the
ESM smoke test fails. The composite actions bootstrap Node 24 for their small
TypeScript helper and run it with Node's built-in type stripping, so there is no
checked-in generated JavaScript action bundle.

GitHub documents the latest release endpoint as the latest non-prerelease,
non-draft release, and the action uses that endpoint when
`cupboard-version: latest` is selected. GitHub artifact attestations are the
default provenance path for public releases.

[github-latest-release]:
  https://docs.github.com/en/rest/releases/releases#get-the-latest-release
[github-artifact-attestations]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

## Version Selection

Both actions accept `cupboard-version`. The default is `latest`.

- `latest` resolves through GitHub's latest release endpoint.
- `1.2.3` is normalised to `v1.2.3` and resolved by tag.
- `v1.2.3` is used as-is and resolved by tag.

Release API calls use `github-token`, which defaults to the workflow
`github.token`. Public unauthenticated downloads work, but the token avoids
unnecessary rate-limit failures.

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
repeating them. Use a real cupboard release tag from the [releases page][].
Pinning a tag is especially important while the available releases are
prereleases: `latest` only selects a non-prerelease release.

[releases page]: https://github.com/underwhelmingperformance/cupboard/releases

```bash
tenant=https://cupboard.example.workers.dev/t/acme
repo=acme/app
cupboard_version=vX.Y.Z
workflow=underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/heads/main
```

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
root-based fallback. The view's priority of 50 leaves the normal cache, whose
default priority is 40, preferred.

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

Replace `vX.Y.Z` with the chosen release tag before running these commands.
`CUPBOARD_PLAN_RUNNER` contains JSON, including the quotes around a plain label.
`CUPBOARD_RUNNERS` must include every `os` label used by the target manifest.
Use runner groups as described under "Runner provenance" when self-hosted
runners are available to this repository.

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
        github.event.number) || '' }}
      root-prefix:
        ${{ format('github:{0}/{1}', github.repository, github.event_name ==
        'pull_request' && format('pr-{0}', github.event.number) ||
        github.ref_name) }}
      ttl: ${{ github.event_name == 'pull_request' && '14d' || '' }}
      intermediate-retention: grace
      reuse-view: ${{ github.event_name == 'push' && 'pull-requests' || '' }}
      cupboard-version: ${{ vars.CUPBOARD_VERSION }}
```

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
destination cache. Nix tries substituters in order, so setup fetches both
`nix-cache-info` responses and refuses to configure the view unless its priority
is numerically greater than the destination's, keeping the destination first.

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
job. `os` selects the runner; the manifest is evaluated from the flake and is
therefore pull-request-controlled, so every label it uses must be named in the
`CUPBOARD_RUNNERS` repository variable, set through repository settings where a
pull request cannot reach. Labels are printable ASCII without spaces; GitHub
compares them case-insensitively, and that comparison is only exact within
ASCII, so anything wider is refused. Nothing is allowed by default, not even
GitHub-hosted labels: a self-hosted runner can carry any label, so the permitted
set is entirely the operator's, and a `label@group` entry additionally pins the
label to a runner group (see "Runner provenance" below). `remote` marks a group
that realises its derivations on the configured remote builders: those jobs
build with `--max-jobs 0` and apply the `builders` specification, the
`builder_ssh_key` and `builder_ssh_config` secrets, and the
`builder-known-hosts` input.

### Runner provenance

A label is a spelling, not a provenance claim: GitHub routes a job to any runner
carrying the requested labels, and self-hosted runners accept arbitrary manually
assigned labels, hosted-sounding names included. GitHub's boundary for pinning
where a job may land is the runner group. The workflow therefore takes its
runner configuration only from repository variables, which a pull request cannot
edit, and two of them must be set before the workflow runs:

- `CUPBOARD_RUNNERS` names every `runs-on` label the target manifest may use,
  separated by whitespace or commas. A bare entry (`ubuntu-latest`) permits the
  spelling and routes by label alone; an entry written as `label@group`
  (`nix-builder@build-farm`) routes that label to the named runner group as
  `runs-on: { group, labels }`. Labels and group names must each be one or more
  printable ASCII characters excluding spaces, commas and `@`, a narrower
  contract than GitHub's: labels because case-insensitive matching is only exact
  within ASCII, `@` because it separates the two, and the rest as this syntax's
  own grammar. Rename a group that cannot be expressed. Example:

  ```text
  ubuntu-latest, macos-14, nix-builder@build-farm
  ```

- `CUPBOARD_PLAN_RUNNER` is the plan job's own `runs-on` value, as JSON, and it
  is required: the plan job holds the input SSH key, read credentials and OIDC
  permission while evaluating pull-request-controlled Nix, so it has no fallback
  runner. Either a plain label or a group selector:

  ```text
  "ubuntu-latest"
  {"group":"trusted","labels":["ubuntu-latest"]}
  ```

Bare labels remain vulnerable to collisions: a self-hosted runner registered
with a permitted spelling is eligible for those jobs. Either qualify every entry
with a runner group, or enforce the boundary in the organisation's runner policy
by restricting self-hosted runner groups away from the repositories that call
this workflow and disallowing repository-level runner registration.

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

The first publication accepted under a grace policy also marks the destination
cache grace-managed, and the marker is permanent: it survives removing the
policy. Garbage collection normally refuses to empty a cache without a retention
event, but a grace-managed cache's lifetime is governed by its grace deadlines,
so it may drain to empty once the last deadline has expired. Adding a grace
policy is therefore a durable change to how the caches it covers are collected,
not a setting the matching `remove-grace` fully undoes.

`reuse-view` opts the run into reading shared intermediates through a named
tenant reuse view when the destination is missing them; see "Reading through a
reuse view" below. Empty, the default, keeps planning and substitution
destination-only.

`cupboard-version` pins the CLI release the jobs install, and `maximise-space`
(default `true`) reclaims runner disk space before building; disable it on
self-hosted runners, where the reclamation would be destructive.

The workflow accepts `push: false` for a build-only validation run. In that mode
it does not inspect the cache or derivation graph, and builds every target
directly without attesting or publishing it.

### Reading through a reuse view

A named reuse view is a set of caches a reader may substitute from, defined once
on the tenant with `cupboard reuse-view set`:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme reuse \
  --prefix pr-
```

This view selects every cache whose name currently starts with `pr-`. A view
holds no narinfo or membership of its own; it is a live selector over the caches
it names, so a cache created, renamed, or recreated under a matching name is
picked up without redefining the view.

Passing `reuse-view` to `cupboard-flake-publish.yml` opts the run's
`actions/setup` and `actions/plan` into it. `actions/setup` adds the view as a
second Nix substituter, after the destination cache: Nix tries substituters in
order, and setup fetches both `nix-cache-info` responses and refuses to
configure the view unless its priority is numerically greater than the
destination's, so the destination is always tried first. `actions/plan` probes
the view for any target or shared intermediate the destination does not already
hold. A hit there retains nothing by itself, since the destination stays the
only retention boundary; it only lets the affected build job substitute the
result instead of building it, and that job's own push still adopts and roots
the result in the destination as usual.

Every response under a view's URLs, hits, misses and faults alike, carries
`cache-control: no-store`. A view's answer changes whenever its definition
changes, a matching cache commits a conflicting candidate, or a candidate is
collected, and no purge covers any of that, so neither the Cloudflare edge nor
any intermediary may hold a copy. Reads through a view therefore always reach
the origin; expect view-heavy runs to cost more origin traffic than reads from
the destination cache.

A view spans every cache its selectors currently match, so any writer with push
access to one of those caches can influence what the view serves a reader.
Cupboard resolves the risk this creates the same way for every candidate: when a
store-path hash names more than one semantically distinct result across the
view's caches, the lookup answers as a miss rather than guessing, and the
affected target simply builds locally instead of substituting.

Intermediate handling depends on both `intermediate-retention` and whether
`reuse-view` is set:

| Retention mode | Reuse view | Destination intermediate                  | View-only intermediate                                                             | Missing intermediate                                        |
| -------------- | ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `root`         | absent     | Seed omitted; the destination serves it   | not applicable                                                                     | Built and kept under the 24-hour seed root                  |
| `root`         | present    | Seed omitted; the destination serves it   | Substituted through the view, then kept under the 24-hour seed root                | Built and kept under the 24-hour seed root                  |
| `grace`        | absent     | Confirmed with a refreshed grace deadline | not applicable                                                                     | Built, published with `--no-retain`, needs a grace deadline |
| `grace`        | present    | Confirmed with a refreshed grace deadline | Substituted through the view, published with `--no-retain`, needs a grace deadline | Built, published with `--no-retain`, needs a grace deadline |

A common shape adopts a pull request's build into `main`'s own publication. An
administrator defines the view once, covering the per-PR caches the
`add-github-pr` rule already routes builds to (see "Trust rules" below):

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme reuse \
  --prefix pr-
```

`main`'s post-merge workflow then opts into it:

```yaml
jobs:
  publish:
    uses: owner/cupboard/.github/workflows/cupboard-flake-publish.yml@main
    permissions:
      attestations: write
      contents: read
      id-token: write
    with:
      url: https://cupboard.example.workers.dev/t/acme
      root-prefix: github:acme/app/main
      reuse-view: reuse
```

If the merged commit's outputs already sit in the PR's cache from CI, the plan
substitutes them through the view rather than rebuilding, then the seed or
fallback job's push adopts and roots them in the destination under `main`'s own
roots. A target the PR never built plans and builds exactly as it would without
a view.

The jobs belong to cupboard's reusable workflow, while the standard repository
and ref claims still describe the caller. A trust rule that restricts
`job_workflow_ref` must therefore name
`owner/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/heads/main`
and keep its caller repository and ref restrictions. [GitHub documents this
called-workflow claim][github-oidc-reusable-workflows] separately from the
standard caller claims.

[github-oidc-reusable-workflows]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows

Always reference the workflow as `@main`, not by a local path. The tenant's
trust rule can then require that pushes come from this exact file on `main`, so
a pull request cannot smuggle in an edited copy of the publish job and gain the
rule's access.

## Trust rules

A push from CI exchanges its GitHub Actions OIDC token for a cupboard token. The
exchange succeeds only when a trust rule on the tenant both recognises the token
and permits everything the push asks for. The exchange is all-or-nothing: if the
push wants to attach attestations or set a retention root and the rule does not
grant those, the whole exchange is refused, not narrowed.

A good rule pins identity on two axes. The repository is pinned by its immutable
numeric ids (`repository_id` and `repository_owner_id`), so a rename cannot
silently transfer trust and nobody reusing the freed-up name inherits it. The
trigger is pinned by the `ref` claim, which is the branch (or pull request) that
started the run, so only that branch's pushes are accepted. Optionally the
workflow file is pinned too, by `job_workflow_ref`, as a further restriction.

The `add-github-pr` and `add-github-branch` commands assemble these rules for
the common cases. `add-github-pr` trusts pull-request builds and routes each one
to its own short-lived cache (`pr-<number>`) and matching retention root
(`github:<owner>/<repo>/pr-<number>/`), both keyed on the pull-request number,
so one PR cannot reach another's paths. `add-github-branch` trusts pushes to one
branch and publishes to the tenant's default cache under the retention root the
push action writes by default, `github:<owner>/<repo>/<branch>/`; it pins the
branch through the `ref` claim, so a sibling branch sharing a reusable workflow
cannot match. Both look up the repository's ids for you, grant the push and the
retention root, and grant attestation by default; pass `--no-attest` to withhold
it, or `--root-template` to override the root.

```bash
# Per-PR rule: build the pull request, push to its own pr-<n> cache.
cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra

# Branch rule: pushes to main, requiring the reusable publish workflow,
# publish to the default cache.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra --branch main \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main
```

`--job-workflow-ref` is optional on both presets and restricts the rule further
to the `job_workflow_ref` claim, the workflow file that issued the token,
written `owner/repo/path@ref`. Give it with an `@ref` to match exactly, or
without one to match that file at any ref; the latter is what a reusable
workflow needs, since its ref is the file's own location rather than the branch
being built, and the branch is already pinned by `ref`. It is named after the
claim on purpose: `job_workflow_ref` is a different claim from `workflow` (the
workflow's name) and `workflow_ref` (the calling workflow).

For an issuer or claim shape the presets do not cover, the general
`cupboard oidc-trust add` takes the issuer, audience, claims and grants
directly. `--job-workflow-ref` sets the `job_workflow_ref` claim without
spelling out `--claim`, and omitting `--cache` scopes the grant to the tenant's
default cache:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --allow push --allow attest --allow root \
  --root github:acme/infra/main/
```

The trailing slash on the root makes it a prefix, so one grant covers every
per-system root beneath it.

The flake publish workflow depends on that prefix. Each of its jobs exchanges
its own OIDC token under the same trust rule: the plan job ensures a retention
root for each already-cached target, and the seed, fallback and target jobs push
and attest. Every root it writes, one per target and one per shared-output
group, sits beneath the `root-prefix` the caller passes, so a single prefix
grant covers them all. Trust it with the branch preset, pinning
`job_workflow_ref` to cupboard's reusable file:

```bash
# Trust main's flake publish. The preset grants github:acme/app/main/, a
# prefix covering every per-target and shared-output root the run writes.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main \
  --job-workflow-ref owner/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/heads/main
```

Then call the workflow with a `root-prefix` that nests under the granted root,
here `github:acme/app/main` beneath the grant `github:acme/app/main/`:

```yaml
jobs:
  publish:
    uses: owner/cupboard/.github/workflows/cupboard-flake-publish.yml@main
    permissions:
      attestations: write
      contents: read
      id-token: write
    with:
      url: https://cupboard.example.workers.dev/t/acme
      root-prefix: github:acme/app/main
```

The `job_workflow_ref` names the file in `owner/cupboard`, where the reusable
workflow lives, not the caller's repository. The plan and build jobs run inside
cupboard's workflow, so that is the claim their token carries; the caller is
still pinned, by the repository ids and `ref` the preset sets.

With `intermediate-retention: grace`, the seed and fallback jobs no longer write
a root at all, so the prefix grant above only needs to cover the target jobs'
named per-target roots; the trust rule itself needs no change, since an unused
`root` allowance is harmless. The plan job's confirmation calls need
`upload:confirm`, but any rule that already allows `push` (as both presets above
do) grants it implicitly: `upload:commit` covers the narrower `upload:confirm`
the same way it covers `upload:negotiate`, so no separate `--allow` is needed
for grace mode.

Release builds usually go to a cache named after the tag, and no preset covers
that. `--capture` builds the rule instead: it reads a value out of a token claim
using a pattern with a named group, and that value fills the `{...}`
placeholders in `--cache-template` and `--root-template`. The pattern also acts
as a filter: a token whose claim does not match is refused. This rule sends a
build of tag `v1.2.3` to a cache called `v1.2.3`:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository_id=123456 \
  --claim repository_owner_id=7890 \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --capture 'ref=^refs/tags/(?<tag>v[0-9][A-Za-z0-9.+-]*)$' \
  --cache-template '{tag}' \
  --root-template 'github:acme/infra/{tag}/' \
  --allow push --allow attest --allow root
```

The two numeric id claims pin the repository the same way the presets do.
`gh api repos/<owner>/<repo>` prints both: `.id` and `.owner.id`.

## Binary Releases

The release workflow publishes these assets for each version tag:

- `cupboard-vX.Y.Z-linux-x64.tar.gz`
- `cupboard-vX.Y.Z-linux-arm64.tar.gz`
- `cupboard-vX.Y.Z-macos-x64.tar.gz`
- `cupboard-vX.Y.Z-macos-arm64.tar.gz`
- `checksums.txt`

Each binary build tries the ESM path first: esbuild emits an ESM bundle, the SEA
config sets `mainFormat: "module"`, postject injects the blob into a pinned Node
24 binary, and the result is smoke-tested with `cupboard --version`,
`cupboard push --help`, and `cupboard config`. With Node 24.16.0 today that
smoke test fails because the preparation-blob path cannot execute ESM, so the
script rebuilds the same asset as a CommonJS SEA. ESM SEA should become the
published format once the pinned Node line supports it in the release path.

Public releases require GitHub artifact attestations for release assets. Signed
checksums are the fallback only for environments where GitHub attestations are
unavailable.

Secondary distribution channels can come later:

- npm bin package for developer convenience.
- Homebrew tap for macOS/manual installs.
- Nix flake package for Nix users.

Docker or OCI actions are not the primary path because they do not solve host
Nix store or daemon access and do not help macOS runners.
