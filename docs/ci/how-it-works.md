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
3. The cohort jobs realise the targets. There's one job per cohort, each on the
   runner that the cohort's `os` specifies. The `build`, `substituter`,
   `publish` and `attest` inputs decide what each job builds, publishes and
   signs.

When publication is enabled under the preset, closing a pull request runs the
configure job, then the close-cache job, whether the pull request was merged or
not. There's no planning, building or publication. Closure brings root expiry
forward to the close time and starts the cache's configured grace period. Reads
and reuse remain available during grace. Garbage collection removes expired
contents, then removes the empty cache once pending work has finished. See
[Closing and reopening caches][cache-closure].

[cache-closure]: ../admin/caches.md#closing-and-reopening-a-cache

Each job has a time limit:

| Job         | Runs on            | Time limit  |
| ----------- | ------------------ | ----------- |
| configure   | `plan-runner`      | 10 minutes  |
| plan        | `plan-runner`      | 30 minutes  |
| cohort      | each cohort's `os` | 180 minutes |
| close-cache | `plan-runner`      | 10 minutes  |

`plan-runner` is a workflow input, and defaults to `ubuntu-latest`.

If one cohort job fails, the others continue. GitHub doesn't cancel them. A run
can have at most 256 cohort jobs.

Every job that talks to cupboard signs in separately. It swaps the OIDC token
that GitHub gives the job for a short-lived cupboard token. That's why the
tenant needs a [trust rule](./trust-rules.md) that accepts the workflow.

## How targets are grouped into cohorts

A cohort is a set of targets processed together in one job. When its targets
need a build, the job passes them to `nix build` together. By default, every
target is a cohort of its own, so each target gets its own job. If you give
several targets the same `cohort` label in the manifest, they share a job
instead.

The plan job evaluates the manifest once, with `nix eval --json`, and checks it
before grouping the targets:

- Every target's `rootSuffix` must be different.
- Targets in the same cohort must have the same system, runner, and `remote` and
  `bestEffort` settings.
- No target may go over the limits on retention roots.

With `build: missing` and `publish: outputs`, the plan can omit a cohort when
its requested roots already retain the outputs that the destination cache
serves. With `publish: built`, cohort jobs still select required dependency
outputs from the configured tenant sources, even when all requested outputs are
cached. Available targets skip their builds inside the cohort. An attestation's
presence does not decide whether to build. With `build: rebuild`, each requested
output is built again on the configured builder, even if it is already
available. Nix may still substitute dependencies.

When a reference source is configured, the plan job also probes predictable
single-output targets in that cache. With `build: missing` and
`publish: outputs`, it publishes available targets by reference, sets their
retention roots, and removes those targets from the cohort matrix. A shared
component root is published only when every component is available. A failed
probe or publication leaves the affected targets in their cohorts. The plan
receipt and summary record the publications; a cohort with no remaining targets
does not start. Each remaining cohort keeps its independent drift check and
calculates its own build set.

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
4. It sorts the targets by how they are available, and prints the groups in the
   log. `build: rebuild` puts each requested output in the build work even if
   the output was already available.
5. It builds the requested outputs that the selected build mode requires. With
   `publish: outputs`, it publishes the selected outputs. With `publish: built`,
   it also publishes intermediates built during the run and required dependency
   outputs already available from configured tenant caches or reuse views.
   Dependencies absent from those sources cause no additional build or download.
   With `publish: closure`, it also publishes their runtime references. With
   `publish: none`, it publishes nothing.
6. After publication succeeds, it sets each published target's retention root.
7. With `attest: true`, it signs build provenance for builds observed on the
   runner plus an attribute report for successful local verification rebuilds,
   and attaches those bundles to the published paths. Signing and attachment
   happen after publication; a failure fails the job but does not remove paths
   from the cache.

### The four groups in the log

In step 4, each target ends up in one of these groups. The group names are the
labels that you'll see in the job's log.

| Log label                   | Which targets                                                                                         | What happens                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Already served by the cache | The destination cache already serves their outputs.                                                   | With `build: missing`, the run can set their roots without another build or upload. |
| Reused from the tenant      | Another cache in the reuse view serves their outputs.                                                 | The run can publish them by reference (see below).                                  |
| Left to upstream caches     | An external substituter serves their outputs and `substituter: leave` excludes them from publication. | Consumers need that substituter to fetch them.                                      |
| To build                    | The selected build mode requires a build for these outputs.                                           | The run builds them and publishes the selected paths unless `publish: none`.        |

Publishing by reference means the destination cache starts serving a store path
that your tenant already stores in another cache. The bytes aren't uploaded
again. The push must be able to read the stored NAR through the destination
cache, a public cache, a cache covered by `cache:content-read`, or a reuse view
covered by `view:content-read`. Otherwise cupboard asks for the bytes, and
publishing that target by reference fails because the run has no bytes to send.
See [Shared storage][shared-storage].

A path published this way gets no new build provenance from this run, because
this run didn't build it. If the source cache is public, the destination can
inherit its eligible attestations for the path. Inheritance preserves the
original bundle and signature. See [Attestations of reused
paths][reused-attestations].

[reused-attestations]: ./attestation.md#attestations-of-reused-paths
[shared-storage]: ../security.md#shared-storage

If an earlier run published a target but its signing step failed, a later run
with `build: missing` can still reuse the target. Set `build: rebuild` to build
each requested output again and produce new build evidence. Dependencies may
still be substituted.

### When a cache has lost a NAR

A cache serves a path only when it serves both the narinfo and the NAR at the
URL that the narinfo records. If the stored NAR has gone missing, a push that
uploads the path again stores the bytes under a new URL. Upload negotiation
checks the NAR in object storage, so the first push requests an upload even if
the cache still has a narinfo for the path. Publishing by reference cannot
replace a lost NAR because the run sends no NAR bytes.

Other caches that share the same NAR, in any tenant, may still have narinfos
that record the old URL. A Nix client that reads one of those caches gets a 404
for the NAR until the cache rewrites its narinfo. After the replacement upload,
the maintenance queue finds those caches and schedules the rewrite. The queue
retries failed work. A cache's periodic verification scan can also repair its
narinfo.

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
- If you rerun an `opened` or `synchronize` publishing run after its pull
  request has closed, an existing closed cache rejects publication. Use
  `cupboard cache reopen` before rerunning if you want to publish to it. A rerun
  of a `reopened` event explicitly reopens the cache again. If garbage
  collection has already removed the cache, the rerun creates an empty
  replacement. The pull request's earlier `closed` event does not close the
  replacement, so close it yourself with `cupboard cache close` after
  publication.

## Where to look when something goes wrong

The `cupboard-publication-<cohort key>` artifact contains the complete JSON
results from each cohort job, including every publication path. The
`cupboard-publish` workflow uses the artifact `cupboard-publication`. Failed
jobs upload these results too. Older CLI releases that do not write result files
skip the artifact.

- The run's summary page has a section for each job. The configure job lists the
  publication settings and the `nix.conf` lines for reading the destination
  cache. The plan job lists every target with its cohort job, runner and
  builder, and says whether the plan retained the target without building it.
  Each cohort job lists its targets with their outcome, the number of paths and
  bytes uploaded by the pushes that set their roots, and when their roots
  expire.
- Each cohort job's name gives its system, where it builds and its number of
  targets, such as `x86_64-linux on ubuntu-latest (2 targets)`. A cohort with
  one target gives the target's root suffix in place of the system and the
  count, such as `aarch64-linux/hello on ubuntu-24.04-arm`. For a remote build,
  the name gives the host of the builder or store in place of the runner.
- Each cohort job's log shows how the targets were grouped, what the job built
  and published, and why it refused to build, if it did. For example, it refuses
  when the runner has too little disk for the closure, or when too many paths
  can't be downloaded from any substituter.
- A cohort job that published nothing writes no receipt and signs nothing.
