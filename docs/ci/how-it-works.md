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

The preset uses the default cache as the reference source for PR runs. A
matching target can be published to the PR cache by reference without
downloading its NAR. Branch runs build outputs without reading PR caches by
default. [Trusted-contributor reuse][trusted-reuse] selects only the cache of
the merged PR whose merge commit matches the branch push SHA. A PR controls its
own `nix-config` and builders, so this mode requires trust in contributors.

[trusted-reuse]: ./flake-publish.md#reusing-a-merged-pull-requests-outputs

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

The plan job first discovers the number of targets, then evaluates at most four
at a time with `nix eval --json`. It assembles the original target objects in
manifest order and checks the complete list before planning any cohort. Private
reads use one renewing credential session for count discovery and every target.
With `publish: none`, Nix removes each target's top-level `rootDrvPath` before
JSON conversion. Planning checks the following constraints:

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

With `build: missing` and `publish: built`, the plan job publishes nothing from
the reference source. The cohort job publishes those targets by reference,
together with their dependency outputs. With `maximise-space: true`, the plan
job also probes the reference source for single-output targets that the
destination cache does not serve, and its summary marks each available target as
"Published by reference in the cohort". If the probe fails, the plan job prints
a warning, and the cohorts of those targets free disk space. Each cohort job
checks the reference source itself either way.

The plan also tells each cohort job whether it may build. With `build: missing`,
a cohort job builds no target when every target selects one output and the
destination cache or the reference source serves that output. With
`maximise-space: true`, such a cohort job skips freeing disk space. It frees
disk space as usual with `publish: closure` or `publish: none`, where the plan
probes neither cache, and when the workflow builds cupboard from source or
installs a release whose `plan cohort` does not accept `--complete-targets`. A
cohort job that skips the step still evaluates its targets. The cohort job also
checks availability itself. If a path disappears between the two jobs, the
cohort job warns, then builds the path without the extra disk space or refuses
the cohort when the store has too little free space. Re-running only that job
reuses the same plan, so re-run the whole workflow.

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
   changed between jobs. With `reuse-plan-derivations: true`, it imports the
   plan job's derivations instead; see
   [Importing the plan job's derivations](#importing-the-plan-jobs-derivations).
4. On macOS with `maximise-space`, it waits for the background removal of
   preinstalled software to finish. See [how a macOS cohort frees disk space in
   the background][background-removal].
5. It sorts the targets by how they are available, and prints the groups in the
   log. `build: rebuild` puts each requested output in the build work even if
   the output was already available.
6. It builds the requested outputs that the selected build mode requires. With
   `publish: outputs`, it publishes the selected outputs. With `publish: built`,
   it also publishes intermediates built during the run and required dependency
   outputs already available from configured tenant caches or reuse views.
   Dependencies absent from those sources cause no additional build or download.
   With `publish: closure`, it also publishes their runtime references. With
   `publish: none`, it publishes nothing.
7. After publication succeeds, it sets each published target's retention root.
8. With `attest: true`, it signs build provenance for builds observed on the
   runner plus an attribute report for successful local verification rebuilds,
   and attaches those bundles to the published paths. Signing and attachment
   happen after publication; a failure fails the job but does not remove paths
   from the cache.

### How a macOS cohort frees disk space in the background

The removal of Xcode and the simulator runtimes takes minutes on a macOS runner.
The prepare step starts the removal in the background and returns at once, so
installing Nix and setting up cupboard run while the removal frees space. The
cohort job evaluates its targets, and then waits for the removal to finish. The
wait comes before the store capacity check and before any build of the targets,
and the log shows it as "Waiting for disk space to be freed". If the removal
failed, or did not finish within 20 minutes, the cohort job fails at that point
with the output of the removal.

Two kinds of work run before the wait. A flake whose evaluation builds or
downloads large derivations (import from derivation) evaluates while the removal
is still freeing space. A cupboard that the workflow builds from source is also
built during setup, before the wait. On Linux, the cleanup runs in the
foreground before the job installs Nix.

[background-removal]: #how-a-macos-cohort-frees-disk-space-in-the-background

### The four groups in the log

In step 5, each target ends up in one of these groups. The group names are the
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

### Importing the plan job's derivations

With `reuse-plan-derivations: true`, the plan job copies the derivations of
every cohort in the matrix from its store into a binary cache, together with the
sources that those derivations reference. It packs the cache into one file and
uploads the file as an artifact that expires after one day. Each cohort job
downloads the artifact by its ID, which only the plan job can output, and copies
the derivations of its targets into the runner's store. It then deletes the
artifact and its unpacked copy to free the disk space, and plans and builds as
usual. It builds every target that has a derivation in the plan from that
derivation, so it evaluates none of those targets. When the plan exports
nothing, for example with `publish: none`, the cohort jobs evaluate their
targets as described in step 3.

The cohort job takes the derivation paths from the cohort matrix, not from the
artifact. Derivations and the sources that they reference are content-addressed:
each content address and its references produce the path's store path, so a path
can be checked without a signature. A derivation can also reference a path that
is not content-addressed, such as a build output that the flake reads during
evaluation, which import from derivation produces. Such a path needs a signature
from a trusted key, either one in `trusted-public-keys` or the public half of a
readable key in `secret-key-files`.

Both jobs apply this rule with `nix store verify`, using the keys that their own
Nix configuration trusts. The plan job checks the closure in its store before
the upload, and fails when a path has neither a matching content address nor a
trusted signature. Set `reuse-plan-derivations: false` for such a flake. Before
it copies anything, the cohort job checks the closure in the artifact, so Nix
reads the artifact as it does during the copy. A Nix daemon whose configuration
turns `require-sigs` off would not make this check for an untrusted client. Nix
then checks each copied path against its NAR hash and content address, so the
cohort job fails when the artifact lacks a path or contains a changed one.

The artifact contains the sources that the derivations reference, including
sources from private flake inputs. Anyone who can read the repository can
download a workflow artifact, so leave `reuse-plan-derivations` off in a public
repository whose flake has private inputs.

A cohort job that imports the derivations skips the check in step 3 that each
target still evaluates to the plan's `rootDrvPath`. `nix build` still evaluates
a target that has no derivation in the plan, such as a best-effort target that
did not evaluate. The prepare step still evaluates `nix-config`.

The plan job's "Exporting the cohort derivations" log group shows how long the
check, the copy and the packing took. The cohort job's "Importing the plan job's
derivations" log group shows how long the unpacking, the check and the copy
took. These durations are also in the diagnostic logs. The upload and the
download are separate workflow steps, so the job log shows their times too. The
artifact expires after one day. If you re-run a cohort job after that, it fails
at the download, so re-run the whole workflow instead.

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
  builder. It says whether the plan retained the target without building it,
  published it by reference, or left it for its cohort job to publish by
  reference. Each cohort job lists its targets with their outcome, the number of
  paths and bytes uploaded by the pushes that set their roots, and when their
  roots expire.
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
- To inspect cache read probes, re-run the failed job with debug logging
  enabled. The log reports each probe attempt with its outcome and duration, and
  each retry with its delay. For a retry after a transient HTTP status, the log
  also shows the status and any `cf-ray` header. For a retry after a network
  error, it shows the error code. An attempt whose response body failed partway
  has the outcome `body failed` and the error code. The actions also pass
  `--debug` to each `cupboard` command, if the installed release accepts it.
  Releases before v0.0.36 do not.
