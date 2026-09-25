# Deploying a release

`cupboard deploy` updates a control Worker, a tenant Worker and their shared D1
database. Each tenant also has a Durable Object with its own SQLite database; R2
stores the NAR and attestation bytes. See [releases] for how CLI binaries are
built and published.

[releases]: ./releases.md

## Workers plan and subrequest allowance

Cupboard limits each invocation to its configured number of internal-service
subrequests. The [Workers limits] list 1,000 calls on Free and a default of
10,000 on Paid. D1 and R2 binding calls share that runtime allowance, and one
`D1Database.batch()` counts as one call regardless of its statement count.
Cupboard reserves 100 calls for work outside its tracked D1 and R2 bindings.

The [D1 limits] page still lists 50 queries per invocation on Free and 1,000 on
Paid. Those figures conflict with the newer Workers subrequest limits and with a
Paid runtime check in which 10,000 D1 calls completed and the 10,001st failed.
The Free internal-service allowance has not been checked against a hosted
Worker. Cupboard uses the Workers limits for both plans.

`cupboard deploy` reads the account's subscriptions and writes the selected
allowance into both Workers. Plan detection is best effort. If the token cannot
read subscriptions, the request fails, or the response contains an unrecognised
Workers plan, deployment reports the reason and uses the Free allowance. An
unknown rate-plan ID is included in the message. The automatic Paid match is
`WORKERS_PAID`, as listed in Cloudflare's [subscription reference]. Other
Workers identifiers use the Free allowance until their limit is verified.

Use `--workers-plan free` or `--workers-plan paid` to skip detection and select
the allowance explicitly. The flag must match the account's subscription; it
does not change that subscription. For example, an operator who has confirmed a
Paid subscription can deploy with a token that cannot read billing information:

```sh
cupboard deploy --workers-plan paid
```

The allowance is stored in `CUPBOARD_SUBREQUESTS_PER_INVOCATION`. An unset or
invalid value uses 1,000 calls. The parser accepts the Paid figure only when it
is exactly 10,000; all other values use the Free figure. Both checked-in
Wrangler configurations leave `limits.subrequests` unset, so Cloudflare applies
the account's plan limit. The configured allowance does not extend the tenant
object's critical-section deadline.

[Workers limits]: https://developers.cloudflare.com/workers/platform/limits/
[D1 limits]: https://developers.cloudflare.com/d1/platform/limits/
[subscription reference]:
  https://developers.cloudflare.com/tenant/reference/subscriptions/

## Schema transitions

A change to the shared D1 schema is a _schema transition_: a group of migrations
with an expand part, which the build that introduces them can run against
alongside the preceding build, and a contract part, which removes what the
preceding build still reads once nothing serves it. The transitions are listed
in order in `schemaTransitions` in `@cupboard/protocol/deployment`, and every
migration file belongs to exactly one of them. Concatenating each transition's
expand then contract, in list order, must give the migration files in name
order; `pnpm check:migrations` and the deploy both refuse a tree where the
files, the drizzle journal and the list disagree.

This release defines two transitions:

- `cache-identity`: migrations `0000` to `0027` expand, `0028` to `0030`
  contract, and every active tenant must reach local step 4 before the contract.
- `deployment-transitions`: migration `0031` adds the state table below. It has
  no contract and no settle step, and it is _independent_: its expand does not
  depend on the contracts of the transitions before it, so the deploy may apply
  it ahead of them. The migration check replays it in that order to verify the
  claim.

The `deployment_transition` table records one row per transition the deploy has
started: `expanded` once its expand migrations are applied, `complete` once its
contract migrations are too (or at once, for a transition with none). A
transition with no row is pending. The deploy owns the table, as it owns
`d1_migrations`: it creates it with `CREATE TABLE IF NOT EXISTS` before it walks
the transitions, because it has to record the first transition on a database
from before migration `0031`. Reading the states reconciles them from the
`deployment_phase` row the preceding release wrote: `contracted` implies
`cache-identity` is complete, and any other phase implies it is at least
expanded. Records are monotonic: a rerun cannot lower `complete` to `expanded`,
and repeating a state keeps its timestamp.

One `cupboard deploy` run walks the transitions in list order:

1. Read the recorded states, before applying a migration or uploading a Worker.
   Refuse a transition id or state this build does not define, and refuse the
   tree if its migrations do not match the transitions. A build that cannot
   serve the schema from before a transition's contract refuses to deploy until
   that transition is complete, naming the release that completes it; this build
   serves every state.
2. Before the upload, on a database this run created: apply every transition's
   expand and contract and record each complete. There are no old Workers to
   drain and no tenants to settle.
3. Before the upload, otherwise: for each pending transition, apply its expand
   migrations and record `expanded` when every earlier transition is complete or
   the transition is independent; a transition with no contract and no settle
   step is complete at once. A transition that qualifies for neither waits for
   step 5, and later independent ones are still applied.
4. Upload both Workers and configure their triggers and secrets.
5. After the upload, for each transition still pending: check once that each
   Worker's deployment assigns all traffic to one version and that both Workers
   report this build; apply its expand migrations if they were deferred; check
   that every active tenant has reached its settle step, waking pending tenants
   in batches of 20; write the `deployment_phase` compatibility row for
   `cache-identity`; apply its contract migrations and record `complete`.
6. Wake tenants again until they reach local step 5.

A failed serving check or settle check in step 5 leaves that transition's
contract unapplied and the states as they were. The error names the Workers or a
sample of the tenants that are behind. If step 6 fails, the contracts have
already been applied and recorded. Each tenant wake stage runs at most 100
batches. Inspect incomplete work with `cupboard deployment status <url>`, which
lists each recorded transition and the local step the tenants must reach now,
and retry batches with `cupboard deployment resume <url>`. Repair any reported
tenant configuration or migration error, then rerun `cupboard deploy`. Applied
migrations are skipped after checking their recorded digests.

The `deployment_phase` row stays for one release. The deploy still writes
`native-reads` once the `cache-identity` tenants have settled and `contracted`
once its contract has run, so a rollback to the preceding release reads a
correct phase. Nothing in this build reads it; dropping it is a later
transition's contract.

There is no elapsed-time delay and no second deploy required solely to apply a
contract. The [Workers deployments API] reports the configured traffic
allocation, not whether every old invocation has finished. A [Durable Object
code deployment] restarts its objects; an old in-flight request is stopped when
it next touches object storage, and WebSockets are closed. Old Worker HTTP
requests can continue. The contracted D1 schema rejects their references to
removed columns, and the grant migration installs triggers that reject writes in
the old grant format. Those requests can fail during the transition and must
retry against the new build.

[Workers deployments API]:
  https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/
[Durable Object code deployment]:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

A transition's state is not a general rollback guarantee. Tenant SQLite
contracts during initialisation under this build, before the shared transition
completes. The `cache-identity` expansion retains both cache representations and
mirrors inserts from either writer; its contract removes that compatibility. The
reviewed deployment plan identifies the tenant Worker upload as the local
rollback boundary: after an object contracts its SQLite schema, complete this
deployment to recover.

## Local steps

`tenant.local_step` is a watermark for each object's completed data work. The
object never lowers it. The `localStep.wake` control procedure wakes a bounded
batch of active tenants that are behind; the hourly sweep also wakes up to
twenty per tick. `localStep.status` counts ready and pending tenants and lists
up to twenty pending tenants. Large tenants can need several wakes.

The step a tenant must reach now is the _required_ step: the settle step of the
first incomplete transition that has one, else this build's final step.
`deployment.transitions` reports it, `localStep.status` reports it as `required`
next to the build's `current`, and the wake and the sweep select tenants below
it. Before the `cache-identity` contraction an object can report at most step 4,
so counting tenants against step 5 then would never reach zero.

This build defines five steps:

- Step 1 projects missing lifecycle rows into D1, at most 36 caches per wake.
  The local schema migrations now reconcile registrations and fill identity
  columns before contraction.
- Step 2 moves private-cache objects off their old `private/` keys.
- Step 3 moves objects from later cache generations onto keys that include the
  generation. Steps 2 and 3 each move at most 100 objects per wake.
- Step 4 imports legacy retention and grace policies in bounded batches. Cache
  retention edits are refused while that import is pending. The policy list and
  removal procedures remain available to recover from an import that exceeds its
  supported rule bound.
- Step 5 rewrites stored trust rules and refresh-token grants once D1 records
  the `cache-identity` transition complete. A wake rewrites at most 100 rules
  and 100 families. Completion enables local database triggers that reject the
  old format.

Before contraction, an object reports at most step 4. After contraction, the
required step becomes 5, the control plane finds those tenants below it and
wakes them again. A successful CLI deploy completes both stages. If a run is
interrupted, `cupboard deployment resume <url>` continues the pending stage at
the step the transitions require; rerun `cupboard deploy` to complete any
remaining transition. The hourly sweep also continues tenant work. A persisted
cursor rotates through pending tenants, so a failed tenant does not prevent
later tenants from being attempted.

A path whose object has not reached its generation key returns 404. The move or
a new push makes it available at that key.

## Stored cache grants

This build reads both selector grants and scope grants. A selector grant uses
`_default` for the default cache, the cache name for a public cache, and
`_private-<name>` for a private cache. A scope grant identifies the default
cache or a named cache independently of its access. A trust-rule binding can
contain a template; a refresh-token family contains the concrete scopes already
granted.

Until the `cache-identity` transition is complete, new grants use the selector
format so the grant readers in the preceding build can parse them. A known named
cache uses the selector for its access. Templates and names whose access is not
yet known use both public and private selectors; current readers combine these
into one grant. Access changes are refused until contraction, so an existing
selector retains its meaning throughout the compatibility period.

The control plane cannot resolve a tenant cache's access, so it stores named
cache grants in both selector forms. If a template is too long to include the
private selector prefix in the preceding format, adding the rule returns
`CACHE_GRANT_MIGRATION_PENDING` (409). Complete the deployment before adding
that rule.

The D1 contraction rewrites `control_trust`. Local step 5 rewrites each tenant's
`oidc_trust` and `refresh_token_family`. A transition reading can be cached for
one minute, so the local step refreshes it before starting the rewrite. Prepared
grants are checked again immediately before their synchronous database write; a
value prepared before local contraction is converted if contraction finished
while its caller awaited another operation. Database triggers enforce the
resulting format. Tolerant readers remain throughout the transition.

## Cache read credentials

Deleting a cache advances its lifecycle generation and removes its read
credential in one D1 batch. The credential deletion runs only when the lifecycle
transition changes a row. A private cache with no credential of its own accepts
the tenant credential, so the batch prevents a live cache from briefly gaining
that broader access. If the batch commits but its response is lost, a retry
completes local teardown without deleting a credential that was provisioned
afterwards. A credential provisioned before a private cache is registered also
remains available for that new cache.

The contraction migration `0030_cache_credential_lifecycle` removes credentials
whose cache lifecycle row is still marked deleted. It keeps credentials set
before a cache was registered. It also keeps credentials on live caches whose
names have been reused: registration clears the deletion timestamp, and the
stored data cannot establish whether a credential belongs to the current cache
or an earlier cache with that name.

After migration, this query lists credentials on recreated named caches for an
operator to review:

```sql
SELECT c.tenant, c.cache_name, c.access, c.generation, r.created_at
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

A generation above one means the cache name has been deleted at least once. The
credential's `created_at` records when it was set, but does not prove which
incarnation it belongs to. Confirm with the tenant whether its readers should
still use that password.

For a private cache that should keep its own credential, replace the password
with `cupboard tenant rotate-cache-credential <url> <tenant> <cache>` and update
its readers with the returned credential. Rotation replaces the existing
verifier without first switching the cache to the tenant credential.

Use `cupboard tenant clear-cache-credential <url> <tenant> <cache>` only when
readers should use the tenant credential instead, or when removing an unused
credential from a public cache. Clearing a credential does not lock a private
cache: everyone with the tenant credential can then read it. Both commands check
the tenant's lifecycle; use them rather than deleting rows directly in D1.

## Rolling back

Rolling back the Workers does not roll back D1, tenant SQLite, R2, the recorded
transitions or tenant progress. In particular, the `cache-identity` contract
drops the legacy cache and reuse-view tables and removes columns that the
preceding build reads and writes. A tenant that has initialised under this build
has already crossed that local schema boundary, even if D1 has not yet recorded
the transition complete.

After a contract, an older build cannot serve the resulting schema. Deploy this
release again to resume an interrupted transition. Restoring an earlier release
requires compatible storage from before the transition as well as the older
Workers. D1 has [Time Travel]; this repository provides no automated restore
procedure for every tenant's Durable Object storage. A Worker rollback alone is
not that recovery procedure.

[Time Travel]: https://developers.cloudflare.com/d1/reference/time-travel/

Generation-key object moves are not reversed either. An older build can neither
read those keys nor retire them during teardown. If it writes at an old key,
redeploying a build whose local step the tenant already recorded does not
necessarily revisit that object. Recover such objects explicitly before relying
on the new keys.

Migration-history admission checks are separate from schema compatibility. A
build can admit a longer history when the extra migrations have verified
digests, yet still be unable to use the schema those migrations produced. A
build that does not recognise a recorded transition id or state also refuses
`cupboard deploy`, and its `deployment.transitions` control procedure returns an
error, while its tenant objects and the control-plane trust gate treat the row
as nothing recorded. Deploy a build that recognises the transition to recover
these operations. Rolling back to the release before this one leaves the
`deployment_transition` table in place, which that release does not read; it
reads the `deployment_phase` row this build keeps writing.

The `check` API now uses a numeric cache identity in `cursorCache`. An older CLI
cannot validate this response or resume an old scan against it. Use the CLI from
this release and start the scan again.
