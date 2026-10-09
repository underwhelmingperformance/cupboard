# Publishing a flake

`cupboard-flake-publish.yml` is a reusable GitHub Actions workflow. It realises
a list of your flake's outputs, can publish selected paths to a cupboard cache,
and can sign build provenance for builds observed on the runner.

This page is the guide to the workflow's options. If you haven't set the
workflow up yet, start with [the quickstart](./quickstart.md). To understand
what happens during a run, see [How a publication run works](./how-it-works.md).
[The actions reference](../reference/actions.md#cupboard-flake-publishyml) lists
every input and secret.

This page covers how to:

- [let the workflow choose the cache for each run](#using-the-preset), or
  [choose it yourself](#choosing-the-cache-and-roots-yourself);
- [publish tagged releases](#publishing-releases);
- [describe the outputs to build](#the-target-manifest), including
  [targets that are allowed to fail](#letting-a-target-fail-without-failing-the-run)
  and [targets too large for one runner](#splitting-a-large-target-into-parts);
- [reuse builds from other caches](#reusing-builds-from-other-caches);
- [choose what to build, publish and attest](#choosing-publication-behaviour);
- [choose the cupboard version](#selecting-the-cupboard-version);
- [check that a manifest builds without publishing](#building-without-publishing);
- [make better use of runner disk space](#making-the-most-of-the-runners);
- [upgrade cupboard, add targets and add repositories](#common-tasks).

## Choosing where to publish

When publication is enabled, each run publishes to one cache. Each target also
gets a retention root, which keeps the target in the cache (see
[Retention](../admin/retention.md)). The root's name is made of two parts: a
**root prefix** shared by the whole run, such as `github:acme/app/main`,
followed by the target's own `rootSuffix` from the manifest.

You can let the workflow pick the cache, the root prefix and how long the roots
last, based on the event that triggered the run. That's what the preset does. Or
you can set them yourself.

### Using the preset

Set `preset: pull-request-and-branch` to have the workflow choose the
destination from the event. This is what [the quickstart](./quickstart.md) uses.

- A pull request from the same repository publishes to a cache for that pull
  request, `gh-<repository-id>-pr-<number>`, when publication is enabled. The
  workflow creates the cache if it doesn't exist and restores write access when
  the pull request reopens. Roots are named under
  `github:<repository>/pr-<number>/` and expire 14 days after the latest run.
  With `publish: none`, the run reads from the tenant's default cache and does
  not create a pull-request cache. Pull-request runs don't read a reuse view.
- A run on the branch that the `branch` input specifies (`main` by default)
  publishes to the tenant's default cache. It doesn't matter which event started
  the run. Roots are named under `github:<repository>/<branch>/` and are
  permanent. These runs read through the reuse view
  `pull-requests-<repository-id>`, or the view that `reuse-view` specifies if
  you set that input.
- When a pull request is closed and publication is enabled, the run closes its
  cache, whether the pull request was merged or not. Closure rejects publication
  and retention-extending writes and brings root expiry forward to the close
  time. Reads and reuse remain available during the configured grace period.
  Garbage collection removes expired contents, then deletes the empty cache
  after pending work finishes. With `publish: none`, the cache stays unchanged.
- Anything else fails. That includes pull requests from forks, other branches,
  and tags.

You can't combine the preset with the `cache`, `root-prefix`, `ttl` or
`permanent` inputs.

The preset expects particular triggers and concurrency settings. See
[step 4 of the quickstart](./quickstart.md#4-add-the-workflow). Never trigger it
on `pull_request_target`, because the preset treats that as a run on the branch.

### Choosing the cache and roots yourself

Without the preset, set these inputs:

| Input         | What it does                                                         |
| ------------- | -------------------------------------------------------------------- |
| `cache`       | The named cache to publish to. Leave it empty for the default cache. |
| `root-prefix` | The start of every target's root name. Required.                     |
| `ttl`         | How long each root lasts after it was last set, such as `14d`.       |
| `permanent`   | Keep roots until they're replaced or removed.                        |
| `reuse-view`  | A reuse view to read through, on every run.                          |

For example, to publish every run to a cache called `nightly` and keep each root
for a week:

```yaml
with:
  url: https://cupboard.example.workers.dev/t/acme
  cache: nightly
  root-prefix: github:acme/app/nightly
  ttl: 7d
  trusted-public-key: cupboard-acme-1:...
```

Set either `ttl` or `permanent`, not both. If you set neither, the roots follow
the cache's own retention settings. See [Retention](../admin/retention.md).

Without the preset, the workflow doesn't create or remove caches itself, but the
first push to a named cache that doesn't exist creates it. The new cache gets
the default cache's access, priority 40 and no default root TTL. Create the
cache first with `cupboard cache create` if it needs other settings.

If you also set `reuse-view`, create the cache before the first run. The plan
job checks that the destination cache's priority is lower than the view's before
it publishes anything, and it can't read the priority of a cache that doesn't
exist yet, so the run fails.

The trust rule that accepts the run must also allow roots under your
`root-prefix`.

### Publishing releases

You might want one cache that serves every tagged release, with each release
kept under its own root. Here's how to set that up.

1. Create the cache, so you can choose its access. The first tag run would also
   create it, but with the default cache's access:

   ```sh
   cupboard cache create https://cupboard.example.workers.dev/t/acme releases \
     --access public
   ```

2. Add a trust rule that lets tag runs publish to it:

   ```sh
   cupboard oidc-trust add-github-tag https://cupboard.example.workers.dev/t/acme \
     --repo acme/app \
     --job-workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*' \
     --cache-template releases \
     --root-template 'github:acme/app/{tag}/'
   ```

   The rule fills in `{tag}` with the tag's name. For that to work, tag names
   must be lower case and match `[a-z0-9][a-z0-9._-]*`.

3. Run the workflow when you push a tag:

   ```yaml
   on:
     push:
       tags: ['v*']

   jobs:
     publish:
       permissions:
         attestations: write
         contents: read
         id-token: write
       uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
       with:
         url: https://cupboard.example.workers.dev/t/acme
         cache: releases
         root-prefix: github:acme/app/${{ github.ref_name }}
         permanent: true
         trusted-public-key: cupboard-acme-1:...
   ```

Your users then need only one substituter,
`https://cupboard.example.workers.dev/t/acme/cache/releases`. Because each
release has its own root, publishing a new release never stops the cache keeping
an old release's paths.

Without a preset, `cache-access-mode` requires the selected cache to have that
access on every event, including pushes, manual runs and scheduled runs. With
the `pull-request-and-branch` preset, the input selects access for publishing
pull-request caches. Branch and read-only runs use the default cache's access.

## The target manifest

The manifest lists the requested outputs. Each target specifies an output that
the workflow can build and publish. By default, the workflow reads the manifest
from the flake attribute `.#cupboardOutputs`. To use a different attribute, set
the `targets` input.

The attribute must evaluate to a list that can be converted to JSON. Each item
has these fields:

| Field         | Default   | What it means                                                                                                             |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `attr`        | required  | What to build, such as `.#packages.x86_64-linux.default`.                                                                 |
| `rootDrvPath` |           | The derivation that `attr` evaluates to. See below for when it's required.                                                |
| `system`      | required  | The Nix system that the target is built for.                                                                              |
| `os`          | required  | One runner label, in printable ASCII without spaces. See [Runners](../security.md#runners) before using self-hosted ones. |
| `rootSuffix`  | required  | The end of the target's root name, after the root prefix. Must be unique in the manifest.                                 |
| `outputs`     | `["out"]` | The derivation outputs to publish, at most 149.                                                                           |
| `remote`      | `false`   | Offer the target's builds to the machines in the `builders` input.                                                        |
| `bestEffort`  | `false`   | Let the target's build fail without failing the run.                                                                      |
| `cohort`      |           | A label for building targets together. See below.                                                                         |
| `components`  |           | Publish these parts instead of the target itself. See below.                                                              |

When checking that root suffixes are unique, `app`, `/app` and `app/` count as
the same suffix.

`rootDrvPath` is required for every target except best-effort ones. A local
build-only run with `publish: none` does not need it. It lets the plan job work
from the derivation directly, without evaluating each `attr` separately. Each
cohort job evaluates `attr` again later, and fails if it gives a different
derivation.

### Building several targets in one job

Normally each target is built in its own job. To build several targets together,
give them the same `cohort` label. Targets that share a label are built in one
job, with one `nix build`. This group is called a cohort.

A cohort label can be up to 100 printable ASCII characters, without spaces.
Targets in the same cohort must have the same `system`, `os`, `remote` and
`bestEffort` values.

### Letting a target fail without failing the run

Set `bestEffort = true` on a target whose build is allowed to fail. The workflow
publishes successful outputs, updates their roots and signs eligible build
provenance even when another target fails to build. The receipt records the
failed targets. Authentication, command, publication, verification and retention
failures still fail the run.

`bestEffort` doesn't cover evaluation. The manifest is evaluated as a whole, so
if evaluating a best-effort target's `rootDrvPath` fails, the whole manifest
fails. To avoid that, wrap the evaluation in `builtins.tryEval`, and leave
`rootDrvPath` out when it fails. The target's cohort job then builds `attr`
directly, and reports the error there.

Here's a helper that does this. Use it as the value of `cupboardOutputs`, where
`self` is in scope:

```nix
let
  target = { derivation, bestEffort ? false, ... }@args:
    let
      drvPath =
        if bestEffort
        then builtins.tryEval derivation.drvPath
        else { success = true; value = derivation.drvPath; };
    in
      builtins.removeAttrs args [ "derivation" ]
      // { inherit bestEffort; }
      // (if drvPath.success then { rootDrvPath = drvPath.value; } else { });
in
[
  (target {
    attr = ".#packages.x86_64-linux.server";
    derivation = self.packages.x86_64-linux.server;
    system = "x86_64-linux";
    os = "ubuntu-latest";
    rootSuffix = "x86_64-linux/server";
  })
  (target {
    attr = ".#darwinConfigurations.laptop.system";
    derivation = self.darwinConfigurations.laptop.system;
    system = "aarch64-darwin";
    os = "macos-latest";
    bestEffort = true;
    rootSuffix = "aarch64-darwin/laptop";
  })
]
```

`builtins.tryEval` only catches `throw` and `assert`. A missing attribute or a
type error still makes the manifest fail.

If you use a remote `store`, every target needs `rootDrvPath`, including
best-effort ones.

### Splitting a large target into parts

Some targets, such as a NixOS system, have a closure too large for one runner's
disk, even though each part of it would fit. For these, you can list the parts
that you want to publish as `components`. Each component has an `attr`, a
`rootDrvPath`, and optionally `outputs`:

```nix
{
  attr = ".#nixosConfigurations.server.config.system.build.toplevel";
  system = "x86_64-linux";
  os = "ubuntu-latest";
  rootSuffix = "x86_64-linux/server";
  components = [
    {
      attr = ".#nixosConfigurations.server.config.boot.kernelPackages.kernel";
      rootDrvPath = self.nixosConfigurations.server.config.boot.kernelPackages.kernel.drvPath;
    }
    {
      attr = ".#nixosConfigurations.server.config.systemd.package";
      rootDrvPath = self.nixosConfigurations.server.config.systemd.package.drvPath;
    }
  ];
}
```

A target with components is called an aggregate target. The workflow never
evaluates or builds the aggregate itself. Instead, each component is published
as a target of its own, in its own cohort. If you give the aggregate a `cohort`
label, the components share that cohort instead. Each component takes its
`system`, `os`, `remote` and `bestEffort` values from the aggregate.

All the components share the aggregate's root. The plan refuses an aggregate
with more than 149 components. The root API separately limits each explicit
replacement of a root's target set to 149 paths; a run root can accumulate more
paths through additive updates.

The machine that activates the configuration downloads the components from the
cache. It builds or fetches the rest of the closure itself. The aggregate has no
provenance, because the workflow never builds it.

## Reusing builds from other caches

A [reuse view](./reuse-views.md) lets Nix look inside several of your tenant's
caches through one URL. If you set the `reuse-view` input, the workflow adds the
view to Nix as a second substituter, after the destination cache.

With `build: missing`, the run can use a target from the view instead of
building it. If that target is selected for publication, the workflow publishes
it to the destination
[by reference](./how-it-works.md#the-four-groups-in-the-log), without uploading
its NAR again. `build: rebuild` builds the requested output again in the
selected Nix store. Its dependencies may still come from the view or another
substituter.

Without the preset, the view is used on every run. With the preset, runs on the
branch use `pull-requests-<repository-id>` unless `reuse-view` specifies a
different view, and pull-request runs never use a view.

## Choosing publication behaviour

`build: rebuild` requires execution in the selected Nix store. For a remote
machine, set `store: ssh-ng://...`. A cohort with `remote: true` and no `store`
uses delegated builders, which can reuse outputs without executing their
builders. Planning rejects that combination with `build: rebuild` before any
cohort builds or publishes. See [Building elsewhere][building-elsewhere] for the
configuration.

[building-elsewhere]: ./building-elsewhere.md

Four inputs control how the workflow builds and publishes paths. Attestation
signing requires publication to be enabled. With `publish: none`, the workflow
builds without publishing paths or signing attestations. The defaults for
`substituter` differ between the flake workflow and the [simpler
workflow][simpler-workflow].

[simpler-workflow]: ./custom-jobs.md#the-simpler-workflow-cupboard-publishyml

| Input         | Values                                | Default here | Decision                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`       | `missing`, `rebuild`                  | `missing`    | `missing` uses an available output and builds it otherwise. `rebuild` builds each requested output again in the selected Nix store, even if it is already available. Dependencies may still be substituted.                                                                                                                                                         |
| `substituter` | `leave`, `copy`                       | `leave`      | `copy` selects outputs available from external substituters for publication. `leave` keeps an output upstream only if external consumers can obtain matching NARs for the output and all its runtime references under the configured signature policy. Outputs built in this run remain selected. A reuse view belongs to this tenant and can publish by reference. |
| `publish`     | `none`, `outputs`, `built`, `closure` | `built`      | `none` publishes no paths; `outputs` publishes selected output paths; `built` also publishes observed build intermediates and required dependency outputs available from configured tenant caches; `closure` also publishes all their runtime references.                                                                                                           |
| `attest`      | `true`, `false`                       | `true`       | Sign build provenance for builds observed on the runner and attach the bundles to published paths. Reused and substituted outputs receive no new build claim.                                                                                                                                                                                                       |

`push: false` is a compatibility alias that disables publication, even when
`publish` selects outputs, built intermediates or a closure. It also disables
signing.

| Build     | Substituter | Publish                         | Attest  | Result                                                                                                                                                                                                                                                                                                        |
| --------- | ----------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing` | `leave`     | `built`                         | `true`  | The defaults reuse available outputs, publish selected outputs, observed build intermediates and required tenant dependencies, and sign build provenance for builds observed on the runner. Eligible outputs from external substituters stay upstream. Paths from a reuse view can be published by reference. |
| `missing` | `copy`      | `closure`                       | `true`  | The published path set includes substituted outputs and runtime references. Only builds observed on the runner receive new build provenance.                                                                                                                                                                  |
| `rebuild` | `leave`     | `outputs`                       | `true`  | Each requested output is built again in the selected Nix store. The workflow publishes selected outputs and signs build provenance for builds observed on the runner. Dependencies may still be substituted.                                                                                                  |
| `rebuild` | `copy`      | `closure`                       | `true`  | Each requested output is built again and its runtime closure is published. Builds observed on the runner receive build provenance. Dependencies may still be substituted.                                                                                                                                     |
| Any       | Any         | `outputs`, `built` or `closure` | `false` | The workflow publishes the selected paths without signing new build provenance.                                                                                                                                                                                                                               |
| `missing` | Any         | `none`                          | Any     | The workflow publishes no paths or attestations. Available requested outputs can be reused.                                                                                                                                                                                                                   |
| `rebuild` | Any         | `none`                          | Any     | The workflow builds each requested output again but publishes no paths or attestations.                                                                                                                                                                                                                       |

For outputs already in the destination cache or a reuse view, `publish: closure`
reads narinfos to discover their runtime references. It publishes cached
references without copying NARs into the runner or remote builder. If a
reference is absent from both caches, the workflow uses the selected Nix store
or configured substituters to obtain the missing path before publication.

With `substituter: leave`, confirmation checks anonymous access to each narinfo
and its advertised NAR. Runner-only netrc or URL credentials do not establish
access for consumers. An anonymous authentication refusal stops cohort planning
before the build with exit status 77. Temporary failures and malformed provider
responses stop planning with exit status 75. To publish selected paths from a
cache that requires runner credentials, set `substituter: copy`. Nix can still
use those credentials to obtain build inputs.

With `substituter: leave`, an output left upstream does not select its closure
for publication. If another published output references that path,
`publish: closure` still includes it. With `build: rebuild`, the substituter
choice does not affect the requested outputs because the workflow builds them
again. For an output that Nix already has or substitutes, Nix rebuilds it in
check mode and compares the result with the existing output. The run fails if
they differ. A fresh output is built once. Reusing an available output without
building it creates no new build provenance, even when this run publishes it to
the destination.

The flake workflow defaults to `publish: built`. It publishes selected requested
outputs, intermediates reported by the post-build hook, and required dependency
outputs already available from the destination, configured tenant read caches or
reuse views. This selection includes transitive build-only dependencies and
applies when the target is reused without a build. Dependencies absent from
those tenant sources cause no additional build or download. Other substituted
intermediates are excluded. The run root protects the published intermediates;
only requested outputs enter target roots. A remote store or an untrusted local
daemon cannot report and protect every intermediate, so select
`publish: outputs` or `publish: closure` for those stores. To build each
requested output again and publish its runtime closure, set:

```yaml
with:
  build: rebuild
  substituter: copy
  publish: closure
  attest: true
```

The rebuild applies to each requested output. Nix may still fetch its
dependencies from substituters. `publish: closure` includes those dependencies
when the output is published.

### Building without publication

`publish: none` disables publication and signing. The boolean `push` input is
also supported: `push: false` disables both. To build every requested output
again without publishing it, set:

```yaml
with:
  publish: none
  build: rebuild
```

`publish: none` by itself allows Nix to use an available output. The workflow
skips signing automatically when publication is off. A missing attestation does
not cause an available output to be rebuilt. Set `build: rebuild` when the run
must execute every requested output in the selected Nix store.

The default `attest: true` signs build provenance for builds observed on the
runner. Set `attest: false` to disable signing. A build on a delegated builder
or a selected remote store does not produce runner-local SLSA provenance.
Eligible existing bundles are inherited without changing the original statement
or signature.

## Selecting the cupboard version

Call the workflow at an immutable release tag, such as `@v1.2.3`. The workflow
then installs the cupboard release that was published from its own commit,
preferring the tag that you called. It checks the release's checksums and
provenance before using it.

If there's no release for that commit, the workflow builds cupboard from the
commit instead. A workflow pinned by commit SHA works the same way: it installs
the release published from that commit, or builds cupboard from the commit if
there's no such release.

To use a different release, set `cupboard-version` to an exact release tag, or
to `latest`, which includes prereleases. Only do this if you really want the CLI
to differ from the workflow.

Once a release has been chosen, its checks are strict. If it fails them, the run
fails. The workflow never falls back to building from source.

## Building without publishing

To check that every requested output builds again, set `publish: none` and
`build: rebuild`. The run builds each requested output in the selected Nix
store, even when the output is already in the store or a substituter. Nix may
still substitute dependencies. The run publishes and signs nothing. A
local-store run does not need `rootDrvPath`.

If you only need to check that the targets can be realised, use `publish: none`
with the default `build: missing`. Nix can then use outputs that are already
available.

A build-only run makes no Cupboard publication request. With the
`pull-request-and-branch` preset, it reads from the tenant's default cache and
neither creates nor removes a pull-request cache. A public cache needs no read
grant. A private cache needs its exact `cache:content-read` grant or a static
read credential. A build-only run does not need publication grants.

## Making the most of the runners

These inputs help when a runner is short of disk space or needs extra
configuration:

- `maximise-space: true` deletes preinstalled software from the cohort runners
  before building, such as Xcode on macOS and language toolchains on Linux. This
  can't be undone, so only use it on ephemeral GitHub-hosted runners.
- `enable-packing: true` packs small single-target cohorts into as few jobs as
  fit within `pack-capacity` bytes of disk. It uses measured closure sizes. If
  the measurement fails, the manifest's cohorts are used as they are.
- `gc-between-cohorts: true` runs garbage collection on the runner's store after
  a cohort has published. This only happens on GitHub-hosted runners using their
  own store. It mostly helps best-effort cohorts, which build their targets one
  at a time.
- `plan-runner` sets the runner label for the configure, plan and cache-removal
  jobs.
- `nix-config` specifies a flake attribute containing extra `nix.conf` text for
  the plan and cohort jobs. For example, `.#ciNixConfig` might evaluate to
  `"http-connections = 64\n"`.

For outputs too large for a GitHub-hosted runner, see
[Building elsewhere](./building-elsewhere.md).

## Common tasks

### Moving to a new cupboard release

If your trust rules accept `refs/tags/v*`, as the quickstart sets them up, you
don't need to change the tenant. Check that the tenant accepts the new release,
then update the `uses:` line in your workflow. The workflow file doesn't call
the new release yet, so pass its reference as `--workflow-ref`. For release
`vA.B.C`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --root-prefix github:acme/app/main \
  --workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vA.B.C
```

[Checking one workflow reference](./github-check.md#checking-one-workflow-reference)
explains what this form of the check covers. After you update the workflow file,
run `cupboard github check` without `--workflow-ref` and `--root-prefix` to
check every publishing job.

If your tenant trusts one exact tag or commit instead, run
`cupboard github setup` with the new reference before you update the workflow.
Setup offers to remove the old rule, because the new one supersedes it. Say no
if runs using the old rule might still be in progress. You can remove it later
with `cupboard oidc-trust remove`.

### Adding a target or a platform

Add an entry to the manifest. You don't need to change the tenant, because the
trust rule already allows any root under the run's root prefix.

### Adding another repository to the same tenant

Run `cupboard github setup` for the new repository. It adds trust rules and a
reuse view for that repository. Each repository has its own view, so one
repository's `main` never picks up another repository's pull-request builds. If
you want repositories to share builds, see
[Sharing builds between repositories](./reuse-views.md#sharing-builds-between-repositories).

### Retaining closed pull-request outputs during grace

The preset closes caches for both merged and unmerged pull requests. Closure
starts the cache's configured grace period, so `main` can reuse the outputs
through the pull-request reuse view during grace. Publication to the main cache
retains reused paths independently of the closed cache.

Configure the tenant's default grace period before creating pull-request caches:

```sh
cupboard cache set-default-grace https://cupboard.example.workers.dev/t/acme \
  --grace 24h
```

Existing caches keep their grace settings. Use `cupboard cache set-grace` to
change an existing cache's grace period. Repeated close events do not restart
grace, and closure preserves existing later grace deadlines. Reopening restores
write access before the next publication. See [Cache creation defaults] and
[Closing and reopening caches].

[Cache creation defaults]: ../admin/caches.md#defaults-for-new-caches
[Closing and reopening caches]: ../admin/caches.md#closing-and-reopening-a-cache
