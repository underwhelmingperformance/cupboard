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
- A terminal, and a browser where you can sign in to Cloudflare. The Cloudflare
  identity that you sign in with becomes the deployment's operator.
- An R2 bucket and an R2 API token. The first step below shows how to create
  them.

If you're logged in to `wrangler` on this machine, pass `--no-wrangler` to
`init`. Otherwise `init` may use wrangler's stored token instead of signing you
in through the browser. That token doesn't include your identity, so the
deployment would end up with no operator.

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

4. Review the plan. `init` shows what it's going to create, and lets you change
   the account, custom domain, R2 bucket name, D1 database, queue names, cron
   triggers and operator before you confirm.

   On a first deploy, the plan also shows two newly generated secrets. Save
   `CONTROL_KEY_WRAP_SECRET` with your other secrets now. It isn't shown again.
   See [What to keep](#what-to-keep).

5. When `init` asks for R2 credentials, enter the access key ID and secret from
   step 2.

6. Wait while `init` deploys. It creates the resources, applies the database
   migrations, and uploads and configures both Workers. When it has finished, it
   makes you the operator and prints the identity that it used:

   ```
   You are now the admin of this deployment (<subject>).
   ```

7. Create the first tenant. `init` asks for:
   - a **slug**, the tenant's name in its URL. With the slug `acme`, the tenant
     URL is `https://cupboard.example.workers.dev/t/acme`. See
     [Tenant slugs](#tenant-slugs).
   - whether the tenant's default cache is public ("Anyone who learns the URL")
     or private ("Only clients with a read credential"). You can answer this in
     advance with `--access public` or `--access private`.

   You become the tenant's owner.

8. Save the tenant read credential. `init` prints it along with the netrc line
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

An API token doesn't include anyone's identity. If you first deploy with a
token, the deployment has no operator. To become the operator, unset
`CLOUDFLARE_API_TOKEN` and run `cupboard init` again in a terminal.

A deploy with a token leaves the control Worker's claim settings as they are. It
only sets a new claim secret if you supply `CUPBOARD_SIGNUP_SECRET`. This makes
API tokens a good fit for upgrading from automation once the deployment has an
operator. See
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

## Claiming the deployment

The first person to complete `init` interactively becomes the operator. At
first, they're the only person who can administer the deployment, until they
[add other operators](./operators.md#adding-operators). Once a deployment has
been claimed, nobody else can claim it.

Anyone with access to the Cloudflare account can run `init`. To stop someone
else claiming a new deployment before you do, set a claim secret in
`CUPBOARD_SIGNUP_SECRET` when you deploy. `init` then asks for the secret before
it lets anyone claim the deployment.

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

It's safe to run `init` again. It skips migrations that have already been
applied, and only uploads the Workers if they've changed. It keeps the custom
domain, the tenants, and the existing secrets, resource names and cron triggers.
It does look up the [Workers plan](#workers-plans) again each time.

Running `init` again with a newer CLI is how you upgrade. See
[Upgrading](./upgrading.md).

## Removing a deployment

There's no command to remove a deployment. To remove one:

1. Delete the resources listed in [What `init` creates](#what-init-creates), and
   any custom domain, in the Cloudflare dashboard.
2. Delete `~/.config/cupboard/` on every machine that signed in to the
   deployment.
