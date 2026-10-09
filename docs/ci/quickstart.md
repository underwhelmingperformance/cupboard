# Publishing from GitHub Actions: quickstart

This guide walks you through setting up a GitHub repository so that its CI
builds your flake and publishes the results to cupboard. When you've finished:

- Each pull request gets a cache of its own, and its builds are published there.
  Closing the pull request expires its roots and starts its configured grace.
  Reads and reuse remain available during grace, including after a merge.
- Each push to `main` publishes to your tenant's default cache. Nix users
  normally read from that cache. If a pull request has already built exactly the
  same outputs, the `main` run reuses them instead of building them again.

You don't need to write the build steps yourself. cupboard provides a reusable
GitHub Actions workflow, `cupboard-flake-publish.yml`, that realises the
outputs, publishes selected paths, and signs evidence for observed builds and
new publications. Your repository calls that workflow from a short workflow file
of its own.

The examples use the tenant `acme` at
`https://cupboard.example.workers.dev/t/acme` and the repository `acme/app`.
Replace them with your own.

## Before you start

You'll need:

- A cupboard tenant, and the `cupboard` CLI signed in as one of its
  administrators. See [Installing the CLI](../installing.md) and
  [Signing in](../admin/signing-in.md).
- A repository on github.com with a flake at its root. The reusable workflows
  don't run on GitHub Enterprise Server or GHE.com.

This guide assumes anyone can read your tenant's caches. If your caches are
private, get this setup working first, then follow
[Private caches in CI](./private-caches.md).

## 1. Choose a cupboard release

Pick a release tag from the
[releases page](https://github.com/underwhelmingperformance/cupboard/releases).
Your workflow will call cupboard's reusable workflow at that tag. The examples
on this page write it as `vX.Y.Z`.

## 2. Configure the tenant

Your tenant has to know which CI runs it should accept. Run
`cupboard github setup` to configure that:

```sh
cupboard github setup https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'
```

This adds three things to your tenant. Two of them are
[trust rules](./trust-rules.md). A trust rule tells the tenant which GitHub
Actions jobs to accept, and what each one is allowed to do.

- The **pull-request trust rule** accepts pull-request runs from `acme/app`.
  Each run can create its pull request's cache, publish to it, close it, and
  reopen it. The cache is called `gh-<repository-id>-pr-<number>`, where
  `<repository-id>` is GitHub's numeric ID for the repository.
- The **branch trust rule** accepts runs of the workflow on `main` and lets them
  publish to the default cache. This covers pushes, manual runs and scheduled
  runs.
- The **reuse view**, `pull-requests-<repository-id>`, lets a `main` run look
  inside all of the repository's pull-request caches at once. This is how `main`
  finds outputs that a pull request has already built.
  [Reuse views](./reuse-views.md) explains them in more detail.

Each rule also limits which retention roots a run can set. A retention root is a
name that keeps store paths in a cache. While the root exists, cupboard won't
delete the paths that it points to (see [Retention](../admin/retention.md)). A
pull request's runs can set roots whose names start with
`github:acme/app/pr-<number>/`. Runs on `main` can set roots starting with
`github:acme/app/main/`.

A few things to know about `github setup`:

- It looks up the repository on GitHub to find its numeric ID. The rules use the
  ID because it doesn't change if the repository is renamed. For a private
  repository, set `GH_TOKEN` or `GITHUB_TOKEN` to a token with permission to
  read it. A non-empty `GH_TOKEN` takes precedence over `GITHUB_TOKEN`. GitHub
  also returns 404 when a private repository is inaccessible, so check the
  repository name and the token's access if the command reports that it was not
  found.
- Temporary GitHub failures exit with status 75. Check [GitHub Status] and try
  again. For a connection failure, also check your network connection.
- The root names include the repository's name, so if you rename the repository,
  run `github setup` again.
- It's safe to run again. It reports what's already in place. The exception is a
  reuse view with the same name but a different definition: the command shows
  you the difference, makes no changes, and exits with an error.

[GitHub Status]: https://www.githubstatus.com/

### Why the workflow reference ends in `v*`

The `--workflow-ref` option says which workflow the rules trust. Here it's
cupboard's reusable workflow at any tag whose name starts with `v`. That means
you can move to a later cupboard release without changing your tenant.

The trade-off is that anyone who can push a `v` tag to
`underwhelmingperformance/cupboard` is inside your tenant's trust boundary.
Also, a caller that pins the workflow by commit SHA won't match these rules.
[Trusting a reusable workflow](./trust-rules.md#trusting-a-reusable-workflow)
explains the alternatives.

## 3. List the outputs to publish

The workflow needs to know which flake outputs to build. You tell it by adding a
list called `cupboardOutputs` to your flake's outputs. Each entry in the list is
a **target**: one output to build and publish.

Here's a flake with one package and one target:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }: {
    packages.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.hello;

    cupboardOutputs = [
      {
        attr = ".#packages.x86_64-linux.default";
        rootDrvPath = self.packages.x86_64-linux.default.drvPath;
        system = "x86_64-linux";
        os = "ubuntu-latest";
        rootSuffix = "x86_64-linux/default";
      }
    ];
  };
}
```

Each field does this:

- `attr` is what to build, written as you'd pass it to `nix build`.
- `rootDrvPath` is the derivation that `attr` evaluates to. When the workflow
  builds the target, it checks that `attr` still evaluates to this derivation.
- `system` is the Nix system that the target is built for.
- `os` is the label of the GitHub Actions runner to build it on.
- `rootSuffix` is the last part of the target's retention root name. The
  workflow puts it after the run's prefix, so on `main` this target's root is
  `github:acme/app/main/x86_64-linux/default`. Each target needs a different
  `rootSuffix`.

Add an entry for each output and each system that you want to publish.
[The target manifest](./flake-publish.md#the-target-manifest) describes the
other fields that you can use.

## 4. Add the workflow

Create a file called `.github/workflows/cupboard.yml` in your repository:

```yaml
name: cupboard

on:
  # `closed` starts grace; `reopened` restores publication access.
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [main]

permissions: {}

# The reusable workflow sets no concurrency group of its own.
concurrency:
  group:
    cupboard-${{ github.workflow }}-${{ github.event.pull_request.number ||
    github.ref }}
  cancel-in-progress:
    ${{ github.event_name == 'pull_request' && github.event.action != 'closed'
    }}

jobs:
  publish:
    # The preset refuses pull requests from forks. Skip them instead of
    # reporting a failure.
    if: >-
      github.event_name != 'pull_request' ||
      github.event.pull_request.head.repo.id == github.repository_id
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/acme
      preset: pull-request-and-branch
      trusted-public-key: cupboard-acme-1:...
```

Then fill in your own values:

1. Replace `vX.Y.Z` with the release that you chose in step 1. This also decides
   which version of the CLI the workflow uses: it installs the cupboard release
   that was published from the same commit.
2. Replace the URL with your tenant URL.
3. Replace `cupboard-acme-1:...` with your tenant's public signing key. You can
   print it with:

   ```sh
   curl -fsS https://cupboard.example.workers.dev/t/acme/pubkey
   ```

   If you leave `trusted-public-key` out, each job fetches the key from the
   tenant when it starts and trusts whatever it receives.

### What the preset does

The `preset: pull-request-and-branch` line tells the workflow to decide where to
publish based on what triggered the run. Without it, you'd have to set the cache
and root names yourself. The other defaults use available outputs, leave outputs
from external substituters upstream, publish selected outputs plus observed
build intermediates and required dependency outputs available from tenant
caches, and sign build provenance for builds observed on the runner. Reused or
substituted outputs receive no new build claim. You can change each decision
with `build`, `substituter`, `publish` and `attest`; see
[Choosing publication behaviour](./flake-publish.md#choosing-publication-behaviour).
For pull request `#42` and for `main`, the preset does this:

| Event                         | Publishes to               | Retention root                   | Kept for                     |
| ----------------------------- | -------------------------- | -------------------------------- | ---------------------------- |
| Pull request `#42`            | `gh-<repository-id>-pr-42` | `github:acme/app/pr-42/<suffix>` | 14 days after the latest run |
| Run on `main`                 | the default cache          | `github:acme/app/main/<suffix>`  | permanently                  |
| Pull request closed or merged | none                       | roots expire at the close time   | configured cache grace       |
| Pull request reopened         | `gh-<repository-id>-pr-42` | `github:acme/app/pr-42/<suffix>` | 14 days after the new run    |

Closing a cache rejects publication and retention extension. GC removes expired
contents after grace and deletes the empty cache when pending work has finished.
A `main` run can reuse PR outputs during grace and retain them in the default
cache. Reopening restores writes; it does not extend the previous roots. See
[Cache closure][cache-closure].

[cache-closure]: ../admin/caches.md#closing-and-reopening-a-cache

A pull-request run only reads from its own cache and from upstream caches such
as cache.nixos.org. Only runs on `main` look through the reuse view. That way,
one pull request never picks up another pull request's builds.

The preset fails any run that isn't either a pull request from this repository
or a run on `main`. The `on:` section above keeps other branches and tags from
starting a run in the first place.

Two things to watch out for:

- Don't trigger the workflow on `pull_request_target`. The preset would treat
  that run as a run on `main`.
- If you publish from a branch other than `main`, change `on.push.branches`,
  pass the branch name to the workflow as the `branch` input, and pass
  `--branch` to `cupboard github setup` and `cupboard github check`.

### How the concurrency setting behaves

The `concurrency` section uses one group per pull request within this workflow.
The pull request number stays the same when a merge changes `github.ref` to the
base branch. A newer publishing run cancels an older publication for the same
pull request. A `closed` run waits for active publication to finish before it
closes the cache.

On `main`, runs use a separate group and wait for each other. GitHub keeps at
most one waiting run per group. If several commits are pushed to `main` while a
run is in progress, only the newest of them is published. The intermediate runs
are skipped.

Custom callers that manage PR caches must use the same ordering: all events for
one pull request share a workflow-specific group, and a `closed` event must not
cancel active publication. Historical reruns can still reopen or recreate a
cache after closure. See [Rerunning and cancelling][rerunning].

[rerunning]: ./how-it-works.md#rerunning-and-cancelling

## 5. Check the setup

Before you open a pull request, check that the tenant will accept the runs.
Commit the workflow file and the flake change to a new branch, and push the
branch without opening a pull request yet. The workflow only runs for pull
requests and pushes to `main`, so pushing the branch starts no run. Then check
the branch:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app \
  --branch add-cupboard
```

Here `add-cupboard` is the name of your branch. Without `--branch`, the command
reads the repository's default branch, which doesn't have the new workflow file
yet.

The command reads the workflow files on the branch, and finds every job that
publishes to this tenant. For each job, it works out what a run would present to
the tenant and ask it for, and checks that against your trust rules and reuse
view. After `cupboard github setup`, the job in the workflow file from step 4
passes.

If a job fails, the command lists it and exits with status 1. For example, if no
trust rule accepts the publishing job from step 4, this excerpt shows the failed
job and repair hint. The context rows are omitted:

```text
.github/workflows/cupboard.yml, publish: failed: pull_request: the job condition limits the job to pull requests from this repository; the check does not model pull requests from forks; pull_request: no rule pins this repository; push: no rule pins this repository
Review a repair: cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app --branch add-cupboard --fix
```

To see the tenant changes that would fix failures like these, and apply them
after you confirm, run the check again with `--fix`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app \
  --branch add-cupboard --fix
```

Because the branch isn't merged yet, the repair shows that its planned rules
come from an unmerged branch, and applies them only after you confirm at a
terminal.

[Checking publishing jobs](./github-check.md) explains what the check covers,
which jobs it can only report for manual review, and what the repair changes.

## 6. Try it out

Open a pull request from the branch. Its run should publish to a cache called
`gh-<repository-id>-pr-<number>`.

When you merge the pull request, the `main` run starts. Its work is split into
jobs, one for each group of targets. Each job's log shows how many targets were
already served by the destination, reused from the pull-request caches, left to
upstream caches or built. When the derivations match, "Reused from the tenant"
can show outputs published by reference without rebuilding them. A target that
the destination already serves appears in "Already served by the cache" instead.

Publishing by reference requires `main` to have the same derivations as the pull
request. The run may build an output if `main` has moved on, or if the output
depends on the commit itself, for example through `self.rev`. Investigate
unexpected rebuilding by comparing the derivations and publication logs from the
pull request and `main`.

If a run is refused, see
[Troubleshooting](../troubleshooting.md#ci-publication).

## Next steps

- [How a publication run works](./how-it-works.md) explains what the workflow
  does during a run, and how to read its logs.
- [Publishing a flake](./flake-publish.md) covers other places to publish,
  publishing releases, and the full list of target fields.
- [Private caches in CI](./private-caches.md) covers private caches.
- [Building elsewhere](./building-elsewhere.md) covers remote builders and
  remote stores, for outputs too large for a GitHub-hosted runner.
- [Attestations](./attestation.md) explains what the signed provenance says and
  how to verify it.
- [Trust rules](./trust-rules.md) and [Reuse views](./reuse-views.md) explain
  what `github setup` created, and how to set up trust rules and reuse views by
  hand.
