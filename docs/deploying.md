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
for up to 30 attempts four seconds apart (about two minutes). It also retries a
403 for about 30 seconds after the new build serves, because the Worker version
without the claim secret can keep answering until the version with it serves.
When the claim fails, the advice depends on the last response:

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
current URL is the URL that the last deploy recorded on the control Worker as
`CUPBOARD_DEPLOYMENT_URL`, the URL for which `cupboard init` obtains the admin's
tokens; pass the same URL to `cupboard login`. A deployment from an earlier
release has no record; its current URL is the custom domain routed to the
control Worker, or the workers.dev URL, and the first run with this release
records it. The upload records a new URL before the deploy routes a new custom
domain. If a move fails between the two, the record names a URL that is not
routed to the control Worker. The next run then warns and uses the routed URL.
The record must be an HTTPS URL; the deploy refuses any other value.

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
change and prints the reason. For an error status from the Worker, fix the
control Worker or roll it back, for example with `wrangler rollback`, and deploy
again. When the token exchange reports why it failed, for example because the
admin's issuer cannot be reached, the deploy prints that reason instead. For a
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
must give the workflow the wildcard grant. Create the rule once, from a session
whose token may add control trust rules, such as the admin's session from
`cupboard login <deployment URL>` at a terminal, which has the wildcard grant.
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
pins the repository and the branch that may deploy. The job needs a Cloudflare
API token for the account in `CLOUDFLARE_API_TOKEN` and the `id-token: write`
permission, and runs `cupboard init --github-oidc --yes`. Pass `--account` when
the token can reach more than one account.

### Restoring the admin's wildcard grant

The claim seeds a control trust rule with the id `signup`, which gives the admin
the wildcard grant. If that rule is removed or disabled, or another rule for the
admin's issuer and subject takes precedence, the admin's token lacks the
wildcard grant. An update then stops even after a login as the admin.

Adding or removing a control trust rule needs a token whose grants allow it: the
wildcard grant, or a `cupboard_control` grant that lists
`control-oidc-trust:add` and `control-oidc-trust:remove`. A principal with such
a token, for example a second person whose rule gives the wildcard grant, logs
in with `cupboard login <deployment URL>`, adds a rule for the admin with
`cupboard control-oidc-trust add --from-file`, and removes any other rule for
the admin's issuer and subject with `cupboard control-oidc-trust remove`. The
rule body pins the admin's issuer, audience and `sub`, and has
`"permittedGrants": [{ "type": "cupboard_wildcard" }]`.

If no principal has such a grant, nobody can change the control trust rules
through the deployment. Restore the `signup` rule directly in the control
database with Wrangler, logged in to the account, and replace the database name,
issuer, audience and subject with the admin's:

```sh
npx wrangler d1 execute cupboard --remote --command "
  INSERT INTO control_trust
    (id, issuer, audience, claims_json, permitted_grants_json, created_at)
  VALUES ('signup', 'https://dash.cloudflare.com', 'cupboard-client',
    json_object('sub', 'cf-user-1'), '[{\"type\":\"cupboard_wildcard\"}]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (id) DO UPDATE SET issuer = excluded.issuer,
    audience = excluded.audience, claims_json = excluded.claims_json,
    permitted_grants_json = excluded.permitted_grants_json, disabled_at = NULL"
```

The deploy's refusal prints the admin's issuer and subject. The audience is the
client id that the admin claimed with; with the default login, it is Cupboard's
Cloudflare client id. If another rule for the admin's issuer and subject still
takes precedence, delete it in the same way with
`DELETE FROM control_trust WHERE id = '<rule id>'`. Then run `cupboard init`
again.

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
database selected in the plan. When the tenant Worker was deleted too, it reads
only the database selected in the plan. If a database records an admin, the
deploy stops before any change and prints the name of that database, because no
Worker can check an admin token. `cupboard init` cannot recreate the control
Worker of a claimed deployment. Redeploy it with Wrangler from a checkout of
this release:

1. Run `pnpm install` at the root of the checkout, then `pnpm build-info` in
   `packages/server`. The Worker imports the build information that
   `pnpm build-info` generates, and a fresh checkout does not have it.
2. In `packages/server/wrangler.jsonc`, set these values to the deployment's own
   (the tenant Worker's settings in the Cloudflare dashboard list most of them):
   - `name`: the control Worker's script name;
   - the `CUPBOARD_DB` binding's `database_name` and `database_id`: the database
     that the error names;
   - the `BLOBS` R2 bucket;
   - the `TENANT_CACHE` and `CRON_STATE` KV namespace ids;
   - the `MAINTENANCE_QUEUE` producer, the queue consumer and its dead-letter
     queue;
   - the `CUPBOARD_TENANT` service and the `CUPBOARD_DO` `script_name`: the
     tenant Worker's script name;
   - under `vars`, `CUPBOARD_DEPLOYMENT_URL`: the deployment's URL, such as
     `https://cache.example.com`.
3. If the tenant Worker was deleted too, deploy it first: set `name` and the
   `CUPBOARD_DB`, `BLOBS` and `MAINTENANCE_QUEUE` bindings in
   `packages/server/wrangler.tenant.jsonc` in the same way, then run
   `pnpm exec wrangler deploy -c wrangler.tenant.jsonc` in `packages/server`.
4. Run `pnpm exec wrangler deploy` in `packages/server`.
5. Set the original `CONTROL_KEY_WRAP_SECRET` with
   `pnpm exec wrangler secret put CONTROL_KEY_WRAP_SECRET` in `packages/server`.
   The Worker's secrets were deleted with it, and only the original value can
   read the control database's signing keys. The first deploy printed the value
   if it generated it.
6. If the deployment served on a custom domain, route that domain to the Worker
   again.
7. Run `cupboard init` as the admin, with `--domain` set to the custom domain if
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
  `--access`, on a deployment that already has an admin. It refuses either
  option without the other. If the slug is taken, the deploy exits with an
  error.
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

## Schema transitions

A _schema transition_ is a group of D1 migrations in two parts. The expand
migrations add schema. Every build that can still be deployed or rolled back to
must be able to run against the expanded schema, not only the preceding build:
after a skip-level upgrade, such as one from v0.0.33, the deployed build is
older than the preceding release, and a rollback can cross two releases. The
contract migrations remove what the preceding build reads, and run once both
Workers' deployments send all traffic to the new build.

A transition's _contract step_ is the local step that every active or suspended
tenant must record before the deploy applies the transition's contract
migrations. The _required local step_ is the local step that every active or
suspended tenant must reach now: the contract step of the first incomplete
transition that has one, else this build's final step. Once `cache-identity` is
complete, the required local step is never below 5.

This release defines two transitions:

- `cache-identity`: migrations `0000` to `0027` are its expand migrations and
  `0028` to `0030` its contract migrations. Its expand migrations include the
  base schema (`0000` to `0019`), because no transition comes before it. Its
  contract step is local step 4.
- `deployment-transitions`: migration `0031` creates the `deployment_transition`
  table. It has no contract migrations and no contract step.

A transition is _independent_ when its expand migrations do not depend on the
contract migrations of the transitions before it and do not change existing
rows. Once every earlier transition has expanded, the deploy may apply an
independent transition's expand migrations ahead of the earlier transitions'
contract migrations. A transition that is not independent is _dependent_.
`deployment-transitions` is independent.

The `deployment_transition` table has one row for each transition that the
deploy has started. The state is `expanded` once the transition's expand
migrations are applied, and `complete` once its contract migrations are applied
too, or immediately for a transition with no contract migrations and no contract
step. The row's `contracted_at` records when the deploy started the contract
migrations. The deploy sets it before the first of them runs, so a run that
stops part-way still leaves it set. It stays empty for a transition without
contract migrations. A transition with no row is _pending_. The deploy creates
`deployment_transition` with `CREATE TABLE IF NOT EXISTS` once its checks pass,
before it applies the first migration, because it records `cache-identity`
before it applies migration `0031`.

When the deploy reads the states, it reconciles them with the `deployment_phase`
row that v0.0.34 and v0.0.35 wrote. `contracted` means that `cache-identity` is
complete, and `native-reads` means that it has at least expanded. Released
builds recorded only these two names. Development builds between releases also
recorded `current` and `expanded`, which do not show that the expand migrations
ran, so the deploy ignores any name other than the two. Recorded states only
rise: a rerun cannot lower `complete` to `expanded`, and repeating a state keeps
its timestamp.

One `cupboard init` run applies the transitions in list order:

1. Read the recorded states, before applying a migration or uploading a Worker,
   and stop with an error in any of these cases:
   - a row with a transition id or state that this build does not define;
   - an artifact whose migrations do not match the transitions;
   - a migration file whose digest differs from the digest recorded when it was
     applied, including a migration of a complete transition;
   - a transition recorded as complete although one of its migrations is missing
     from `d1_migrations`;
   - a dependent transition that follows a transition that is not complete.

   One kind of row does not stop the deploy: a row that a later release wrote
   for its own transition, in state `expanded` or `complete`, with
   `contracted_at` empty. See "Rolling back".

   A dependent transition can expand only once every earlier transition is
   complete. Otherwise its expand migrations could run only after the upload,
   and the new Workers would run without them until then. No transition in this
   release is blocked on any deployment: `deployment-transitions` is
   independent, so a deployment on v0.0.33 upgrades directly. A later release
   that adds a dependent transition can be blocked. Its error lists the releases
   that complete the earlier transition, are not older than the deployed
   release, and do not include the later transition; for `cache-identity`, that
   includes this release. If the deployed release is one of these, rerun its
   `cupboard init` to complete the earlier transition. Then deploy the later
   release. A fresh deployment is exempt, because every transition completes on
   it before the upload.

   The deploy command shows the plan first. When the plan shows a blocked
   transition, the review menu offers only changes to the plan, such as another
   account, and Cancel. On Cancel, or with `--yes`, the command stops with the
   blocking error before it creates any Cloudflare resource or R2 key.

2. Before the upload, on a fresh deployment: apply every transition's expand and
   contract migrations and record each transition complete. A deployment is
   fresh when its database has no `tenant` table, or when the table has no rows
   and neither Worker script exists. A first deploy that stops before the upload
   leaves one of those states. No Workers of an earlier build serve such a
   database, and it has no tenants to wake.
3. Before the upload, otherwise: apply the expand migrations of every transition
   that is not complete and record it `expanded`. A transition with no contract
   migrations and no contract step is complete immediately.
4. Upload both Workers and configure their triggers and secrets.
5. After the upload, read the states again and repeat the checks on the applied
   migrations, then check once that each Worker's deployment assigns all traffic
   to one version and that both Workers report this build. This check runs on
   every deploy, including one on which every transition is complete. Then, for
   each transition that is not complete: wake active or suspended tenants in
   batches of 20 until every one has recorded the transition's contract step;
   for `cache-identity` only, write `native-reads` to the `deployment_phase`
   row; apply the contract migrations and record the transition `complete`.
6. Wake tenants again until they reach local step 5.

A failed serving check, or tenants that have not recorded the contract step,
stop the run in step 5. The contract migrations of the incomplete transition
stay unapplied and that transition stays `expanded`. The error lists the
Workers, or a sample of the tenants below the contract step. If step 6 fails,
the contract migrations have already been applied and recorded. Each tenant wake
stage runs at most 100 batches. Inspect incomplete work with
`cupboard deployment status <url>`, which lists each recorded transition and the
required local step, and retry batches with `cupboard deployment resume <url>`.
Repair any reported tenant configuration or migration error, then rerun
`cupboard init`. Applied migrations are skipped after checking their recorded
digests.

Releases v0.0.34 and v0.0.35 read the `deployment_phase` row, so the deploy
writes it for `cache-identity`: `native-reads` once every active or suspended
tenant has recorded local step 4, and `contracted` once the contract migrations
have run. A rollback to one of those releases therefore reads a correct phase.
If a run stops after it records `cache-identity` complete and before it writes
`contracted`, the next run writes `contracted`. The deploy also corrects a row
with the wrong local step, replaces a phase name that no release wrote, and
creates the table again if a later release dropped it. This build's Workers do
not read the row. The deploy reads it to reconcile the recorded transitions.

The transitions are listed in order in `schemaTransitions` in
`@cupboard/protocol/deployment`, and every migration file belongs to exactly one
of them. Concatenating each transition's expand then contract migrations, in
list order, must give the migration files in name order. The deploy stops with
an error when the artifact's files do not match the transitions, and
`pnpm check:migrations` also fails when the drizzle journal lists the migrations
in a different order. Once a release has shipped a transition, its migration
lists do not change; a new migration goes in a new transition.

There is no elapsed-time delay and no second deploy required solely to apply
contract migrations. The [Workers deployments API] reports the configured
traffic allocation, not whether every old invocation has finished. A [Durable
Object code deployment] restarts its objects; an old in-flight request is
stopped when it next touches object storage, and WebSockets are closed. Old
Worker HTTP requests can continue. The contracted D1 schema rejects their
references to removed columns, and the grant migration installs triggers that
reject writes in the old grant format. Those requests can fail during the
transition and must retry against the new build.

[Workers deployments API]:
  https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/
[Durable Object code deployment]:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

Recording a transition's state does not make a rollback safe. Tenant SQLite
contracts during initialisation under this build, before the `cache-identity`
transition is complete. The `cache-identity` expand migrations retain both cache
representations and mirror inserts from either writer; its contract migrations
remove that compatibility. The reviewed deployment plan identifies the tenant
Worker upload as the local rollback boundary: after an object contracts its
SQLite schema, complete this deployment to recover.

## Local steps

`tenant.local_step` is a watermark for each object's completed data work. The
object never lowers it. The `localStep.wake` control procedure wakes a bounded
batch of active tenants that are behind; the hourly sweep also wakes up to
twenty per tick. `localStep.status` counts ready and pending tenants and lists
up to twenty pending tenants. Large tenants can need several wakes.

`localStep.status` reports the step that it counted against as `required` next
to the build's `current`. That is the required local step unless the query gives
a step. `localStep.wake` reports the required local step as `required` for each
batch. The wake and the control Worker's cron trigger select tenants below it.
Until the deploy records `cache-identity` complete, an object can report at most
step 4, so the count of tenants below step 5 would never reach zero. The
required local step is therefore 4 until then. Once `cache-identity` is
complete, the required local step does not fall below 5, even while a later
transition with a lower contract step is incomplete.

This build defines five steps:

- Step 1 projects missing lifecycle rows into D1, at most 36 caches per wake.
  The local schema migrations now reconcile registrations and fill identity
  columns before the local contraction.
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

Once the deploy records `cache-identity` complete, the required local step
becomes 5. The control plane finds the tenants below it and wakes them again. A
successful CLI deploy applies the contract migrations and then wakes tenants
until they reach step 5. If a run is interrupted,
`cupboard deployment resume <url>` wakes tenants until they reach the required
local step; rerun `cupboard init` to complete any remaining transition. The
hourly sweep also continues tenant work. A persisted cursor rotates through
pending tenants, so a failed tenant does not prevent later tenants from being
attempted.

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
into one grant. Access changes are refused until `cache-identity` is complete,
so an existing selector retains its meaning throughout the compatibility period.

The control plane cannot resolve a tenant cache's access, so it stores named
cache grants in both selector forms. If a template is too long to include the
private selector prefix in the preceding format, adding the rule returns
`CACHE_GRANT_MIGRATION_PENDING` (409). Complete the deployment before adding
that rule.

The `cache-identity` contract migrations rewrite `control_trust`. Local step 5
rewrites each tenant's `oidc_trust` and `refresh_token_family`. Each object
caches its reading of the transition states for one minute, so the local step
reads them again before starting the rewrite. Prepared grants are checked again
immediately before their synchronous database write; a value prepared before
local contraction is converted if contraction finished while its caller awaited
another operation. Database triggers enforce the resulting format. Tolerant
readers remain throughout the transition.

## Cache read credentials

Deleting a cache advances its lifecycle generation and removes its read
credential in one D1 batch. The credential deletion runs only when the lifecycle
transition changes a row. A private cache with no credential of its own accepts
the tenant credential, so the batch prevents a live cache from briefly gaining
that broader access. If the batch commits but its response is lost, a retry
completes local teardown without deleting a credential that was provisioned
afterwards. A credential provisioned before a private cache is registered also
remains available for that new cache.

The contract migration `0030_cache_credential_lifecycle` removes credentials
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
migrations drop the legacy cache and reuse-view tables and remove columns that
the preceding build reads and writes. A tenant that has initialised under this
build has already contracted its local schema, even if D1 has not yet recorded
the transition complete.

After a transition's contract migrations have run, an older build cannot serve
the resulting schema. Deploy this release again to resume an interrupted
transition. Restoring an earlier release requires compatible storage from before
the transition as well as the older Workers. D1 has [Time Travel]; this
repository provides no automated restore procedure for every tenant's Durable
Object storage. A Worker rollback alone is not that recovery procedure.

[Time Travel]: https://developers.cloudflare.com/d1/reference/time-travel/

Generation-key object moves are not reversed either. An older build can neither
read those keys nor retire them during teardown. If it writes at an old key,
redeploying a build whose local step the tenant already recorded does not
necessarily revisit that object. Recover such objects explicitly before relying
on the new keys.

Migration-history admission checks are separate from schema compatibility. A
build can admit a longer history when the extra migrations have verified
digests, yet still be unable to use the schema those migrations produced.

A rollback past a release that added a schema transition leaves that
transition's row in `deployment_transition`. This build's `cupboard init`
decides what to do with such a row from its state and its `contracted_at`, which
the deploy sets before the first contract migration runs:

- state `expanded` or `complete`, with `contracted_at` empty: the later release
  has applied only the transition's expand migrations. The deploy shows the row
  in the plan, leaves it unchanged, and applies only this build's transitions.
  Expand migrations must stay compatible with every build that can still be
  deployed or rolled back to, so this build can run against them.
- state `expanded` or `complete`, with `contracted_at` set: the transition's
  contract migrations have started and may have removed schema that this build
  needs, so the deploy stops with an error before it changes anything. Stay on
  the deployed release, and use its `cupboard deployment status` and
  `cupboard deployment resume` for any remaining tenant work. To roll back to
  this build anyway, first confirm from that release's migrations that its
  contract migrations remove nothing that this build reads. Then clear
  `contracted_at` and deploy this build again:

  ```sh
  wrangler d1 execute <database> --remote --command "UPDATE deployment_transition SET contracted_at = NULL WHERE id = '<id>';"
  ```

  `<database>` and `<id>` are the D1 database name and the transition id that
  the error reports. `--remote` runs the statement against the deployed
  database, not a local copy. Wrangler needs credentials for the deployment's
  Cloudflare account: run `wrangler login`, or set `CLOUDFLARE_API_TOKEN` to a
  token that can edit D1. When the credentials cover several accounts, set
  `CLOUDFLARE_ACCOUNT_ID` to the deployment's account id. If the later release
  dropped `deployment_phase`, this build's deploy creates it again.

- any other state: the deploy stops with an error whatever `contracted_at`
  contains. Deploy a build that defines the transition and the state.

A transition that this build defines, recorded in a state that this build does
not define, also stops the deploy with an error. This release and later releases
list every row that they do not define, of either kind, under `unrecognised` in
the `deployment.transitions` control procedure, and `cupboard deployment status`
prints each one with what this build's deploy does with it. The tenant objects
and the control-plane trust gate ignore a row with an unknown transition id, and
count an unknown state of a known transition as complete, because a later
release may only add states after `complete`.

Rolling back to v0.0.35 leaves the `deployment_transition` table in place.
v0.0.35 does not read the table; it reads the `deployment_phase` row, which this
build writes.

Use `cupboard deployment status` and `cupboard deployment resume` from the same
release as the deployed control Worker. This release replaces the
`deployment.phase` procedure with `deployment.transitions`, which returns the
recorded transitions, and adds `required` to the `localStep.status` and
`localStep.wake` responses. The CLI and the server validate these responses
strictly, so a CLI from another release rejects them or receives 404. The
`--json` output of both commands changes too: the `deployment-status` result has
`transitions`, `unrecognised` and `required` in place of `phase`, and the
`deployment-readiness` result reports `required` as the step that it counted
against.

The `check` API now uses a numeric cache identity in `cursorCache`. An older CLI
cannot validate this response or resume an old scan against it. Use the CLI from
this release and start the scan again.
