# Deploying cupboard

cupboard runs on your own Cloudflare account. `cupboard init` creates what it
needs there: two Workers, a database, a storage bucket and a few smaller
resources. It also makes you the deployment's **operator**, the person who
administers the deployment as a whole, and creates the first **tenant**. A
tenant is a separate space on the deployment with its own caches, signing keys
and administrators.

This page walks you through a first deployment, then covers the choices that you
can make and the details of what `init` does.

## What you need

- A Cloudflare account with R2 enabled. cupboard works on both the Workers Free
  and Paid plans. See [Workers plans](#workers-plans).
- A workers.dev subdomain registered for the account. You can register one under
  Workers & Pages in the Cloudflare dashboard. You don't need one if you'll
  serve cupboard from a [custom domain](#custom-domains).
- The `cupboard` CLI. See [Installing the CLI](../installing.md).
- A terminal, and a browser where you can sign in to Cloudflare. The identity
  that you sign in with becomes the deployment's operator.
- An R2 bucket and an R2 API token. The first step below shows how to create
  them.

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
   `--domain cache.example.com` now. Tenants are tied to the address that they
   were created at, so it's much easier to choose the domain before you create
   any. See [Custom domains](#custom-domains).

   `init` opens your browser so you can sign in to Cloudflare. If you have
   access to several accounts, it asks which one to use. You can choose in
   advance with `--account` or the `CLOUDFLARE_ACCOUNT_ID` environment variable.

   If `wrangler` is logged in on this machine, `init` uses wrangler's token to
   reach the account instead of opening a browser. Pass `--no-wrangler` to sign
   in yourself.

4. Review the plan. `init` shows what it's going to create, and lets you change
   the account, custom domain, R2 bucket name, D1 database, queue names and cron
   triggers before you confirm.

5. Confirm who becomes the operator. `init` shows the identity that you signed
   in with and asks you to confirm it, because the claim can't be undone. The
   CLI calls the operator the deployment's admin. See
   [How the first deploy claims the deployment](#how-the-first-deploy-claims-the-deployment).

   Before it deploys, `init` also shows two newly generated secrets. Save
   `CONTROL_KEY_WRAP_SECRET` with your other secrets now. It isn't shown again.
   See [What to keep](#what-to-keep).

6. When `init` asks for R2 credentials, enter the access key ID and secret from
   step 2.

7. Wait while `init` deploys. It creates the resources, applies the database
   migrations, and uploads and configures both Workers. Once the new Workers are
   serving, it claims the deployment for you and prints:

   ```
   You are now the admin of this deployment (<your name>).
   ```

   It also signs you in, so the operator commands work afterwards without
   `cupboard login`.

8. Create the first tenant. `init` asks for:
   - a **slug**, the tenant's name in its URL. With the slug `acme`, the tenant
     URL is `https://cupboard.example.workers.dev/t/acme`. See
     [Tenant slugs](#tenant-slugs).
   - whether the tenant's default cache is public ("Anyone who learns the URL")
     or private ("Only clients with a read credential").

   You can answer both in advance with `--cache acme --access public`. You
   become the tenant's owner.

9. Save the tenant read credential. `init` prints it along with the netrc line
   that Nix needs for a private cache and the lines to add to `nix.conf`. The
   password isn't shown again.

`init` finishes with:

```
Deployed and initialised. Next: cupboard push <url> ./result
```

Push something to the new tenant, then set up your Nix clients as described in
[Using a cache](../use/nix-clients.md).

## What to keep

`init` shows some values only once. Keep a copy of these:

- `CONTROL_KEY_WRAP_SECRET`, shown with the plan on the first deploy. The
  control Worker uses it to encrypt the keys that sign operator tokens. You'll
  only need your copy if the Worker's secret is ever deleted. In that case, you
  must restore exactly the same value, because any other value stops operators
  from signing in. Never set a different `CONTROL_KEY_WRAP_SECRET` when you
  deploy.
- The tenant read credential, shown when `init` creates the first tenant. The
  user name is `cupboard` and the password is generated. The deployment only
  keeps a verifier, not the password itself. If you lose the password, replace
  the credential with `cupboard tenant rotate-credential`.

`init` also shows `PUSH_ID_SIGNING_KEY`. Both Workers keep this themselves, so
you don't need a copy.

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
then aborting it. If `init` created the key, it retries the check for about a
minute while Cloudflare makes the new key available. If you entered the key, and
the check fails, `init` lets you re-enter the key, deploy anyway, or cancel.

Later deploys keep the key that the deployment already has. They only change it
if the environment supplies a new one, you rename the bucket, or you choose to
replace the key in the plan.

## Deploying with an API token

If `CLOUDFLARE_API_TOKEN` is set, `init` uses that token instead of signing you
in through the browser. The token needs these permissions on the account:

| Permission                       | Needed for                                                         |
| -------------------------------- | ------------------------------------------------------------------ |
| Workers Scripts: Edit            | Uploading and configuring the Workers, and their domains.          |
| D1: Edit                         | The database.                                                      |
| Workers R2 Storage: Edit         | The bucket.                                                        |
| Workers KV Storage: Edit         | The KV namespaces.                                                 |
| Queues: Edit                     | The maintenance queues.                                            |
| Billing: Read                    | Detecting the Workers plan. Without it, pass `--workers-plan`.     |
| Zone: Read, on the domain's zone | A custom domain.                                                   |
| Account API Tokens: Edit         | Optional. Lets `init` [create the R2 key](#r2-credentials) itself. |

The token only gives `init` access to the account. It doesn't make anyone the
operator, and it doesn't let `init` change a deployment that already has one. On
a first deploy at a terminal, `init` still signs you in through the browser to
claim the deployment. Without a terminal, it deploys the Workers, leaves the
deployment without an operator, and exits with an error. Run `cupboard init`
from a terminal to claim it. On a later deploy, `init` needs the operator's
session, as described in [Deploying again](#deploying-again). From CI, pass
`--github-oidc`. See
[Upgrading from automation](./upgrading.md#upgrading-from-automation).

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

Choose the domain before you create tenants. Tokens are issued for the address
that they were requested at, and each tenant is tied to the address that it was
created at. Sessions and tenants created at the workers.dev address can't be
used at the custom domain.

### Moving to a new domain

Changing the custom domain moves the deployment to a new URL. So does adding a
first custom domain to a deployment that serves on workers.dev. The operator's
token is only accepted at the URL that issued it, so `init` needs a token for
the new URL as well as for the current one before it changes anything.

The easiest way is to route the new domain to the control Worker in the
Cloudflare dashboard first. `init` then checks your token at the new URL in the
same way as at the current one, and at a terminal it can sign you in there.
Routing the domain in the dashboard doesn't change the URL that `init` treats as
current, because `init` reads that URL from its own record. For a deployment
from a release before this record existed, run `init` once before you route the
new domain. Otherwise `init` would take the routed domain for the current URL.

If the new domain doesn't serve the deployment yet, `init` can't check a token
there. It then uses a session for the new URL that `cupboard login` has already
cached on this machine, if there is one. Without one, it stops before any
change.

A run with `--github-oidc` never uses a cached session, so it can only move a
deployment when the new domain already serves it. After the move, `init` records
the new URL, and later runs with `--github-oidc` request a token for the new
URL. Before the next run, add a control-plane trust rule for the new URL, or
pass `--audience` with the old one.

## Who can deploy

A deployment records one identity as its operator. The CLI calls this identity
the deployment's **admin**. The first deploy from a terminal records the
identity of whoever runs it. Every later deploy needs a session for that
identity, or for another [operator](./operators.md) that has been added since.

### How the first deploy claims the deployment

Recording the operator is called the claim. On a first deploy, `init` signs you
in, shows the identity that the claim will record, and asks you to confirm,
because the claim can't be undone. `--yes` confirms without asking.

By default, you sign in with Cloudflare. Pass `--oidc-issuer` and `--client-id`
to use another OpenID Connect provider instead. With the defaults, and without
`--headless`, `init` reuses the Cloudflare sign-in that cupboard has cached on
this machine, and only opens a browser when there is none or it can't be
renewed. With `--headless`, it uses the device flow.

`init` checks your identity token before it changes anything. The token's issuer
must be an HTTPS URL without a query or fragment, the token must have a `sub`
claim, and its `aud` claim must contain exactly one audience. A provider that
adds further audiences to its tokens can't be used for the claim.

The claim happens after the Workers are deployed. `init` sets a secret that it
generates, `CUPBOARD_SIGNUP_SECRET`, on the control Worker along with the other
secrets. Once the new build is serving, it presents the secret and your identity
token at the deployment's `/signup` endpoint, which records you as the operator
and adds the control-plane trust rule `signup` that lets you sign in. `init`
then deletes the secret, whether or not the claim succeeded, and signs you in.
It never prints the secret or writes it to disk.

While the secret is set, `/signup` accepts it from anyone. So `init` also
removes it when a run stops after setting it, including when you interrupt the
run, and a later run removes any secret that an interrupted run left behind. If
a removal fails, `init` warns you, and the next run removes the secret.

The deployment can refuse or delay the claim. `init` retries while the
deployment answers 404, 408, 429, 502, 503 or 504, for about two minutes. It
also retries a 403 for about 30 seconds, because the Worker version without the
secret can keep answering until the new version serves. If the claim still
fails, the error says what to do. A 409 means that someone else claimed the
deployment first. A 400 means that the deployment rejected your token, and the
error includes the deployment's reason. Repeated 403s mean that the secret
didn't take effect in time, and running `init` again claims with a fresh secret.

When a run ends without a claim, `init` exits with an error that begins
"Deployed, but … has no admin". The Workers are deployed, and nobody can create
a tenant until someone claims the deployment. Run `init` again from a terminal.

### Deploying without a terminal

A run without a terminal can't sign you in, so it can't claim a new deployment.
It deploys the Workers, skips the claim and the first tenant, doesn't wait for
the new build to serve, and exits with the error above. A first deploy from CI
therefore always ends this way, and someone has to run `init` from a terminal
afterwards.

Once the deployment has an operator, a run without a terminal can create the
first tenant, if the deployment has none yet, from `--cache` and `--access`. It
refuses either option without the other, and exits with an error if the slug is
taken. When the deployment already has a tenant, `init` says that it didn't
apply `--cache`.

### Deploying again

Once a deployment has an operator, every later `init` needs the operator's
session, and checks it before it changes anything. It sends a request to the
deployment's current URL, and continues only if the deployment accepts the token
with full operator access.

`init` uses the session that `cupboard login <deployment URL>` cached. When
there's no usable session, or the session has expired and can't be renewed,
`init` signs you in as the operator, if it has a terminal. This sign-in always
goes through the operator's identity provider and never reuses the cached
Cloudflare sign-in, so you can complete it as the operator even when the cached
sign-in belongs to someone else. If you sign in as anyone else, `init` stops.
Without a terminal, `init` stops, says who the operator is, and prints the
`cupboard login` command to run. Nothing has changed at that point. From CI,
pass `--github-oidc` instead. See
[Upgrading from automation](./upgrading.md#upgrading-from-automation).

This check stops someone with the Cloudflare account's credentials from changing
the deployment through `init`. It doesn't stop them changing the Workers, their
secrets or D1 with other tools.

The current URL is the one that the last deploy recorded on the control Worker,
in its `CUPBOARD_DEPLOYMENT_URL` variable. A deployment from a release before
this record existed has none. `init` then uses the custom domain routed to the
control Worker, or the workers.dev URL, and records it. If a move failed between
the upload and the routing of a new domain, the record can contain a URL that
isn't routed to the control Worker. `init` then warns you and uses the routed
URL.

If the deployment can't be reached, answers with an error, or doesn't serve
cupboard at its URL, `init` can't check the token, so it stops before any change
and says why. For a Worker that answers with an error, fix it or roll it back,
for example with `wrangler rollback`, and deploy again. If the operator's
identity provider can't be reached, the error says that instead.

If the operator's own trust rule has been removed, the operator's session no
longer has full access, and `init` stops even after signing you in. See
[Restoring the first operator's rule](./operators.md#restoring-the-first-operators-rule).

### Changing the control database

`init` refuses a plan that selects a D1 database other than the one that the
deployed Workers use, when either database records an operator. Deploying such a
plan would either treat the deployment as new while a database records an
operator, or leave the operator in a database that the Workers no longer use.
The refusal happens before any change.

To keep the current database, select it in the plan. To move the deployment to
the other database, first change the control Worker's `CUPBOARD_DB` binding to
it in the Cloudflare dashboard, under the Worker's Settings, then Bindings, and
deploy that change there. Then run `init` again as the operator that the other
database records. When neither database records an operator, `init` treats the
deployment as new and uses the database in the plan.

### If the control Worker was deleted

The control Worker is what checks the operator's token. If it no longer exists
and a database records an operator, `init` stops before any change and says
which database that is. `init` can't recreate the control Worker of a claimed
deployment. Redeploy it with Wrangler from a checkout of the deployed release:

1. Run `pnpm install` at the root of the checkout, then `pnpm build-info` in
   `packages/server`. The Worker imports the build information that this
   generates, and a fresh checkout doesn't have it.
2. In `packages/server/wrangler.jsonc`, set these values to the deployment's
   own. The tenant Worker's settings in the Cloudflare dashboard list most of
   them:
   - `name`: the control Worker's script name;
   - the `CUPBOARD_DB` binding's `database_name` and `database_id`: the database
     from the error;
   - the `BLOBS` R2 bucket;
   - the `TENANT_CACHE` and `CRON_STATE` KV namespace IDs;
   - the `MAINTENANCE_QUEUE` producer, the queue consumer and its dead-letter
     queue;
   - the `CUPBOARD_TENANT` service and the `CUPBOARD_DO` `script_name`: the
     tenant Worker's script name;
   - under `vars`, `CUPBOARD_DEPLOYMENT_URL`: the deployment's URL, such as
     `https://cache.example.com`.
3. If the tenant Worker was deleted too, deploy it first. Set `name` and the
   `CUPBOARD_DB`, `BLOBS` and `MAINTENANCE_QUEUE` bindings in
   `packages/server/wrangler.tenant.jsonc` in the same way, then run
   `pnpm exec wrangler deploy -c wrangler.tenant.jsonc` in `packages/server`.
4. Run `pnpm exec wrangler deploy` in `packages/server`.
5. Restore the original `CONTROL_KEY_WRAP_SECRET` with
   `pnpm exec wrangler secret put CONTROL_KEY_WRAP_SECRET` in `packages/server`.
   The Worker's secrets were deleted with it, and only the original value can
   read the control database's signing keys. That's the value that the first
   deploy asked you to keep.
6. If the deployment served on a custom domain, route that domain to the Worker
   again.
7. Run `cupboard init` as the operator, with `--domain` set to the custom domain
   if there is one. `init` checks your token against the redeployed Worker and
   replaces the Worker with the release's own build.

## Workers plans

Cloudflare limits how many calls to D1, R2 and its other services a single
request can make. The limit is 1,000 calls on the Workers Free plan and 10,000
on the Paid plan. `init` looks up the account's plan on every deploy and sets up
cupboard to match. If it can't read the plan, it assumes Free and tells you so.

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

On a later deploy, `init` first reads the existing deployment. The plan starts
from the resources that the Workers are currently bound to and the control
Worker's current cron triggers, so accepting the plan keeps them. To rename a
resource or change the cron triggers, use the plan menu. There are no options
for these, so `--yes` always keeps the current ones.

To see the plan without signing in or changing anything, pass `--dry-run`.
Because a dry run doesn't sign in, it can't read the existing deployment, so it
shows the default names.

## Running `init` again

It's safe to run `init` again. It needs the operator's session, and at a
terminal it signs you in if it has to. See [Deploying again](#deploying-again).
It skips migrations that have already been applied, and only uploads the Workers
if they've changed. It keeps the custom domain, the tenants, and the existing
secrets, resource names and cron triggers. It does look up the
[Workers plan](#workers-plans) again each time.

Running `init` again with a newer CLI is how you upgrade. See
[Upgrading](./upgrading.md).

## Removing a deployment

There's no command to remove a deployment. To remove one:

1. Delete the resources listed in [What `init` creates](#what-init-creates), and
   any custom domain, in the Cloudflare dashboard.
2. Delete `~/.config/cupboard/` on every machine that signed in to the
   deployment.
