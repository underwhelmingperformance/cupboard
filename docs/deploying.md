# Deploying a release

This document describes how `cupboard deploy` moves a live deployment from one
build to the next. See [docs/releases.md](./releases.md) for how the CLI
binaries themselves are built and published.

A deployment is a control Worker, a tenant Worker, one D1 database shared by
both, one Durable Object per tenant with its own SQLite store, and R2 for the
NAR bytes. A deploy applies the pending D1 migrations, uploads both Workers, and
leaves each tenant's object to apply its own migrations the next time a request
reaches it.

## Phases

A release that changes what a tenant's Durable Object stores cannot switch every
object over at once. Objects run at different times, and an object that has not
run since the previous release still stores the old shape. Such a release runs
its Workers in more than one configuration. `cupboard deploy` records the
configuration the deployed build runs in, called the phase, in D1, and a release
that defines more than one phase reads it from the Workers to choose their
behaviour.

One row of the `deployment_phase` table holds the phase. `cupboard deploy` reads
it before it applies a migration or uploads a Worker, and stops if the recorded
phase is one the build does not define. It writes the row once both Workers
serve the build it has just uploaded, which it establishes by reading the
traffic split of the current deployment from the [Workers deployments API]. A
gradual deployment can still be splitting a script's traffic between two
versions, and there is then no single build to record a phase for; the deploy
stops and names the script to wait for, and running it again once the rollout
has finished records the phase. Every step the deploy takes is idempotent, so an
interrupted run is rerun with no repair step.

[Workers deployments API]:
  https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/

This build records `native-reads` after every active tenant completes the
required local data work. In that phase, reads use cache identities. The build
also recognises `current`, for builds without phase coordination, and
`expanded`, which earlier builds recorded after populating the cache identity
columns. `contracted` is recognised so stored grants can preserve their old
spelling until the schema contracts; this build does not record that phase.

## Local steps

`tenant.local_step` records how far each tenant's Durable Object has advanced
its own store. An object applies its pending migrations whenever it runs, but it
records its step only when the control Worker asks it to: the `localStep.wake`
procedure wakes a bounded batch of the tenants that are behind, and the hourly
cron sweep wakes twenty per tick, so a deployment with N active tenants has
every step recorded after about N / 20 ticks, later if some wakes fail.
`localStep.status` counts the tenants at the current step and names up to twenty
of those below it.

The stored step is a watermark: rolling back to a build that defines fewer steps
does not lower what a newer build recorded. This build requires step 3. It
repeats the identity reconciliation and projects missing `cache_lifecycle` rows
to D1, at most 36 per wake. It then copies live cache generations from D1 to the
local identities, moves private-cache objects off their old `private/` keys, and
moves objects of caches above generation 1 to their generation keys. Each object
move processes at most 100 objects per wake; a tenant with more work records its
step on a later wake.

A path whose object has not reached its new key returns 404. The move or a new
push makes it available there. After deploying, run `localStep.wake` until
`localStep.status` reports every tenant ready, or wait for the hourly sweep.

`cupboard deploy` records a phase only once every active tenant has recorded the
step the build requires. It checks after both Workers serve the build and stops
with `LocalStepUnreachedError`, naming up to twenty of the tenants that are
behind, while any is. A deploy may stop there while tenants finish the new work.
Run it again once `localStep.status` reports none pending.

## Rolling back

Objects moved to generation keys are not moved back by a rollback. The previous
build cannot read those keys or remove them during teardown. If it publishes
objects at the old keys, redeploying this build does not automatically move
them: a tenant already at step 3 is not revisited. Those objects need explicit
recovery before they can be read at the generation keys.

Rolling back means serving an older build of both Workers, whether by running
`cupboard deploy` of that build or by the Workers rollback feature. D1, R2 and
the Durable Objects are not rolled back: the recorded phase and every tenant's
step stay as they were.

A rollback past a release that added a phase leaves a phase name the earlier
build does not define. That build serves reads and writes as usual, but its
`deployment.phase` control procedure returns an error and `cupboard deploy` of
that build stops before applying a migration or uploading a Worker. Deploying a
build that defines the phase clears both.

Each tenant's recorded step stays as it was. Deploying a build that requires
that step again does not wake those tenants, so anything the older build wrote
in between that the step would have repaired stays unrepaired. For this release
that means a cache the older build registered keeps no identity, and the
contraction that follows refuses such an object.

A rollback past a release that added a Durable Object migration leaves each
object that ran under the newer build with migrations the older build does not
carry. The older build admits such an object when the newer build recorded each
of those migrations with the digest it applied, which every build from this one
on does. An object whose extra rows carry no digest is refused, and that
tenant's requests fail until a build that carries the migrations is deployed
again.

A migration that drops a column or a table cannot be undone by redeploying, so a
release that contracts the schema documents its own recovery here alongside the
phase that performs it.

### Rolling back with stored cache grants

This release identifies the cache in a stored grant by its scope,
`{"kind":"default"}` or `{"kind":"named","name":...}`. The preceding build
stored a selector string (`_default`, a public cache's name, `_private-<name>`)
and parses a stored grant strictly, so it cannot read a row in the scope
spelling. The rows are the trust rules in each tenant's `oidc_trust`, the grants
each refresh-token family recorded in `refresh_token_family`, and the control
plane's trust rules in D1 (`control_trust`). This build reads both spellings.

Nothing is rewritten while this build is deployed. Until a deploy records
`contracted`, a tenant's object stores a new rule or refresh-token family in the
selector spelling. An existing named cache uses its current access: a private
cache `ci` is stored as `_private-ci`. A cache that does not yet exist uses both
`ci` and `_private-ci`, because its eventual access is unknown. Named templates
also use both selector forms, so the preceding build can match either access
mode. This build converts both variants back to scopes and deduplicates them.

The control plane uses the same conversion for new control rules. It cannot
resolve a tenant cache's access, so every named cache uses both selector forms.
If a template is too long to include the private selector prefix in the
preceding format, adding the rule returns `CACHE_GRANT_MIGRATION_PENDING` (409).
Complete the deployment before adding that rule. Rules that can be stored in the
preceding format remain readable after rollback, with both public and private
template matches preserved.

The rewrite of the stored rows to the scope spelling is a contraction. It runs
in the `contracted` phase of this release's deploy, after both Workers serve the
new build and every active tenant has reached the required step: the D1
migration that rewrites `control_trust` and the per-object step that rewrites
`oidc_trust` and `refresh_token_family`. From then on rows are stored in the
scope spelling only. A rollback after that phase restores a build that cannot
read the rows, so recovery requires deploying this release again or restoring
storage from before the contraction.
