# Deploying cupboard

cupboard runs on your own Cloudflare account. `cupboard init` creates what it
needs there: two Workers, a database, a storage bucket and a few smaller
resources. It also makes you the deployment's **admin**, and creates the first
**tenant**. A tenant is a separate space on the deployment with its own caches,
signing keys and administrators.

The admin is the first **operator**: a person who administers the deployment as
a whole. The admin can [add other operators](./operators.md#adding-operators).

This page walks you through a first deployment, then covers the choices that you
can make and the details of what `init` does.

## What you need

- A Cloudflare account with R2 enabled. cupboard works on both the Workers Free
  and Paid plans. See [Workers plans](#workers-plans).
- A workers.dev subdomain registered for the account. You can register one under
  Workers & Pages in the Cloudflare dashboard. You don't need one if you'll
  serve cupboard from a [custom domain](#custom-domains).
- The `cupboard` CLI. See [Installing the CLI](../installing.md).
- A terminal, and a browser where you can sign in. The identity that you sign in
  with for the [claim](#claiming-the-deployment) becomes the deployment's admin.
  By default this is your Cloudflare identity.
- An R2 bucket and an R2 API token for the browser-sign-in walkthrough below. If
  your Cloudflare API token can manage account tokens, `init` can create the
  bucket and a write-only key instead. See [Letting `init` create a
  key][create-r2-key].

[create-r2-key]: #letting-init-create-a-key

If you're logged in to `wrangler` on this machine, `init` may use wrangler's
stored token to make changes on the Cloudflare account. Pass `--no-wrangler` to
sign in to Cloudflare in the browser instead. Either way, the claim uses a
separate sign-in, so the token doesn't decide who becomes the admin.

## Deploying for the first time

1. In the Cloudflare dashboard, create an R2 bucket called `cupboard-blobs`. You
   can use another name, but you'll need to change it in the plan in step 4.

2. Under R2, open Manage API tokens and create a token with **Object Read &
   Write** permission on that bucket. Keep its access key ID and secret access
   key to hand. There are other ways to give cupboard an R2 key, described in
   [R2 credentials](#r2-credentials).

3. Run `init`, choosing an [instance name](#the-instance-name):

   ```sh
   cupboard init --instance-name cupboard
   ```

   If you want to serve cupboard from your own domain, add
   `--domain cache.example.com` now. Each tenant is tied to the address that it
   was created at, so choose the domain before you create any. See
   [Custom domains](#custom-domains).

   `init` opens your browser so you can sign in to Cloudflare. If you have
   access to several accounts, it asks which one to use. You can choose in
   advance with `--account` or the `CLOUDFLARE_ACCOUNT_ID` environment variable.

4. Review the plan. `init` shows what it's going to create, and lets you change
   the account, custom domain, R2 bucket name, D1 database, queue names and cron
   triggers before you confirm. See
   [Resource names and cron triggers](#resource-names-and-cron-triggers).

   The default plan shows the release, deployment URL, intended changes, storage
   credentials, tenant readiness and recovery instructions. Add `--details` for
   the resource names and maintenance schedule. The maintenance queue and its
   dead-letter queue have separate labels. Add `--debug` for database migration
   identifiers and other implementation diagnostics.

5. Confirm who becomes the admin. `init` signs you in for the claim, shows the
   identity from your sign-in, and asks:

   ```
   Claim this deployment as <name> (issuer <issuer>, subject <subject>, audience <audience>)?
   ```

   The claim can't be undone. See
   [Claiming the deployment](#claiming-the-deployment).

   On a first deploy, `init` then shows two newly generated secrets. Save
   `CONTROL_KEY_WRAP_SECRET` with your other secrets now. It isn't shown again.
   See [What to keep](#what-to-keep).

6. When `init` asks for R2 credentials, enter the access key ID and secret from
   step 2.

7. Wait while `init` deploys. It creates the resources, applies the database
   migrations, and uploads and configures both Workers. When the new Workers are
   serving, it claims the deployment and prints:

   ```
   You are now the admin of this deployment (<name>).
   ```

8. Create the first tenant. `init` asks for:
   - a **slug**, the tenant's name in its URL. With the slug `acme`, the tenant
     URL is `https://cupboard.example.workers.dev/t/acme`. See
     [Tenant slugs](#tenant-slugs).
   - whether the tenant's default cache is public ("Anyone who learns the URL")
     or private ("Only clients with a read credential").

   You can answer both in advance with `--cache acme` and `--access public` or
   `--access private`. You become the tenant's owner. See
   [The first tenant](#the-first-tenant).

9. Save the tenant read credential. `init` prints it along with the netrc line
   that Nix needs for a private cache and the lines to add to `nix.conf`. The
   password isn't shown again.

`init` finishes with:

```
Deployment verified. Next: cupboard push https://cupboard.example.workers.dev/t/acme ./result
```

Push something to the new tenant, then set up your Nix clients as described in
[Using a cache](../use/nix-clients.md).

## Checking the final outcome

Read the final deployment message as well as the exit status.
`Deployment verified` means the deployment answered the availability checks.
`Uploaded; deployment availability has not been confirmed` means the upload
completed, but the deployment did not pass those checks. Complete any reported
setup steps before using a new deployment.

For an update to a deployment that already has an administrator, the command can
exit with status zero while availability remains unconfirmed. That exit policy
is unchanged. A zero status alone does not prove that the deployment is usable.
Check the deployment URL and the final outcome before treating the update as
ready. A first deployment that stops before administrator setup exits non-zero.

`cupboard deployment status <deployment-url>` checks tenant schema and data
readiness. The status command does not check public availability or repeat every
step of deployment.

## What to keep

`init` shows some values only once. Keep a copy of these:

- `CONTROL_KEY_WRAP_SECRET`, shown after the plan on the first deploy. The
  control Worker uses it to encrypt the keys that sign operator tokens. You'll
  only need your copy if the Worker's secret is ever deleted. In that case, you
  must restore exactly the same value, because any other value stops operators
  from signing in. Never set a different `CONTROL_KEY_WRAP_SECRET` when you
  deploy: when the variable is set in the environment, `init` uploads its value
  on every deploy and replaces the Worker's secret. When the variable isn't set,
  `init` generates a value only if the control Worker doesn't have one yet.
- The tenant read credential, shown when `init` creates the first tenant. The
  user name is `cupboard` and the password is generated. The deployment only
  keeps a salted hash of the password, not the password itself. If you lose the
  password, replace the credential with `cupboard tenant rotate-credential`.

`init` also shows `PUSH_ID_SIGNING_KEY`, with a note to save it, but you don't
need a copy. Both Workers keep it. When a deploy finds that only one Worker has
the key, it generates a new one for both, and pushes that were in progress have
to be run again. Changing the key also ends every tenant refresh session issued
by this release, and tenant administrators with such a session have to sign in
again. If `PUSH_ID_SIGNING_KEY` is set in the environment, `init` uploads that
value to both Workers on every deploy.

## The instance name

The instance name is the first part of every signing key's name. It lets Nix
clients tell which deployment a key belongs to. With `--instance-name cupboard`,
the first key for the tenant `acme` is called `cupboard-acme-1`.

Hyphens in the instance name and the tenant slug are doubled in the key name.
For example, with the instance name `acme-cache`, the same key would be called
`acme--cache-acme-1`.

An instance name can be up to 63 characters long. It can contain lower-case
letters, digits and hyphens, but can't start or end with a hyphen. You can't
change it after the first successful `init`.

If you leave out `--instance-name`, `init` uses `cupboard-` followed by 16
hexadecimal digits worked out from the deployment's address.

## Tenant slugs

A slug can be 1 to 63 characters long. It can contain lower-case letters,
digits, `.`, `_` and `-`, and must start with a letter or a digit.

A slug can never be used again, even after its tenant has been removed.

## R2 credentials

The tenant Worker writes to R2 through R2's S3-compatible API. That API needs an
access key of its own, separate from your Cloudflare sign-in. If the deployment
doesn't have one yet, `init` can get one in three ways.

### Entering a key

This is what the walkthrough above does. Create the bucket in the dashboard
first. The default name is `cupboard-blobs` unless you change it in the plan.
Then create a token in the R2 section, under Manage API tokens, with **Object
Read & Write** permission on the bucket, and enter its access key ID and secret
when `init` asks. If the bucket doesn't exist yet, the credential check fails
with HTTP 404.

### Supplying a key in the environment

Set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the environment that `init`
runs in. Every deploy that sets these variables replaces the deployment's key
with them.

### Letting `init` create a key

`init` only creates a key when you
[deploy with a Cloudflare API token](#deploying-with-an-api-token) that is
allowed to create API tokens. It creates the bucket if it doesn't exist, then
creates an account token called `cupboard-r2-<bucket>` that can only write
objects in that bucket.

### Checking and keeping the key

Before deploying, `init` checks that the key works by starting an upload and
then aborting it. If `init` created the key, Cloudflare can take a little while
to make it available, so `init` tries the check up to 12 times, five seconds
apart. If you entered the key, and the check fails, `init` lets you re-enter the
key, deploy anyway, or cancel.

Later deploys keep the key that the deployment already has. They only change it
if the environment supplies a new one, you rename the bucket, or you choose to
replace the key in the plan.

## Deploying with an API token

If `CLOUDFLARE_API_TOKEN` is set, `init` uses that token instead of signing you
in to Cloudflare through the browser. The token needs these permissions on the
account:

| Permission                                 | Needed for                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Workers Scripts: Edit                      | Uploading and configuring the Workers.                             |
| D1: Edit                                   | The database.                                                      |
| Workers R2 Storage: Edit                   | The bucket.                                                        |
| Workers KV Storage: Edit                   | The KV namespaces.                                                 |
| Queues: Edit                               | The maintenance queues.                                            |
| Billing: Read                              | Detecting the Workers plan. Without it, pass `--workers-plan`.     |
| Zone: Read, on the domain's zone           | A custom domain.                                                   |
| Workers Routes: Edit, on the domain's zone | Attaching the control Worker to a custom domain.                   |
| Account API Tokens: Edit                   | Optional. Lets `init` [create the R2 key](#r2-credentials) itself. |

The token only lets `init` change the Cloudflare account. It doesn't make anyone
the deployment's admin. The [claim](#claiming-the-deployment) needs a sign-in
from a terminal, whichever Cloudflare credential `init` uses. A first deploy
without a terminal, for example from CI, therefore can't claim the deployment.
It deploys the Workers and then fails, because a deployment without an admin
can't create a cache. Run `cupboard init` from a terminal to claim it.

Once the deployment has an admin, you can upgrade it from CI with a token. See
[Updating from CI](./upgrading.md#updating-from-ci).

## Custom domains

By default, the deployment is served from
`https://cupboard.<your-subdomain>.workers.dev`. To serve it from your own
domain as well, pass `--domain`:

```sh
cupboard init --domain cache.example.com
```

The domain's zone must be in the same Cloudflare account. If it isn't, `init`
warns you and doesn't change the Worker's domains.

The deployment only keeps the domain that you give it. `init` removes any other
custom domain from the Worker. The workers.dev address stays enabled. A new
domain can take a few minutes to start resolving. Later runs of `init` keep the
existing domain unless you pass a different one.

Choose the domain before you create tenants. Each tenant is tied to the address
that it was created at: its tokens contain that tenant URL as their issuer and
audience, whichever address they were requested at. The CLI only uses a session
for the URL in its token, so a tenant created at the workers.dev address can't
be administered at the custom domain.
[Moving to a new URL](#moving-to-a-new-url) says what that means for an existing
deployment.

### HTTPS for a custom domain

The Worker refuses every plain HTTP request with status 403, and adds
`Strict-Transport-Security: max-age=31536000` to HTTPS responses other than
WebSocket upgrades. This works on workers.dev and on a custom domain.

For a custom domain, you can also turn on two zone settings in the Cloudflare
dashboard, under **SSL/TLS** > **Edge Certificates**. **Always Use HTTPS**
redirects plain HTTP requests to HTTPS before they reach the Worker, so a
browser that follows an `http://` link still reaches the deployment. **HTTP
Strict Transport Security (HSTS)** adds an HSTS header at Cloudflare's edge, and
you choose its `max-age` and options.

Both settings apply to every host in the zone, not only to the deployment's
domain, so check that the zone's other hosts work over HTTPS first. A browser
remembers an HSTS header for its `max-age`, and the `includeSubDomains` option
extends it to every subdomain. `init` doesn't change these settings.

A redirect doesn't protect a client that sends a token or a read credential in
its first request, because the credential crosses the network before the
redirect arrives. The CLI refuses `http://` URLs except to loopback hosts. Nix
and other clients still send such a request, and the Worker refuses it only
after the credential has been sent. Use `https://` URLs in every Nix
configuration.

### Moving to a new URL

Changing the custom domain later moves the deployment to a new URL, and so does
adding a first custom domain to a deployment that serves on workers.dev. The
deploy wakes the tenants to run any pending migration and initialises the
deployment at the new URL, so it needs an admin token for the new URL before it
changes anything. An admin token for one URL isn't accepted at another.

A move doesn't change the tenants that already exist. Each one keeps the tenant
URL that it was created at as the issuer and audience of its tokens. For each
existing tenant:

- Keep using the original tenant URL with `cupboard login` and the other CLI
  commands. A session requested at the new URL contains the original URL, so the
  CLI doesn't use it for the new one.
- Keep the original tenant URL in CI: in the `url` input of the workflows, and
  as the audience of the tenant's trust rules.
- Keep the original address routed to the deployment. A move from workers.dev to
  a custom domain leaves the workers.dev address enabled. A move from one custom
  domain to another removes the old domain, and the tenants created at it lose
  the address that their tokens and trust rules contain. `init` keeps only the
  domain that you give it, so you can't keep both. Move from one custom domain
  to another only before you create tenants at the first one.
- Update `nix.conf` on clients that read a cache at a domain that the move
  removed.

If the new URL already serves the deployment, for example because you routed the
new domain to the control Worker in the Cloudflare dashboard, `init` checks the
admin token there as it does at the current URL, and in a terminal it can sign
you in there. Routing a domain in the dashboard doesn't change the current URL,
because `init` takes the current URL from its record (see
[Signing in to upgrade](./upgrading.md#signing-in-to-upgrade)). For a deployment
last updated by v0.0.35 or earlier, which has no record, run `cupboard init`
once before you route the new domain. Otherwise the deploy takes the routed
domain as the current URL.

If the new URL doesn't serve the deployment yet, `init` can't get or check a
token there before the upload. It then uses a session for the new URL that is
cached on this machine. The session's token must have been issued by the new URL
and include the [wildcard grant](../concepts.md#signing-in-and-trust-rules). An
expired token is accepted only if the session has a refresh token. Without such
a session, `init` stops before it changes anything. Route the new domain to the
control Worker in the Cloudflare dashboard and deploy again. In a terminal,
`init` then signs you in at the new URL if it needs to.

A run with `--github-oidc` never uses a cached session, so it can only move a
deployment whose new URL already serves it. It requests a GitHub token whose
audience is the current URL, or the `--audience` value, at both URLs, because
the workflow's control trust rule pins one audience. After the move, the
recorded URL is the new one, and later runs request the new URL as their
audience. Before the next run, pass `--audience` with the old URL, or add a
control trust rule for the new URL.

## Claiming the deployment

A deployment has one **admin**, recorded in the `global_admin` row of its D1
database. The first identity to complete the claim becomes the admin. Once the
row exists, nobody else can claim the deployment. The admin can then
[add other operators](./operators.md#adding-operators).

Whether `init` claims or updates the deployment depends on that row, not on
whether Workers are already deployed. Before it changes anything, `init` reads
the admin from two databases: the database that the deployed Workers are bound
to, and the database that the plan selects. Usually they're the same database.
When neither records an admin, `init` claims the deployment. Otherwise it
updates the deployment, which needs an admin token. See
[Signing in to upgrade](./upgrading.md#signing-in-to-upgrade).

### Signing in for the claim

When there is a terminal, `init` signs you in for the claim. By default it signs
you in to Cloudflare, reusing cupboard's cached Cloudflare sign-in if there is
one and opening a browser only if it can't renew it. `--oidc-issuer` and
`--client-id` select another OIDC issuer and OAuth client, with the same
defaults as `cupboard login`. With another issuer or client, the sign-in is
always a new one. `--headless` uses the device flow, without a browser on this
machine. The Cloudflare sign-in for the account can still open a browser.

`init` then shows who the claim makes the admin: the display name, issuer,
subject and audience from your ID token. It asks you to confirm, because the
claim can't be undone. `--yes` confirms without asking.

The ID token must meet three conditions:

- its issuer is an HTTPS URL without a query or fragment;
- it has a `sub` claim;
- its `aud` claim contains exactly one audience, because the control trust rule
  that the claim creates pins one.

`init` checks these before it changes anything, and stops if the token doesn't
meet them, because the deployment would refuse the token after the upload. An
issuer that adds further audiences to its ID tokens can't be used for the claim.

### How the claim works

`init` generates a claim secret and sets it on the control Worker as
`CUPBOARD_SIGNUP_SECRET`, along with the Worker's other secrets. Once the new
Workers are serving, it:

1. presents the secret and your ID token at `/signup`. The deployment records
   the token's issuer and subject as the admin, creates a control trust rule
   with the ID `signup` that pins the issuer, subject and audience, and returns
   an admin session;
2. removes the secret from the Worker, whether or not the claim succeeded;
3. caches the admin session, as `cupboard login` does.

The ID token presented at the claim must belong to the identity that you
confirmed. `init` keeps the token from the sign-in before the upload, and signs
in again only if that token expires within a minute. If the second sign-in
returns another identity, `init` stops before the claim.

If the claim succeeds but the admin token can't be cached, `init` stops and says
that the claim succeeded. Run the `cupboard login` command that it prints, then
run `cupboard init` again to finish.

`init` retries `/signup` while it returns 404, 408, 429, 502, 503 or 504, up to
30 times, four seconds apart. It also retries a 403 for about 30 seconds after
the new Workers start serving, because the version of the control Worker without
the claim secret can keep answering until the new version serves. If the claim
still fails, see
["The admin claim failed"](../troubleshooting.md#the-admin-claim-failed).

`/signup` accepts the claim secret from anyone for as long as it's set. `init`
removes the secret after the claim attempt, and also when a run stops after
setting the secret but before the claim, including when you interrupt it. Before
its own upload, a deploy that updates the deployment, or that has no terminal,
removes any secret that an earlier run left. If a removal fails, `init` prints a
warning, and the secret stays on the Worker until the next `cupboard init`
removes it. `init` never prints the value or writes it to disk.
`CUPBOARD_SIGNUP_SECRET` in the environment has no effect on `init`.

### When the claim doesn't happen

A deployment that was deployed without a claim is claimed by the next
`cupboard init` from a terminal. So is a deployment whose earlier deploy stopped
before the claim. The next run sets a fresh claim secret.

A first deploy from a terminal stops before the claim if the deployment keeps
answering with an older build or an error status, or if the account has no
workers.dev subdomain. `init` then says that the deployment has no admin yet and
exits with a non-zero status. A network failure while it waits for the new
Workers ends the run with that error instead.

A first deploy without a terminal deploys the Workers but skips the claim and
the first tenant, because the claim needs a sign-in. It doesn't wait for the new
Workers to serve. It exits with an error that says that the deployment has no
admin.

## The first tenant

`init` creates the first tenant only on a deployment that has no tenants, and
only for the admin.

`init --tenant <slug>` is an alias for `--cache <slug>`. Both options specify
that tenant's slug; neither selects a named cache. To create more tenants or
named caches, use `tenant create` or `cache create`. `--access` specifies the
first tenant's default cache access.

- In a terminal, `init` asks for the tenant's slug and the read access of its
  default cache. `--cache` and `--access` answer these questions in advance.
- Without a terminal, `init` creates the first tenant only from `--cache` and
  `--access`, on a deployment that already has an admin. It refuses either
  option without the other before deploying, including on update runs when a
  tenant already exists. Pass both options or omit both. If the slug is taken,
  it exits with an error.
- A first deploy without a terminal has no admin, so it ignores both options,
  and warns about them before it changes anything.

When the deployment already has a tenant, `init` says that it didn't apply
`--cache`.

## Workers plans

Cloudflare limits how many calls to D1, R2 and its other services a single
request can make. The limit is 1,000 calls on the Workers Free plan and 10,000
on the Paid plan. `init` looks up the account's plan on every deploy and sets up
cupboard to match. It recognises the Paid plan only by the rate plan
`WORKERS_PAID`. If it can't read the plan, or the account has a Workers plan
that it doesn't recognise, it uses the Free limit and tells you why, including
the rate plan's ID. An account on another paid Workers plan therefore gets the
Free limit unless you pass `--workers-plan paid`.

`init` stores the limit in the `CUPBOARD_SUBREQUESTS_PER_INVOCATION` variable of
both Workers. The Workers use the Paid limit only when the value is exactly
`10000`. Any other value, or none, gives the Free limit.

You can skip the lookup by passing `--workers-plan free` or
`--workers-plan paid`. If you're on the Paid plan and your credentials can't
read billing information, pass `--workers-plan paid` every time you deploy.
Otherwise each deploy sets the Free limit again.

The option must match the account's real plan. It only changes the limit that
cupboard uses, not your Cloudflare subscription.

## What `init` creates

| Resource                               | Name                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Control Worker, serving the deployment | `cupboard`                                                                   |
| Tenant Worker and its Durable Objects  | `cupboard-tenant`                                                            |
| D1 database                            | `cupboard`                                                                   |
| R2 bucket                              | `cupboard-blobs`, with a rule that cleans up abandoned uploads daily         |
| KV namespaces                          | `cupboard-tenant-cache`, `cupboard-cron-state`                               |
| Queues                                 | `cupboard-maintenance`, and its dead-letter queue `cupboard-maintenance-dlq` |
| Cron trigger                           | Hourly, on the control Worker                                                |
| Account API token                      | `cupboard-r2-<bucket>`, if `init` created the R2 key                         |

`init` creates anything that's missing and leaves existing resources alone.

### Resource names and cron triggers

Before it changes anything, `init` shows the plan and a menu for changing it. In
the menu you can choose the names of the R2 bucket, the D1 database, the
maintenance queue and its dead-letter queue, and change the control Worker's
cron triggers. The KV namespace names can't be changed. The list of cron
triggers can't be empty, because the control Worker only runs maintenance when a
cron trigger fires.

On an account that already has a control Worker, the plan starts from the
existing deployment. `init` reads the bucket, the database and the maintenance
queue from the control Worker's bindings, the dead-letter queue from its queue
consumer, and the cron triggers from its schedules. Accepting the plan as shown,
or deploying with `--yes`, keeps them. On an account without a control Worker,
the plan starts from the release's defaults.

A release that changes a default resource name or cron trigger doesn't change an
existing deployment. There is one exception: when the control Worker has no
schedules, for example after a first deploy that failed before it set them, the
plan uses the release's cron triggers. To use a new default in any other case,
change the value in the menu.

Up to v0.0.35, `init` started every plan from the release's defaults, so
accepting the plan could point the Workers at new, empty resources with the
default names. To use the original resources again, enter their names in the
menu. If the original database or the current one records an admin, first bind
the control Worker to the original database, as described in
[Changing the control database](#changing-the-control-database).

Choosing a different account in the menu restarts the plan from that account's
existing deployment. The switch discards the resource, cron trigger and domain
changes made so far, and any request to replace the R2 key. The plan then shows
the domain given with `--domain`, or otherwise the custom domain routed to that
account's control Worker.

To see the plan without signing in or changing anything, pass `--dry-run`.
Because a dry run doesn't sign in, it can't read the existing deployment, so it
shows the release's defaults.

### Changing the control database

`init` refuses a plan that selects a D1 database other than the one that the
deployed Workers use, if either database records an admin. Deploying such a plan
would either claim the deployment again while a database records an admin, or
leave the admin in a database that the Workers no longer use. The refusal
happens before any change.

To keep the current database, select it in the plan menu. To move the deployment
to the other database, first bind the control Worker to it: in the Cloudflare
dashboard, open the control Worker under Workers & Pages, change its
`CUPBOARD_DB` binding under Settings > Bindings, and deploy the new version.
Then run `cupboard init` again, as the admin that the other database records.
When neither database records an admin, `init` claims the deployment with the
database that the plan selects.

## Running `init` again

It's safe to run `init` again. It skips migrations that have already been
applied, and only uploads the Workers if they've changed. It keeps the custom
domain, the tenants, and the existing secrets, resource names and cron triggers.
It does look up the [Workers plan](#workers-plans) again each time.

Once the deployment has an admin, `init` needs an admin token to update it. See
[Signing in to upgrade](./upgrading.md#signing-in-to-upgrade).

Running `init` again with a newer CLI is how you upgrade. See
[Upgrading](./upgrading.md).

## If the control Worker was deleted

When the control Worker no longer exists, `init` reads the database binding of
the tenant Worker, and reads the admin from that database and from the database
that the plan selects. When the tenant Worker was deleted too, it reads only the
database that the plan selects. If a database records an admin, `init` stops
before it changes anything and prints the name of that database, because no
Worker can check an admin token. `init` can't recreate the control Worker of a
claimed deployment. Redeploy it with Wrangler from a checkout of the release
that you're deploying:

1. Run `pnpm install` at the root of the checkout, then `pnpm build-info` in
   `packages/server`. The Worker imports the build information that
   `pnpm build-info` generates, and a fresh checkout doesn't have it.
2. In `packages/server/wrangler.jsonc`, set these values to the deployment's
   own. The tenant Worker's settings in the Cloudflare dashboard list most of
   them.
   - `name`: the control Worker's script name;
   - the `CUPBOARD_DB` binding's `database_name` and `database_id`: the database
     that the error lists;
   - the `BLOBS` R2 bucket;
   - the `TENANT_CACHE` and `CRON_STATE` KV namespace IDs;
   - the `MAINTENANCE_QUEUE` producer, the queue consumer and its dead-letter
     queue;
   - the `CUPBOARD_TENANT` service and the `CUPBOARD_DO` `script_name`: the
     tenant Worker's script name;
   - add `CUPBOARD_DEPLOYMENT_URL` under `vars`: the deployment's URL, such as
     `https://cupboard.example.workers.dev`. The checkout's configuration does
     not include this binding; `init` normally adds it when uploading the
     Worker.
3. If the tenant Worker was deleted too, deploy it first. Set `name` and the
   `CUPBOARD_DB`, `BLOBS` and `MAINTENANCE_QUEUE` bindings in
   `packages/server/wrangler.tenant.jsonc` in the same way, then run
   `pnpm exec wrangler deploy -c wrangler.tenant.jsonc` in `packages/server`.
4. Run `pnpm exec wrangler deploy` in `packages/server`.
5. Set the original `CONTROL_KEY_WRAP_SECRET` with
   `pnpm exec wrangler secret put CONTROL_KEY_WRAP_SECRET` in `packages/server`.
   The Worker's secrets were deleted with it, and only the original value can
   decrypt the control database's signing keys. The first deploy printed the
   value if it generated it.
6. If the deployment served on a custom domain, route that domain to the Worker
   again.
7. Run `cupboard init` as the admin, with `--domain` set to the custom domain if
   the deployment served on one. `init` checks the admin token against the
   redeployed Worker and replaces the Worker with this release.

## Removing a deployment

There's no command to remove a deployment. To remove one:

1. Delete the resources listed in [What `init` creates](#what-init-creates), and
   any custom domain, in the Cloudflare dashboard.
2. On every machine that signed in to the deployment or its tenants, delete the
   saved sessions. `cupboard logout <url>` deletes the session for one
   deployment or tenant URL. If the machine uses no other cupboard deployment,
   `cupboard logout --all --cloudflare` deletes every saved session and the
   Cloudflare sign-in. Logout cannot revoke the sessions of a deployment that no
   longer exists, but it still deletes them. The CLI keeps them in
   `$XDG_CONFIG_HOME/cupboard`, or `~/.config/cupboard` when `XDG_CONFIG_HOME`
   isn't set.
