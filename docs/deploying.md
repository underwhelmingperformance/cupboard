# Deploying a release

This document describes how `cupboard deploy` moves a live deployment from one
build to the next. See [docs/releases.md](./releases.md) for how the CLI
binaries themselves are built and published.

## Phases

A release that changes what a tenant's Durable Object stores cannot switch every
object over at once. Objects wake at different times, and an object that has not
woken since the previous release still stores the old shape. `cupboard deploy`
therefore records which phase the deployed build runs in, and the Workers read
that phase and behave as it requires.

One row of the `deployment_phase` table in D1 records the phase.
`cupboard deploy` reads that row when it starts, and writes it once both Workers
serve the build it has just uploaded. It reads the traffic split of the current
deployment from the [Workers deployments API] to establish that. A gradual
deployment can still be splitting a script's traffic between two versions, and
there is then no single build to record a phase for. The deploy stops and names
the script to wait for; running it again once the rollout has finished records
the phase. Every step the deploy takes is idempotent, so an interrupted run is
repeated rather than repaired.

[Workers deployments API]:
  https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/

This build defines one phase, `current`, for a build that needs no such
coordination. A release that adds a phase adds it to that list and documents
here how the build behaves while that phase is recorded.

## Local steps

Each tenant's Durable Object records how far it has advanced its own store in
`tenant.local_step`. It applies its pending migrations when it next runs, and
records the step it has reached. A tenant with no traffic of its own would
otherwise never run, so the control plane lists the tenants that are behind and
wakes a bounded batch of them, and the hourly cron sweep does the same.

The stored step is a watermark: rolling back to a build that defines fewer steps
does not lower what a newer build recorded. This build defines one step, 0,
which an object reaches once its migrations have applied.

A release whose next phase depends on per-object work numbers that work as the
next step, so the deploy can wait until every active tenant has reached it.

## Rolling back

Rolling back is a Worker rollback. The recorded phase stays as it was, so a
rollback past a release that added a phase leaves a phase name the earlier build
does not define. That build serves reads and writes as usual, but its
`deployment/phase` control procedure reports an error and `cupboard deploy`
stops rather than advancing from a phase it cannot describe. Deploying a build
that defines the phase clears both.

A migration that drops a column or a table cannot be undone by redeploying, so a
release that contracts the schema documents its own recovery here alongside the
phase that performs it.
