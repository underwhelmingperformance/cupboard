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

This build defines two phases, in the order a release records them: `current`
for a build that needs no such coordination, and `expanded`. `expanded` means
that every active tenant has recorded local step 1, described below, so every
registered cache has an identity and every row present when the tenant was woken
carries its `cache_id` beside the stored cache name. A release that adds a phase
adds it to that list and documents here how the build behaves while that phase
is recorded.

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
does not lower what a newer build recorded. This build defines step 1. When
woken, an object creates an identity for every registered cache that lacks one,
fills the `cache_id` of every row that still refers to its cache by the stored
name alone, and writes the tenant's missing `cache_lifecycle` rows to D1, at
most 36 per wake; a tenant with more caches records the step on a later wake.

`cupboard deploy` records a phase only once every active tenant has recorded the
step the build requires. It checks after both Workers serve the build and stops
with `LocalStepUnreachedError`, naming up to twenty of the tenants that are
behind, while any is. The first deploy of a build that raises the step therefore
always stops there, since no tenant can record the new step before the build
serves; run it again once `localStep.status` reports none pending.

## Rolling back

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
