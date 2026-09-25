# How a publication run works

This page explains what `cupboard-flake-publish.yml` does during a run. It
should help you read the run's logs and predict what a run will build.
[The quickstart](./quickstart.md) sets the workflow up, and
[Publishing a flake](./flake-publish.md) covers its options.

## The shape of a run

A run happens in two stages. First, a pair of small jobs works out what the run
has to do. Then the actual build work is spread across as many jobs as it needs,
running side by side.

1. The configure job checks the workflow's inputs and works out where the run
   publishes: which cache, which retention root names, and how long the roots
   last. It also chooses which cupboard release to install.
2. The plan job evaluates your list of targets (the `cupboardOutputs` manifest)
   and splits the targets into groups called cohorts, which are explained below.
   When you use the preset, this is also where a pull request's cache is
   created.
3. The cohort jobs do the building. There's one job per cohort, each on the
   runner that the cohort's `os` specifies. Each job builds its targets,
   publishes them, and signs their provenance.

When an unmerged pull request is closed, the run is different. The configure job
runs, then a remove-cache job removes the pull request's cache. There's no
planning or building. When a merged pull request's `closed` event arrives, only
the configure job runs.

Each job has a time limit:

| Job          | Runs on            | Time limit  |
| ------------ | ------------------ | ----------- |
| configure    | `plan-runner`      | 10 minutes  |
| plan         | `plan-runner`      | 30 minutes  |
| cohort       | each cohort's `os` | 180 minutes |
| remove-cache | `plan-runner`      | 10 minutes  |

`plan-runner` is a workflow input, and defaults to `ubuntu-latest`.

If one cohort job fails, the others continue. GitHub doesn't cancel them. A run
can have at most 256 cohort jobs.

Every job that talks to cupboard signs in separately. It swaps the OIDC token
that GitHub gives the job for a short-lived cupboard token. That's why the
tenant needs a [trust rule](./trust-rules.md) that accepts the workflow.

## How targets are grouped into cohorts

A cohort is a set of targets that are built together, in one job, with a single
`nix build`. By default, every target is a cohort of its own, so each target
gets its own job. If you give several targets the same `cohort` label in the
manifest, they share a job instead.

The plan job evaluates the manifest once, with `nix eval --json`, and checks it
before grouping the targets:

- Every target's `rootSuffix` must be different.
- Targets in the same cohort must have the same system, runner, and `remote` and
  `bestEffort` settings.
- No target may go over the limits on retention roots.

The plan doesn't skip targets that the cache already has, even when their roots
are set. A retention root shows that the cache keeps a target's outputs, but not
that their build provenance was attached, so a run that failed after publishing
would otherwise never attach it. Every cohort gets a job, and that job checks
the cache for each target's outputs and their build provenance, and builds a
target that lacks either.

If you turn on `enable-packing`, the plan works differently. It measures the
size of each target's closure, and packs small unlabelled cohorts into as few
jobs as will fit within `pack-capacity` bytes of disk.

## What a cohort job does

Each cohort job goes through these steps:

1. It installs Nix. If the workflow's inputs ask for them, it also sets up SSH
   for remote builders, a remote store, and private flake inputs.
2. It adds the destination cache to Nix's substituters. If the run uses a reuse
   view, it adds that too, after the destination.
3. It evaluates each target's `attr` again, and fails if the result no longer
   matches the `rootDrvPath` that the plan used. This catches a flake that
   changed between jobs.
4. It sorts the targets into four groups, described below, and prints how many
   are in each.
5. It builds the targets in the "To build" group. The job publishes every path
   as Nix finishes building it, not just the targets themselves.
6. Once the build has succeeded and every target is available, it sets each
   target's retention root.
7. It signs attestations for the paths that it built, and attaches the
   attestations to those paths in the cache.

### The four groups in the log

In step 4, each target ends up in one of these groups. The group names are the
labels that you'll see in the job's log.

| Log label                   | Which targets                                                                                                  | What happens                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Already served by the cache | The destination cache already has them, with build provenance attached.                                        | Their roots are set. Nothing is built or uploaded. |
| Reused from the tenant      | Another cache in the reuse view has them.                                                                      | They're published by reference (see below).        |
| Left to upstream caches     | The runner already has them, and an upstream cache such as cache.nixos.org serves them with a valid signature. | They're left there, and not copied into cupboard.  |
| To build                    | Everything else.                                                                                               | They're built, published and attested.             |

Publishing by reference means the destination cache starts serving a store path
that your tenant already stores in another cache. The bytes aren't uploaded
again. A target published this way gets no build provenance from this run,
because this run didn't build it. Instead, its build-origin attestation records
where it came from. If the other cache is public, the destination also inherits
that cache's attestations for the path, including its build provenance. See
[Attestations of reused paths](./attestation.md#attestations-of-reused-paths).

Sometimes the destination has a target but no provenance for it. This can happen
if an earlier run's signing step failed. The job lists these targets as "Served
but not attested", and treats them as "To build". It rebuilds only the target's
final derivation, substituting its dependencies, so that the job has a build to
sign.

### When a cache has lost a NAR

A cache serves a path only when it serves both the narinfo and the NAR at the
URL that the narinfo records. If the stored NAR has gone missing, a push that
uploads the path again stores the bytes under a new URL. In the cache that
receives the push, the first push skips a path whose narinfo still records the
lost NAR. The cache then removes that narinfo in the background, and a second
push uploads the bytes. Publishing by reference can't replace a lost NAR,
because the run has no copy of the bytes.

Other caches that share the same NAR, in any tenant, keep narinfos that record
the old URL. A Nix client that reads one of those caches gets a 404 for the NAR
until the cache rewrites the narinfo. Each cache rewrites it the next time it
checks that the path is servable: for example, shortly after the path is pushed
to that cache again, during the cache's periodic verification scan, or when a
retention root that includes the path is set.

## Sharing work between cohorts: the run root

Cohorts run in parallel, and they often share dependencies. To avoid building
the same dependency twice, every cohort job adds each path that it publishes to
one shared retention root for the whole run, called the run root. Its name is
`<root-prefix>/_cupboard-run/<run-id>`.

When a cohort needs a dependency that another cohort has already published, the
cohort downloads the dependency from the cache instead of building it again. The
run root keeps those paths in the cache, so they're still there when a later
cohort needs them.

The run root lasts for `run-root-ttl`, which is 24 hours by default. You can
keep it permanently instead with `run-root-permanent: true`, and `run-root-ttl`
set to an empty string.

The run root is named after the run, not the attempt. If you rerun failed jobs,
they share the same run root as the original attempt.

## Rerunning and cancelling

- If you rerun a run, it publishes that run's commit again. Setting a root
  replaces what it points to. So if you rerun an older `main` run, `main`'s
  roots go back to pointing at that older commit's outputs.
- If you cancel a run, whatever it has already published stays in the cache,
  kept by the run root. The roots of targets that it hadn't finished stay as
  they were.
- If you rerun a pull request's run after the pull request was closed without
  being merged, the run recreates the pull request's cache. The workflow doesn't
  remove the cache a second time, so remove it yourself with
  `cupboard cache remove`.

## Where to look when something goes wrong

- The plan job's summary shows the number of targets, and each cohort job is
  named after its cohort.
- Each cohort job's log shows how the targets were grouped, what the job built
  and published, and why it refused to build, if it did. For example, it refuses
  when the runner has too little disk for the closure, or when too many paths
  can't be downloaded from any substituter.
- A cohort job that published nothing writes no receipt and signs nothing.
