# Deploying a release

`cupboard init` updates a control Worker, a tenant Worker and their shared D1
database. Each tenant also has a Durable Object with its own SQLite database; R2
stores the NAR and attestation bytes. See [releases] for how CLI binaries are
built and published.

[releases]: ./releases.md

## Resource names and cron triggers

Before it changes anything, `cupboard init` shows the deployment plan and a menu
for editing it. In that menu you can choose the names of the R2 bucket, the D1
database, the maintenance queue and its dead-letter queue that the Workers use,
and change the control Worker's cron triggers. The list of cron triggers cannot
be empty, because the control Worker runs maintenance only when a cron trigger
fires.

On an account that already has a control Worker, the deployment plan starts from
the existing deployment. The deploy reads the bucket, the database and the
maintenance queue from the control Worker's bindings, the dead-letter queue from
its queue consumer, and the cron triggers from its schedules. Accepting the plan
as shown, or deploying with `--yes`, keeps the existing resources and cron
triggers. On an account without a control Worker, the plan starts from the
release's defaults.

Earlier versions of `cupboard init` started every plan from the release's
defaults, so accepting the plan could point the Workers at new, empty resources
with the default names. To use the original resources again, enter their names
in the menu. If either the original database or the current one records an
admin, first bind the control Worker to the original database, as described in
[Changing the control database][control-database].

[control-database]: #changing-the-control-database

A release that changes a default resource name or cron trigger does not change
an existing deployment. There is one exception: when the control Worker has no
schedules, for example after a first deploy that failed before it set them, the
plan uses the release's cron triggers. To use a new default in any other case,
change the value in the menu.

`--dry-run` does not sign in to Cloudflare, so its plan shows the release's
defaults.

Choosing a different account in the menu restarts the deployment plan from that
account's existing deployment. The switch discards the resource, cron trigger
and domain edits made so far, and any request to replace the R2 credentials. The
plan then shows the domain given with `--domain`, or otherwise the custom domain
routed to that account's control Worker.

## Admin

A deployment has one global admin, recorded in the `global_admin` row of its D1
database. The first principal to present the claim secret at `/signup` becomes
the admin; this is the claim. The Cloudflare credential that `cupboard init`
uses for the account (an OAuth login, a wrangler token or an API token) does not
make anyone a Cupboard admin. The claim uses the identity in an id_token.

Before it changes anything, the deploy reads the admin from two databases: the
database that the deployed Workers are bound to, and the database selected in
the plan. Usually they are the same database. The next sections describe what
the deploy does for each state of the row, and with or without a terminal.

The admin check stops `cupboard init` from updating a deployment when the run
has no admin token. Anyone with the Cloudflare credentials can still change the
Workers, their secrets or D1 directly with other tools, so the check does not
protect a deployment from other holders of the account's credentials.

### First deploy

When neither database records an admin and the deploy runs in a terminal, it
logs you in to Cloudflare by default. `--oidc-issuer` and `--client-id` select
another issuer and OAuth client, with the same defaults as `cupboard login`.
With the default issuer and client, and without `--headless`, this login uses
Cupboard's cached Cloudflare login if there is one; it opens a browser only when
there is no cached login or the cached login cannot be renewed. With a different
issuer or client, the login is always a separate login to that issuer. With
`--headless`, it uses the device flow instead of a browser; the Cloudflare login
for the account can still open a browser.

The deploy then prints who the claim will make the admin (the display name,
issuer, subject and audience from your id_token) and asks you to confirm,
because the claim cannot be undone. `--yes` confirms without asking.

The id_token's issuer must be an HTTPS URL without a query or fragment, and the
token must have a `sub` claim. Its `aud` claim must contain exactly one
audience, because the control trust rule that the claim seeds pins one. The
deploy checks these before any change and stops if the id_token does not meet
them, because `/signup` would refuse the token after the upload. An issuer that
adds further audiences to its id_tokens cannot be used for the claim.

The deploy sets a generated claim secret, as the control Worker's
`CUPBOARD_SIGNUP_SECRET`, along with the other Worker secrets. Once the new
build serves, it:

1. presents the secret and your id_token at `/signup`, which records the token's
   issuer and subject as the admin and seeds a control trust rule that pins the
   issuer, subject and audience;
2. deletes the secret, whether or not the claim succeeded;
3. exchanges the same id_token at `/token` for an admin token and caches it, as
   `cupboard login` does.

The id_token presented at the claim must belong to the identity that you
confirmed. The deploy keeps the id_token from the login before the upload and
logs in again only if that token expires within a minute. If a second login
returns another identity, the deploy stops before the claim.

If the claim succeeds but the admin token cannot be cached, the deploy stops and
prints that the claim succeeded. Run the `cupboard login` command that the
deploy prints to cache the token, then run `cupboard init` again to finish.

The deploy retries `/signup` while it returns 404, 408, 429, 502, 503 or 504,
for up to 30 attempts four seconds apart (about two minutes), and while it
returns 403 from a Worker that has not yet received the claim secret. When the
claim fails, the advice depends on the last response:

- 409: another principal is already the admin. Log in as that admin, with the
  issuer and client that the admin claimed with, to update the deployment.
- 400: the deployment rejected your id_token or the request, and the message
  includes the server's reason.
- 429: Cloudflare limited the rate of requests. Wait a few minutes and run the
  deploy again.
- A 5xx status: the deploy prints the control Worker's log for the request when
  Cloudflare has it.
- 403, repeated: the claim secret did not take effect in time, and a re-run
  claims with a fresh secret.
- Any other status: check that the URL serves this release's control Worker.
- No response: the deploy reports that it could not reach the deployment.

`/signup` accepts the claim secret from anyone for as long as it is set. A first
deploy from a terminal therefore removes the secret after the claim attempt, and
also when the run stops after setting the secret but before the claim, including
when you interrupt it. Before its own upload, an update or a deploy without a
terminal removes any secret that an earlier run left, for example after an
interrupted run. If a removal fails, the deploy prints a warning, and the secret
stays set on the Worker until the next `cupboard init` removes it. The deploy
never prints the value or writes it to disk.

Whether the deploy claims or updates the deployment depends on the row, not on
whether Workers are already deployed. A deployment uploaded without a claim is
claimed by the next deploy from a terminal. So is a deployment whose earlier
deploy stopped before the claim; the next deploy sets a fresh secret. If a first
deploy from a terminal stops before the claim because the deployment kept
answering with an older build or an error status, or because the account has no
workers.dev subdomain, the deploy says that the deployment has no admin yet and
exits with a non-zero status. A network failure while it waits for the new build
ends the run with that error instead.

### First deploy without a terminal

When neither database records an admin and the deploy has no terminal, it
provisions and uploads but skips the claim and the first cache, because the
claim needs a login. It does not wait for the new build to serve. It exits with
an error that says the deployment has no admin, because nobody can create a
cache until someone claims it. A deploy from CI has no terminal and cannot log
in, so it cannot claim a deployment, and a CI job that deploys a new deployment
fails until someone runs `cupboard init` from a terminal.

### Update

When the database records an admin, the deploy needs an admin token and checks
it against the deployment's current URL before any migration or upload. The
current URL is the URL that the last deploy recorded on the control Worker, the
URL for which `cupboard init` and `cupboard login` obtain the admin's tokens. A
deployment from an earlier release has no record; its current URL is the custom
domain routed to the control Worker, or the workers.dev URL, and the first run
with this release records it.

The deploy uses the session cached by `cupboard login <deployment URL>`. When no
session is cached, it first tries the cached Cloudflare login, as
`cupboard login` does, and exchanges its id_token at the deployment; this
succeeds only if a control trust rule accepts that identity. When there is still
no usable session, or the session lacks the wildcard grant, and the run has a
terminal, the deploy logs you in as the admin and caches the session. The deploy
always starts a new login through the admin's issuer for this, not the cached
Cloudflare login, so you can complete it as the admin if your cached login
belongs to another user. `--headless` makes it use the device flow. If the login
returns another identity, the deploy stops before any change.

Without a usable token, the deploy stops, prints who the admin is, and prints
how to log in; nothing has changed by then.

The check sends an `instance.get` request to the deployment. If the deployment
cannot be reached, returns an error status, does not serve the control Worker at
its URL, or runs a build without `instance.get`, the deploy stops before any
change and prints the reason. For an error status, fix the control Worker or
roll it back, for example with `wrangler rollback`, and deploy again. For a
build without `instance.get`, first update the deployment with a release that
has it.

The deploy uses the same token to initialise the instance, rebuild tenant
membership, check the Worker's R2 credentials and migrate the tenants, which
brings each tenant's Durable Object to the local step that the release requires
(see [Local steps][local-steps]). It renews either kind of token when the token
nears expiry.

[local-steps]: #local-steps

### Updating from CI

In CI, pass `--github-oidc`. The deploy then exchanges the workflow's GitHub
Actions OIDC token for an admin token through a control trust rule, and the rule
must give the workflow the wildcard grant. Create the rule once, as the admin.
`--allow` cannot express the wildcard grant, so give the rule body in a file:

```sh
cat > ci-admin-rule.json <<'EOF'
{
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://cache.example.com",
  "claims": { "sub": "repo:acme/infra:ref:refs/heads/main" },
  "permittedGrants": [{ "type": "cupboard_wildcard" }]
}
EOF
cupboard control-oidc-trust add https://cache.example.com \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cache.example.com \
  --from-file ci-admin-rule.json
```

The audience is the deployment's current URL without a trailing slash, which is
the audience that the deploy requests by default. `--audience` requests another
audience, and `--audience` without `--github-oidc` is refused. The `sub` claim
pins the repository and the branch that may deploy. The job needs the
`id-token: write` permission and runs `cupboard init --github-oidc --yes`.

### Changing the control database

The deploy refuses a plan that selects a D1 database other than the database of
the deployed Workers when either database records an admin. Deploying such a
plan would either run as a first deploy while a database records an admin, or
leave the admin in a database that the Workers are no longer bound to. The
refusal happens before any change.

To keep the current database, select it in the plan menu. To move the deployment
to the other database, first bind the control Worker to it: in the Cloudflare
dashboard, open the control Worker under Workers & Pages, edit its `CUPBOARD_DB`
binding under Settings > Bindings, and deploy the new version. Then run
`cupboard init` again, as the admin that the other database records. When
neither database records an admin, the deploy runs as a first deploy with the
database selected in the plan.

### If the control Worker was deleted

When the control Worker no longer exists, the deploy reads the database binding
of the tenant Worker, and it reads the admin from that database and from the
database selected in the plan. If either records an admin, the deploy stops
before any change, because no Worker can check an admin token. `cupboard init`
cannot recreate the control Worker of a claimed deployment. Redeploy it with
Wrangler from the source of this release:

1. In `packages/server/wrangler.jsonc`, set `name` to the control Worker's
   script name, set the `CUPBOARD_DB` binding's `database_name` and
   `database_id` to the database that records the admin, and set the other
   bindings to the deployment's R2 bucket, KV namespace and queues.
2. Run `pnpm install`, then `wrangler deploy` in `packages/server`.
3. Set the original `CONTROL_KEY_WRAP_SECRET` with
   `wrangler secret put CONTROL_KEY_WRAP_SECRET`. The Worker's secrets were
   deleted with it, and only the original value can read the control database's
   signing keys. The first deploy printed the value if it generated it.
4. If the deployment served on a custom domain, route that domain to the Worker
   again.
5. Run `cupboard init` as the admin, with `--domain` set to the custom domain if
   the deployment served on one. The deploy checks the admin token against the
   redeployed Worker and replaces the Worker with this release.

### Moving to a new URL

An admin token for one URL is not accepted at another. When the plan moves the
deployment to a new URL, the deploy migrates the tenants and initialises the
instance at the new URL. Changing the custom domain is a move, and so is adding
a first custom domain to a deployment that serves on workers.dev.

If the new URL already serves the deployment, for example because you routed the
new domain to the control Worker in the Cloudflare dashboard, the deploy checks
the admin token there as it does at the current URL, and at a terminal it can
log you in there. Routing a domain in the dashboard does not change the current
URL, because the deploy takes the current URL from its record. For a deployment
from an earlier release, which has no record, run `cupboard init` once before
you route the new domain. Otherwise the deploy would take the routed domain as
the current URL.

If the new URL does not serve the deployment yet, the deploy cannot obtain or
check a token there before the upload. It then uses a session for the new URL
that is cached on this machine. The session's token must be issued by the new
URL and include the wildcard grant, as for the live check; an expired token
counts only if the session has a refresh token. Without such a session, the
deploy stops before any change. To move the deployment, route the new domain to
the control Worker in the Cloudflare dashboard and deploy again; at a terminal,
the deploy logs you in at the new URL if needed.

A run with `--github-oidc` can move a deployment only when the new URL already
serves it, because the run never uses a cached session. The deploy requests a
GitHub token whose audience is the current URL, or `--audience`, at both URLs,
because the workflow's control trust rule pins one audience. After the move, the
recorded URL is the new one, so later runs request the new URL as their
audience. Pass `--audience` with the old URL, or add a control trust rule for
the new URL, before the next run.

### The first cache

The first cache is created only on a deployment without tenants, and only by an
admin.

- At a terminal, the deploy asks for the cache's slug and read access. `--cache`
  and `--access` replace those prompts.
- Without a terminal, the deploy creates the first cache only from `--cache` and
  `--access`, which it then requires together, on a deployment that already has
  an admin. If the slug is taken, the deploy exits with an error.
- A first deploy without a terminal has no admin, so it does not apply the two
  options, and it warns about them before it changes anything.

When the deployment already has a cache, the deploy says that it did not apply
`--cache`.

### How principals are shown

The CLI shows your own identity as your token's `name`, `email`,
`preferred_username` or `sub` claim, whichever it finds first in that order. It
reads your display name from your token each time, and the deployment does not
record it. Other principals appear as the full issuer URL followed by the
subject; an update shows the admin in this form. `cupboard oidc-trust list`
shows each rule's full issuer URL, followed by the subject when the rule is
pinned to one.

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

`cupboard init` reads the account's subscriptions and writes the selected
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
cupboard init --workers-plan paid
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
   reached local step 4, waking pending tenants in batches of 20 with the admin
   token.
5. Record `native-reads`, apply the D1 contraction migrations and record
   `contracted`. Wake tenants again until they finish local step 5.

A failed step-4 readiness check leaves the D1 contraction unapplied. The error
identifies the Workers or a sample of tenants that are behind. If local step 5
fails, the D1 contraction and `contracted` phase have already been recorded.
Each tenant wake stage runs at most 100 batches. Inspect incomplete work with
`cupboard deployment status <url>` and retry batches with
`cupboard deployment resume <url>`. Repair any reported tenant configuration or
migration error, then rerun `cupboard init`. Applied migrations are skipped
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
`cupboard init` to complete any remaining global transition. The hourly sweep
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
`cupboard init`, and its `deployment.phase` control procedure returns an error.
Deploy a build that recognises the phase to recover these operations.

The `check` API now uses a numeric cache identity in `cursorCache`. An older CLI
cannot validate this response or resume an old scan against it. Use the CLI from
this release and start the scan again.
