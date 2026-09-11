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

This build defines four phases, in the order a release records them: `current`
for a build that needs no such coordination, then `expanded`, `native-reads` and
`contracted`. A release that adds a phase adds it to that list and documents
here how the build behaves while that phase is recorded.

`contracted` says that the deployed build names a cache by its identity and by
nothing else: it neither reads nor writes the columns that stored a cache's name
as one string, every cache records how it reads, and a reuse view is stored
under its own name.

## Migrations that wait for the preceding release

`cupboard deploy` applies the D1 migrations before it uploads the Workers,
because the preceding release keeps serving until the upload finishes and has to
work against the schema they leave.

A migration cannot run then if it removes something that release still writes,
or if it removes rows that release goes on producing. Those migrations are named
in `migrationsAppliedAfterCutover`. They may run only once both Workers serve
this build and the longest invocation that could have started on the preceding
one must have ended: a Queue consumer has a fifteen-minute wall-time allowance,
which is that longest invocation, so the window is sixteen minutes from the
moment the deploy recorded the phase.

Migrations apply in journal order, so the deferred migrations must be the last
in the journal. A migration added after one that waits has to wait as well.
Otherwise the deploy would apply it first, against a schema the deferred
migrations have not yet changed.

A deploy does not wait out that window. It reports the migrations as deferred
and finishes, and the next deploy applies them, by which time the window is long
past. The phase row records when the deployment entered its phase rather than
when the deploy last ran, so a rerun does not push the deadline away.

Deferring is safe because the state between the two sets of migrations is a
resting state. The columns that `0029_cache_identity_contract` drops are
nullable by then, and the deployed build neither reads nor writes them. The read
credentials that `0030_cache_credential_lifecycle` removes belong to caches that
earlier releases deleted, and the preceding release left those rows in place
too. A deployment that never runs another deploy therefore keeps working: the
dead columns are ignored, and a stale credential opens a re-created cache
exactly as it did under the preceding release.

This release contracts the schema. It defers `0029_cache_identity_contract` and
`0030_cache_credential_lifecycle`.

### Read credentials to check by hand

`0030_cache_credential_lifecycle` removes the read credential of every cache
that is deleted at the time it runs. It keeps the credential of a cache that was
deleted and then registered again under the same name: registration clears the
deletion timestamp, and no column records whether the operator set the
credential for the cache that holds the name now or for an earlier cache of that
name. An operator has to decide that for each such credential. Once
`0030_cache_credential_lifecycle` has run, list them with:

```sql
SELECT c.tenant, c.cache_name, c.generation, r.created_at
FROM cache_lifecycle AS c
JOIN tenant_cache_read_credential AS r
	ON r.tenant = c.tenant
	AND r.cache_kind = c.cache_kind
	AND r.cache_name IS c.cache_name
WHERE c.cache_kind = 'named'
	AND c.deleted_at IS NULL
	AND c.generation > 1
ORDER BY c.tenant, c.cache_name;
```

A generation above one means the name has been deleted at least once, so each
row is a credential that may belong to an earlier cache. Decide for each row
which cache the credential belongs to. The credential's `created_at` records
when it was set, and the tenant can confirm whether that password is the one
their readers use. A credential the tenant still uses needs no action.

Clear a credential that belongs to an earlier cache with the control plane's
`DELETE /tenants/{id}/caches/{cacheName}/read-credential`. Do not delete the row
in D1 by hand. The procedure requires a live tenant in the DELETE statement
itself, so it refuses a tenant that is offboarding or offboarded; a hand-written
statement has no such check.

Clearing a credential does not lock the cache. Readers of a private cache with
no credential of its own authenticate with the tenant credential, so a cleared
cache stays readable to everyone who holds the tenant credential until a new
credential is set for it. Set one with
`POST /tenants/{id}/caches/{cacheName}/read-credential` for a cache that should
keep a credential of its own.

## Local steps

Each tenant's Durable Object records how far it has advanced its own store in
`tenant.local_step`. It applies its pending migrations when it next runs, and
records the step it has reached. A tenant with no traffic of its own would
otherwise never run, so the control plane lists the tenants that are behind and
wakes a bounded batch of them, and the hourly cron sweep does the same.

The stored step is a watermark: rolling back to a build that defines fewer steps
does not lower what a newer build recorded. This build defines steps up to 4.
Step 0 is reached once an object's migrations have applied; the later steps are
the per-object work that no migration could do, described in `currentLocalStep`.

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

### Recovering from the `contracted` release

This release drops the columns that stored a cache's name as one string, from D1
and from every tenant's Durable Object. Nothing reconstructs them, so the
preceding build cannot serve the contracted schema and rolling the Workers back
does not restore it. Recovery is a restore of the D1 database and of the Durable
Object storage from a point before the release, not a Worker rollback.

Each object converts its own cache catalogue before the contraction reaches it,
reading from D1 the access recorded for its caches. A tenant that nothing has
woken since an earlier release therefore needs no preparation: its object
converts and contracts the first time it runs.
