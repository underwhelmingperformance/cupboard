# Publishing a flake

`cupboard-flake-publish.yml` is a reusable GitHub Actions workflow. It builds a
list of your flake's outputs, publishes them to a cupboard cache, and signs a
record of how it built them (build provenance).

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
- [choose the cupboard version](#selecting-the-cupboard-version);
- [check that a manifest builds without publishing](#building-without-publishing);
- [make better use of runner disk space](#making-the-most-of-the-runners);
- [upgrade cupboard, add targets and add repositories](#common-tasks).

## Choosing where to publish

Every run publishes to one cache. Each target also gets a retention root, which
keeps the target in the cache (see [Retention](../admin/retention.md)). The
root's name is made of two parts: a **root prefix** shared by the whole run,
such as `github:acme/app/main`, followed by the target's own `rootSuffix` from
the manifest.

You can let the workflow pick the cache, the root prefix and how long the roots
last, based on the event that triggered the run. That's what the preset does. Or
you can set them yourself.

### Using the preset

Set `preset: pull-request-and-branch` to have the workflow choose the
destination from the event. This is what [the quickstart](./quickstart.md) uses.

- A pull request from the same repository publishes to a cache for that pull
  request, `gh-<repository-id>-pr-<number>`. The workflow creates the cache if
  it doesn't exist. Roots are named under `github:<repository>/pr-<number>/` and
  expire 14 days after the latest run. These runs don't read a reuse view.
- A run on the branch that the `branch` input specifies (`main` by default)
  publishes to the tenant's default cache. It doesn't matter which event started
  the run. Roots are named under `github:<repository>/<branch>/` and are
  permanent. These runs read through the reuse view
  `pull-requests-<repository-id>`, or the view that `reuse-view` specifies if
  you set that input.
- When an unmerged pull request is closed, the run removes that pull request's
  cache. When a merged pull request is closed, the run does nothing.
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

Without the preset, the workflow never creates or removes caches. The cache must
already exist. The trust rule that accepts the run must also allow roots under
your `root-prefix`.

### Publishing releases

You might want one cache that serves every tagged release, with each release
kept under its own root. Here's how to set that up.

1. Create the cache:

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
release has its own root, publishing a new release never releases an old
release's paths.

## The target manifest

The manifest is the list of targets that the workflow builds. A target is one
output to build and publish. By default, the workflow reads the manifest from
the flake attribute `.#cupboardOutputs`. To use a different attribute, set the
`targets` input.

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

`rootDrvPath` is required for every target except best-effort ones, and isn't
needed at all when `push` is false. It lets the plan job work from the
derivation directly, without evaluating each `attr` separately. Each cohort job
evaluates `attr` again later, and fails if it gives a different derivation.

### Building several targets in one job

Normally each target is built in its own job. To build several targets together,
give them the same `cohort` label. Targets that share a label are built in one
job, with one `nix build`. This group is called a cohort.

A cohort label can be up to 100 printable ASCII characters, without spaces.
Targets in the same cohort must have the same `system`, `os`, `remote` and
`bestEffort` values.

### Letting a target fail without failing the run

Set `bestEffort = true` on a target whose build is allowed to fail. If it fails,
the rest of the run still succeeds.

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

All the components share the aggregate's root. A root can keep at most 149
paths, and each output that you publish from each component counts towards that
limit. The plan refuses an aggregate with more than 149 components.

The machine that activates the configuration downloads the components from the
cache. It builds or fetches the rest of the closure itself. The aggregate has no
provenance, because the workflow never builds it.

## Reusing builds from other caches

A [reuse view](./reuse-views.md) lets Nix look inside several of your tenant's
caches through one URL. If you set the `reuse-view` input, the workflow adds the
view to Nix as a second substituter, after the destination cache.

When a target is already in one of the view's caches, the run doesn't build it.
It publishes the existing copy to the destination
[by reference](./how-it-works.md#the-four-groups-in-the-log), without uploading
it again.

Without the preset, the view is used on every run. With the preset, runs on the
branch use `pull-requests-<repository-id>` unless `reuse-view` specifies a
different view, and pull-request runs never use a view.

## Selecting the cupboard version

Call the workflow at an immutable release tag, such as `@v1.2.3`. The workflow
then installs the cupboard release that was published from its own commit,
preferring the tag that you called. It checks the release's checksums and
provenance before using it.

If there's no release for that commit, the workflow builds cupboard from the
commit instead. That's also what happens if you pin the workflow by commit SHA.

To use a different release, set `cupboard-version` to an exact release tag, or
to `latest`, which includes prereleases. Only do this if you really want the CLI
to differ from the workflow.

Once a release has been chosen, its checks are strict. If it fails them, the run
fails. The workflow never falls back to building from source.

## Building without publishing

To check that a manifest builds, set `push: false`. The run builds every cohort
directly. It doesn't consult the cache when planning, publishes nothing, signs
nothing, and doesn't need `rootDrvPath`.

The run still needs the same permissions, and a trust rule that accepts it.

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
then update the `uses:` line in your workflow. For release `vA.B.C`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --root-prefix github:acme/app/main \
  --workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vA.B.C
```

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

### Removing merged pull-request caches once they're empty

When a pull request is merged, its cache is kept so that `main` can reuse its
outputs. Its roots expire after 14 days, but the empty cache stays behind. To
have a cache removed once it's empty:

```sh
cupboard cache set-retirement https://cupboard.example.workers.dev/t/acme \
  gh-123456-pr-42 --when-empty true
```

Here `123456` is the repository ID and `42` is the pull request number. This is
a setting on each cache, and the preset doesn't set it for you. See
[Retiring empty caches](../admin/retention.md#retiring-empty-caches).
