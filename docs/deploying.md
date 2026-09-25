# Deploying a release

`cupboard deploy` updates a control Worker, a tenant Worker and their shared D1
database. Each tenant also has a Durable Object with its own SQLite database; R2
stores the NAR and attestation bytes. See [releases] for how CLI binaries are
built and published.

[releases]: ./releases.md

## Resource names and cron triggers

Before it changes anything, `cupboard deploy` shows the deployment plan and a
menu for editing it. In that menu you can choose the names of the R2 bucket, the
D1 database, the maintenance queue and its dead-letter queue that the Workers
use, and change the control Worker's cron triggers. The list of cron triggers
cannot be empty, because the control Worker runs maintenance only when a cron
trigger fires.

On an account that already has a control Worker, the deployment plan starts from
the existing deployment. The deploy reads the bucket, the database and the
maintenance queue from the control Worker's bindings, the dead-letter queue from
its queue consumer, and the cron triggers from its schedules. Accepting the plan
as shown, or deploying with `--yes`, keeps the existing resources and cron
triggers. On an account without a control Worker, the plan starts from the
release's defaults.

Earlier versions of `cupboard deploy` started every plan from the release's
defaults, so accepting the plan could point the Workers at new, empty resources
with the default names. To use the original resources again, enter their names
in the menu.

A release that changes a default resource name or cron trigger does not change
an existing deployment. There is one exception: when the control Worker has no
schedules, for example after a first deploy that failed before it set them, the
plan uses the release's cron triggers. To use a new default in any other case,
change the value in the menu.

`--dry-run` does not sign in to Cloudflare, so its plan shows the release's
defaults.

Choosing a different account in the menu restarts the deployment plan from that
account's existing deployment. The switch discards the resource, cron trigger
and domain edits made so far, and any request to replace the R2 credentials. It
keeps the Admin setting. The plan then shows the domain given with `--domain`,
or otherwise the custom domain routed to that account's control Worker.

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

## Phases

The `deployment_phase` row in D1 records the deployment's phase and the local
step its tenants must reach. The recognised phases are `current`, `expanded`,
`native-reads` and `contracted`, in that order. A build that needs no
coordinated transition uses `current`.

This release finishes a deploy in `contracted`. One run performs these steps:

1. Read the recorded phase before applying a migration or uploading a Worker.
   Refuse a phase this build does not recognise.
2. Apply the D1 preparation migrations.
3. Upload both Workers and configure their triggers and secrets.
4. Check that each Worker's deployment assigns all traffic to one version and
   that both Workers report this build. Check that every active tenant has
   reached local step 4, waking pending tenants in batches of 20.
5. Record `native-reads`, apply the D1 contraction migrations and record
   `contracted`. Wake tenants again until they finish local step 5.

A failed step-4 readiness check leaves the D1 contraction unapplied. The error
identifies the Workers or a sample of tenants that are behind. If local step 5
fails, the D1 contraction and `contracted` phase have already been recorded.
Each tenant wake stage runs at most 100 batches. Inspect incomplete work with
`cupboard deployment status <url>` and retry batches with
`cupboard deployment resume <url>`. Repair any reported tenant configuration or
migration error, then rerun `cupboard deploy`. Applied migrations are skipped
after checking their recorded digests. Repeating a phase preserves its
timestamp, and a rerun cannot lower `contracted` to `native-reads`.

`contractionMigrations` classifies the D1 files that run after readiness has
been checked. Every contraction must follow every preparation migration in
journal order. The deploy refuses an unlisted file that sorts after the first
contraction, so a new migration must be assigned deliberately.

There is no elapsed-time delay and no second deploy required solely to apply a
contraction. The [Workers deployments API] reports the configured traffic
allocation, not whether every old invocation has finished. A [Durable Object
code deployment] restarts its objects; an old in-flight request is stopped when
it next touches object storage, and WebSockets are closed. Old Worker HTTP
requests can continue. The final D1 schema rejects their references to removed
columns, and the grant migration installs triggers that reject writes in the old
grant format. Those requests can fail during the transition and must retry
against the new build.

[Workers deployments API]:
  https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/
[Durable Object code deployment]:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

The phase is not a general rollback guarantee. Tenant SQLite contracts during
initialisation under this build, before the global phase advances. The D1
preparation retains both cache representations and mirrors inserts from either
writer. Final D1 contraction removes that compatibility. The reviewed deployment
plan identifies the tenant Worker upload as the local rollback boundary: after
an object contracts its SQLite schema, complete this deployment to recover.

## Local steps

`tenant.local_step` is a watermark for each object's completed data work. The
object never lowers it. The `localStep.wake` control procedure wakes a bounded
batch of active tenants that are behind; the hourly sweep also wakes up to
twenty per tick. `localStep.status` counts ready and pending tenants and lists
up to twenty pending tenants. Large tenants can need several wakes.

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
- Step 5 rewrites stored trust rules and refresh-token grants after D1 records
  `contracted`. A wake rewrites at most 100 rules and 100 families. Completion
  enables local database triggers that reject the old format.

Before contraction, an object reports at most step 4. After contraction, the
control plane still finds those tenants below step 5 and wakes them again. A
successful CLI deploy completes both stages. If a run is interrupted,
`cupboard deployment resume <url>` continues the pending stage; rerun
`cupboard deploy` to complete any remaining global transition. The hourly sweep
also continues tenant work. A persisted cursor rotates through pending tenants,
so a failed tenant does not prevent later tenants from being attempted.

A path whose object has not reached its generation key returns 404. The move or
a new push makes it available at that key.

## Stored cache grants

This build reads both selector grants and scope grants. A selector grant uses
`_default` for the default cache, the cache name for a public cache, and
`_private-<name>` for a private cache. A scope grant identifies the default
cache or a named cache independently of its access. A trust-rule binding can
contain a template; a refresh-token family contains the concrete scopes already
granted.

Below `contracted`, new grants use the selector format so the grant readers in
the preceding build can parse them. A known named cache uses the selector for
its access. Templates and names whose access is not yet known use both public
and private selectors; current readers combine these into one grant. Access
changes are refused until contraction, so an existing selector retains its
meaning throughout the compatibility period.

The control plane cannot resolve a tenant cache's access, so it stores named
cache grants in both selector forms. If a template is too long to include the
private selector prefix in the preceding format, adding the rule returns
`CACHE_GRANT_MIGRATION_PENDING` (409). Complete the deployment before adding
that rule.

The D1 contraction rewrites `control_trust`. Local step 5 rewrites each tenant's
`oidc_trust` and `refresh_token_family`. A phase reading can be cached for one
minute, so the local step refreshes it before starting the rewrite. Prepared
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
phase or tenant progress. In particular, this release drops the legacy cache and
reuse-view tables and removes columns that the preceding build reads and writes.
A tenant that has initialised under this build has already crossed that local
schema boundary, even if D1 has not yet recorded `contracted`.

After contraction, an older build cannot serve the resulting schema. Deploy this
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
digests, yet still be unable to use the schema those migrations produced. An
older build that does not recognise the recorded phase also refuses
`cupboard deploy`, and its `deployment.phase` control procedure returns an
error. Deploy a build that recognises the phase to recover these operations.

The `check` API now uses a numeric cache identity in `cursorCache`. An older CLI
cannot validate this response or resume an old scan against it. Use the CLI from
this release and start the scan again.
