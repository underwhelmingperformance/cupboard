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

This build defines one phase, `current`, for a build that needs no such
coordination. A release that adds a phase adds it to that list and documents
here how the build behaves while that phase is recorded.

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
does not lower what a newer build recorded. This build defines one step, 0,
which an object reaches once its migrations have applied.

A release whose next phase depends on per-object work numbers that work as the
next step, so the deploy can wait until every active tenant has reached it
before it records the phase.

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
